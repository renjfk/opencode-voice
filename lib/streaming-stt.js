// Local streaming dictation controller (STAGE 1).
//
// Rolling-window live transcription over a persistent local whisper-server.
// No cloud/LLM calls: snapshots of bounded rolling audio are transcribed as
// plain text hypotheses and folded into stable/tentative transcript state
// (see lib/streaming-transcript.js). Editor/command wiring is stage 2 - this
// module exposes a small documented controller/callback contract for it.
//
// Architecture (SoX capture is independent of recognition):
//
//   capture lane      - SoX streams PCM continuously into a bounded ring
//                       (windowMs + margin, oldest bytes discarded). Started
//                       BEFORE server readiness so initial speech is never
//                       dropped during cold start.
//   recognition lane  - a chained-setTimeout scheduler snapshots the newest
//                       rolling window on a fixed cadence and transcribes it.
//                       Exactly one request is ever in flight and at most one
//                       timer is ever pending: the next tick is armed at
//                       launch (due one cadence later, even while decoding),
//                       a tick firing while busy only sets a coalesce flag,
//                       and completion fires one immediate catch-up tick on
//                       the newest audio instead of queueing stale snapshots.
//
// Window geometry: windowMs=10000, cadenceMs=1000 means consecutive snapshots
// overlap by ~9s; only the newest ~1s of audio is new each tick. The
// "~1s overlap" from the plan is the per-tick advance, not the snapshot
// overlap - consecutive snapshots deliberately share most of their audio so
// no word is cut at a boundary, and the stability tracker dedupes the rest.
//
// Controller contract (for stage 2):
//   start()            -> true when a dictation session begins
//   stop()             -> Promise<{text}> final transcript (captures the SoX
//                         tail and transcribes it once more before commit)
//   cancel()           -> promptly drops the session; late in-flight
//                         responses are invalidated by generation and ignored
//   dispose()          -> cancel + teardown (server released, capture freed)
//   setModel({modelPath, language}) -> teardown + recreate transcriber; only
//                         when idle/errored, never mid-dictation
//   getState()         -> { status, stableText, tentativeText, inFlight,
//                         lastError, hasFallbackAudio, fallbackCoverage,
//                         coverage, model } (coverage = live capture
//                         retention; null for scripted captures)
//   getTranscript()    -> { stableText, tentativeText, text }
//   getFallbackAudio() -> WAV Buffer | null (for a later batch fallback;
//                         populated on stop/error paths, cleared on start)
//   getFallbackCoverage() -> { source, fromMs, toMs, totalMs, complete,
//                         droppedRanges, message } | null: exactly which audio
//                         the fallback WAV covers. `complete: false` means the
//                         spool cap was hit and the middle is explicitly
//                         listed as dropped - never a "full recording" claim.
//
// Callbacks: onPartial({stableText, tentativeText}), onFinal({text}),
// onStateChange(status), onError({code, message, hasFallbackAudio}).
//
// Statuses: idle | starting | streaming | stopping | cancelled | error.
// The whisper-server model stays loaded across start/stop cycles (the
// transcriber is created once); teardown happens on dispose() or setModel().
// A missing/unreachable server is an explicit error (codes from
// lib/whisper-server.js: SERVER_BINARY_MISSING, PORT_IN_USE, START_TIMEOUT,
// ...) - the controller never silently falls back to whisper-cli; the
// preserved fallback audio lets a later stage run the batch path instead.
//
// Bounded memory: the PCM ring is capped (oldest bytes discarded); a disk
// spool preserves contiguous audio from t=0 up to spoolMaxMs (bounded disk
// policy: single capped file per session, consumed+unlinked on stopFinal,
// unlinked on cancel/dispose, best-effort sweep of stale files on start);
// overflow past the cap is counted and reported via getCoverage/onOverflow,
// never silently dropped. At most one in-flight request plus one coalesce
// flag (no snapshot queue); the transcript grows only with spoken words
// (the output itself). No spawnSync anywhere in the capture/recognition hot
// path (async spawn + HTTP only; spool appends are async chained writes).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRecordArgs, detectAudioBackend } from "./stt.js";
import { wrapPcmAsWav } from "./audio-chunker.js";
import { createStabilityTracker } from "./streaming-transcript.js";
import { acquireSharedWhisperServer } from "./whisper-server.js";

export const STREAMING_DEFAULTS = {
  windowMs: 10000,
  cadenceMs: 1000,
  // Ring headroom beyond the window so a slow tick still snapshots windowMs.
  ringMarginMs: 3000,
  sampleRate: 16000,
  bytesPerSecond: 32000, // 16kHz mono 16-bit
  stopDrainTimeoutMs: 5000,
  soxExitTimeoutMs: 2000,
  // Grace for the SoX 'close' event after 'exit': 'exit' fires before stdio
  // is flushed, so the tail PCM is only guaranteed delivered at 'close'.
  closeGraceMs: 200,
  // Wall-clock bounds for stop (real timers, never the injectable manual
  // clock): how long stop waits for a stuck in-flight request before
  // aborting it, how long the final tail transcription may take, and how
  // long a cold-start stop waits for the startup sequence to settle.
  stopFinalTimeoutMs: 30000,
  stopReadyTimeoutMs: 20000,
  // Disk spool: every captured byte is appended from t=0 so audio the RAM
  // ring can no longer hold (cold start longer than the window, inference
  // slower than the window) is never silently dropped. Bounded: spooling
  // stops at spoolMaxMs and the overflow is counted + reported (see
  // getCoverage), never silently discarded.
  spoolMaxMs: 300000, // 5 minutes ~= 9.6 MB of 16kHz mono 16-bit PCM
  spoolFilePrefix: "opencode-voice-stream-",
  spoolStaleMs: 3600000, // best-effort sweep of abandoned spool files
};

// ---- Bounded rolling PCM ring (pure, shared by SoX capture and tests) ----

export function createRollingPcmBuffer({ capacityBytes }) {
  let chunks = [];
  let size = 0;

  function push(buf) {
    if (!buf || buf.length === 0) return;
    chunks.push(Buffer.from(buf));
    size += buf.length;
    while (size > capacityBytes && chunks.length > 0) {
      const head = chunks[0];
      const over = size - capacityBytes;
      if (head.length <= over) {
        chunks.shift();
        size -= head.length;
      } else {
        chunks[0] = head.subarray(over);
        size -= over;
      }
    }
  }

  function snapshotLast(nBytes) {
    const want = Math.min(nBytes, size);
    if (want <= 0) return Buffer.alloc(0);
    const out = Buffer.alloc(want);
    let pos = want;
    for (let i = chunks.length - 1; i >= 0 && pos > 0; i--) {
      const take = Math.min(chunks[i].length, pos);
      pos -= take;
      chunks[i].copy(out, pos, chunks[i].length - take);
    }
    return out;
  }

  function drainAll() {
    const out = Buffer.concat(chunks, size);
    chunks = [];
    size = 0;
    return out;
  }

  return {
    push,
    snapshotLast,
    drainAll,
    size: () => size,
    capacity: () => capacityBytes,
  };
}

// ---- Default SoX rolling capture (async spawn only, no spawnSync) ----

export function createSoxRollingCapture({
  mic = null,
  backend = detectAudioBackend(),
  sampleRate = STREAMING_DEFAULTS.sampleRate,
  windowMs = STREAMING_DEFAULTS.windowMs,
  ringMarginMs = STREAMING_DEFAULTS.ringMarginMs,
  spoolMaxMs = STREAMING_DEFAULTS.spoolMaxMs,
  spoolDir = os.tmpdir(),
  logger = null,
  spawnFn = spawn,
  onOverflow = null,
  // onError({code, message, ...}): async process failures - spawn 'error'
  // events (e.g. ENOENT) and unexpected exits. Sync spawn throws still throw
  // (the controller maps them to CAPTURE_FAILED). Expected exits (code 0 or
  // our own SIGINT/SIGKILL/SIGTERM from stopFinal/cancel) never fire it.
  onError = null,
} = {}) {
  const capacityBytes = Math.ceil(
    ((windowMs + ringMarginMs) / 1000) * STREAMING_DEFAULTS.bytesPerSecond,
  );
  const spoolMaxBytes = Math.ceil((spoolMaxMs / 1000) * STREAMING_DEFAULTS.bytesPerSecond);
  let ring = createRollingPcmBuffer({ capacityBytes });
  let proc = null;
  let startedAtMs = 0;
  // Absolute sample-offset accounting: total PCM bytes ever pushed, plus a
  // per-snapshot sequence number. Snapshots report which absolute audio
  // range they cover so callers (and fallback-audio coverage text) can tell
  // retained audio from dropped audio instead of claiming "full recording".
  let totalPushedBytes = 0;
  let snapshotSeq = 0;
  // Disk spool: contiguous audio from t=0, bounded by spoolMaxBytes.
  // Overflow is counted (droppedBytes) and reported via onOverflow +
  // getCoverage - audio is never silently discarded.
  let spoolPath = null;
  let spoolChain = Promise.resolve();
  let spooledBytes = 0;
  let droppedBytes = 0;
  let spoolTruncated = false;
  let overflowNotified = false;
  let spoolConsumed = false;
  let closeGraceTimer = null;
  // Last process failure (async spawn error / unexpected exit). Never
  // silent: delivered via onError AND retained here for getLastError().
  let captureError = null;
  let lastExit = null;

  // Best-effort sweep of spool files abandoned by crashed sessions. Never
  // blocks start and never throws: a dirty tmpdir must not break capture.
  function sweepStaleSpools() {
    const prefix = STREAMING_DEFAULTS.spoolFilePrefix;
    fs.promises
      .readdir(spoolDir)
      .then((names) => {
        const now = Date.now();
        return Promise.all(
          names
            .filter((n) => n.startsWith(prefix))
            .map(async (n) => {
              const p = path.join(spoolDir, n);
              if (p === spoolPath) return;
              try {
                const st = await fs.promises.stat(p);
                if (now - st.mtimeMs > STREAMING_DEFAULTS.spoolStaleMs) {
                  await fs.promises.unlink(p);
                }
              } catch {}
            }),
        );
      })
      .catch(() => {});
  }

  function reportCaptureError(err) {
    captureError = err;
    try {
      onError?.(err);
    } catch {}
  }

  function unlinkSpool() {
    if (!spoolPath) return Promise.resolve();
    const p = spoolPath;
    spoolPath = null;
    return fs.promises.unlink(p).catch(() => {});
  }

  function spoolAppend(buf) {
    if (spoolConsumed) return;
    if (!spoolPath) {
      const name = `${STREAMING_DEFAULTS.spoolFilePrefix}${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.pcm`;
      spoolPath = path.join(spoolDir, name);
    }
    const target = spoolPath;
    if (spoolTruncated) {
      droppedBytes += buf.length;
      return;
    }
    if (spooledBytes + buf.length > spoolMaxBytes) {
      spoolTruncated = true;
      droppedBytes += buf.length;
      if (!overflowNotified) {
        overflowNotified = true;
        const droppedMs = (droppedBytes / STREAMING_DEFAULTS.bytesPerSecond) * 1000;
        try {
          onOverflow?.({
            code: "AUDIO_SPOOL_OVERFLOW",
            message:
              `Audio spool reached its ${spoolMaxMs}ms cap; ` +
              `retaining the first ${((spooledBytes / STREAMING_DEFAULTS.bytesPerSecond) * 1000).toFixed(0)}ms plus the rolling window, ` +
              `dropping the middle (${droppedMs.toFixed(0)}ms so far)`,
            recoverable: true,
            spooledMs: (spooledBytes / STREAMING_DEFAULTS.bytesPerSecond) * 1000,
            droppedMs,
          });
        } catch {}
      }
      return;
    }
    spooledBytes += buf.length;
    const chunk = Buffer.from(buf);
    spoolChain = spoolChain.then(() => fs.promises.appendFile(target, chunk)).catch(() => {});
  }

  function flushSpool() {
    return spoolChain;
  }

  // Pause: SIGSTOP freezes the mic so paused spans never enter the ring
  // (and the first post-resume snapshot re-reads pre-pause audio the
  // overlap tracker already absorbed). Best-effort: missing/dead proc
  // reports false, never throws.
  function pauseCapture() {
    if (!proc) return false;
    try {
      proc.kill("SIGSTOP");
      return true;
    } catch {
      return false;
    }
  }

  function resumeCapture() {
    if (!proc) return false;
    try {
      proc.kill("SIGCONT");
      return true;
    } catch {
      return false;
    }
  }

  // Honest coverage of retained audio. The spool holds a contiguous prefix
  // from t=0; the RAM ring holds the trailing window. With no overflow the
  // session is fully retained; with overflow the middle is explicitly listed
  // as dropped - never presented as a complete recording.
  function getCoverage() {
    const totalMs = (totalPushedBytes / STREAMING_DEFAULTS.bytesPerSecond) * 1000;
    const spooledMs = (spooledBytes / STREAMING_DEFAULTS.bytesPerSecond) * 1000;
    const ringMs = (ring.size() / STREAMING_DEFAULTS.bytesPerSecond) * 1000;
    const ringStartMs = Math.max(0, totalMs - ringMs);
    if (!spoolTruncated) {
      return {
        source: "spool",
        fromMs: 0,
        toMs: totalMs,
        totalMs,
        complete: true,
        droppedRanges: [],
        message: `complete recording 0.0-${totalMs.toFixed(1)}s`,
      };
    }
    const droppedRanges = ringStartMs > spooledMs ? [{ fromMs: spooledMs, toMs: ringStartMs }] : [];
    const retainedRanges = [{ fromMs: 0, toMs: spooledMs }];
    if (ring.size() > 0) retainedRanges.push({ fromMs: ringStartMs, toMs: totalMs });
    return {
      source: "spool-head-plus-ring-tail",
      fromMs: 0,
      toMs: totalMs,
      totalMs,
      complete: false,
      retainedRanges,
      droppedRanges,
      message:
        `spool cap ${spoolMaxMs}ms hit: fallback holds 0.0-${spooledMs.toFixed(1)}s, ` +
        `rolling window holds ${ringStartMs.toFixed(1)}-${totalMs.toFixed(1)}s` +
        (droppedRanges.length > 0
          ? `; missing ${spooledMs.toFixed(1)}-${ringStartMs.toFixed(1)}s`
          : `; no single buffer holds the full ${totalMs.toFixed(1)}s`) +
        `; NOT a complete recording`,
    };
  }

  function start() {
    if (proc) return;
    // A previous session's spool was never collected (restart without
    // stopFinal/cancel): drop it promptly - a fresh start is a new t=0, and
    // abandoned files must not accumulate beyond the stale sweep. Chained
    // AFTER in-flight appends so a racing write cannot resurrect the file.
    if (spoolPath) {
      const abandoned = spoolPath;
      spoolPath = null;
      spoolChain = spoolChain
        .then(() => fs.promises.unlink(abandoned).catch(() => {}))
        .catch(() => {});
    }
    ring = createRollingPcmBuffer({ capacityBytes });
    totalPushedBytes = 0;
    snapshotSeq = 0;
    spoolPath = null;
    spoolChain = Promise.resolve();
    spooledBytes = 0;
    droppedBytes = 0;
    spoolTruncated = false;
    overflowNotified = false;
    spoolConsumed = false;
    captureError = null;
    lastExit = null;
    if (closeGraceTimer) {
      clearTimeout(closeGraceTimer);
      closeGraceTimer = null;
    }
    sweepStaleSpools();
    const inputArgs = buildRecordArgs(backend, mic);
    logger?.log("STT", `Streaming capture starting backend=${backend}`, "debug");
    try {
      proc = spawnFn(
        "sox",
        [...inputArgs, "-r", String(sampleRate), "-c", "1", "-b", "16", "-t", "raw", "-"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      // Sync spawn failure (e.g. ENOENT thrown synchronously): record for
      // getLastError() AND throw so the controller maps it to CAPTURE_FAILED.
      captureError = {
        code: err?.code === "ENOENT" ? "CAPTURE_SPAWN_ENOENT" : "CAPTURE_SPAWN_FAILED",
        message: `Failed to spawn sox: ${err?.message || String(err)}`,
        recoverable: true,
      };
      proc = null;
      throw err;
    }
    startedAtMs = Date.now();
    proc.stdout?.on("data", (buf) => {
      totalPushedBytes += buf.length;
      ring.push(buf);
      spoolAppend(buf);
    });
    proc.stderr?.on("data", () => {});
    // Owned-process guards: handlers from a previous start() must never
    // null a restarted session's proc. 'close' (stdio flushed) releases the
    // handle; 'exit' alone only arms a grace fallback - the stop tail must
    // wait for drained stdout, not merely exit.
    const owned = proc;
    proc.on("error", (err) => {
      if (proc !== owned) return;
      if (closeGraceTimer) {
        clearTimeout(closeGraceTimer);
        closeGraceTimer = null;
      }
      proc = null;
      // Async spawn failure (e.g. ENOENT delivered as an event): explicit
      // and recoverable, with whatever audio was captured so far retained.
      reportCaptureError({
        code: err?.code === "ENOENT" ? "CAPTURE_SPAWN_ENOENT" : "CAPTURE_SPAWN_ERROR",
        message: `SoX process error: ${err?.message || String(err)}`,
        recoverable: true,
      });
    });
    proc.on("exit", (code, signal) => {
      if (proc !== owned) return;
      lastExit = { code: code ?? null, signal: signal ?? null };
      const expected = code === 0 || (signal && ["SIGINT", "SIGKILL", "SIGTERM"].includes(signal));
      if (!expected) {
        // Unexpected exit (crash, external kill): explicit error. Audio
        // captured so far stays in ring+spool; stdout arriving between exit
        // and close is still drained (data handler is independent of proc).
        reportCaptureError({
          code: "CAPTURE_EXITED",
          message: `SoX exited unexpectedly (code=${lastExit.code} signal=${lastExit.signal}); audio retained for fallback`,
          recoverable: true,
          exit: { ...lastExit },
        });
      }
      if (closeGraceTimer) clearTimeout(closeGraceTimer);
      closeGraceTimer = setTimeout(() => {
        closeGraceTimer = null;
        if (proc === owned) proc = null;
      }, STREAMING_DEFAULTS.closeGraceMs);
      closeGraceTimer.unref?.();
    });
    proc.on("close", () => {
      if (closeGraceTimer) {
        clearTimeout(closeGraceTimer);
        closeGraceTimer = null;
      }
      if (proc === owned) proc = null;
    });
  }

  // Cheap tail read for live level meters: copies only the requested bytes
  // (no WAV wrap, no snapshot sequence bookkeeping). Returns empty when the
  // capture has no audio yet.
  function peekTail(nBytes = 2048) {
    const want = Math.max(0, Math.min(Math.floor(Number(nBytes) || 0), capacityBytes));
    if (want === 0) return null;
    const pcm = ring.snapshotLast(want);
    return pcm.length > 0 ? pcm : null;
  }

  function snapshot() {
    const pcm = ring.snapshotLast(Math.ceil((windowMs / 1000) * STREAMING_DEFAULTS.bytesPerSecond));
    if (pcm.length === 0) return null;
    const absoluteEndMs = (totalPushedBytes / STREAMING_DEFAULTS.bytesPerSecond) * 1000;
    const absoluteStartMs = absoluteEndMs - (pcm.length / STREAMING_DEFAULTS.bytesPerSecond) * 1000;
    snapshotSeq += 1;
    return {
      wav: wrapPcmAsWav(pcm, { sampleRate }),
      durationMs: Date.now() - startedAtMs,
      absoluteStartMs,
      absoluteEndMs,
      seq: snapshotSeq,
    };
  }

  function waitForExit(timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        if (!proc || Date.now() - start >= timeoutMs) {
          if (proc) {
            try {
              proc.kill("SIGKILL");
            } catch {}
            proc = null;
          }
          resolve();
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  // Stop capture and return retained audio for the stop-tail transcription
  // and batch fallback. The fallback prefers the disk spool: contiguous
  // audio from t=0 (covers cold-start speech the RAM ring aged out), with a
  // coverage descriptor that says exactly what is retained. Bounded: SIGINT,
  // then SIGKILL after soxExitTimeoutMs. Consumes the spool file (cleanup).
  async function stopFinal({ soxExitTimeoutMs = STREAMING_DEFAULTS.soxExitTimeoutMs } = {}) {
    // A SIGSTOPped sox ignores SIGINT: always continue first so teardown
    // can never hang on a paused mic.
    resumeCapture();
    if (proc) {
      try {
        proc.kill("SIGINT");
      } catch {}
      await waitForExit(soxExitTimeoutMs);
    }
    await spoolChain;
    const coverage = getCoverage();
    let wav = null;
    let wavFromMs = null;
    let wavToMs = null;
    if (spoolPath && !spoolConsumed && spooledBytes > 0) {
      const target = spoolPath;
      try {
        const spoolPcm = await fs.promises.readFile(target);
        if (spoolPcm.length > 0) {
          wav = wrapPcmAsWav(spoolPcm, { sampleRate });
          wavFromMs = 0;
          wavToMs = (spoolPcm.length / STREAMING_DEFAULTS.bytesPerSecond) * 1000;
        }
      } catch {}
      spoolConsumed = true;
      await unlinkSpool();
    }
    if (!wav) {
      const snap = snapshot();
      wav = snap?.wav || null;
      wavFromMs = snap?.absoluteStartMs ?? null;
      wavToMs = snap?.absoluteEndMs ?? null;
      coverage.source = "ring-tail";
    }
    return {
      wav,
      durationMs: Date.now() - startedAtMs,
      absoluteStartMs: wavFromMs,
      absoluteEndMs: wavToMs,
      seq: snapshotSeq,
      coverage,
    };
  }

  async function cancel() {
    // SIGKILL terminates even a stopped process, but continuing first lets
    // stdio flush and the close handler release the handle cleanly.
    resumeCapture();
    if (proc) {
      const owned = proc;
      proc = null;
      try {
        owned.kill("SIGKILL");
      } catch {}
    }
    await spoolChain;
    spoolConsumed = true;
    await unlinkSpool();
    ring = createRollingPcmBuffer({ capacityBytes });
  }

  function dispose() {
    return cancel();
  }

  function isAlive() {
    return proc !== null;
  }

  function getLastError() {
    return captureError;
  }

  function getLastExit() {
    return lastExit;
  }

  return {
    start,
    snapshot,
    peekTail,
    pause: pauseCapture,
    resume: resumeCapture,
    stopFinal,
    cancel,
    dispose,
    getCoverage,
    flushSpool,
    isAlive,
    getLastError,
    getLastExit,
  };
}

// ---- Default server transcriber (persistent whisper-server, no fallback) ----

export function createServerTranscriber({
  modelPath,
  language,
  host,
  port,
  logger = null,
  serverFactory = acquireSharedWhisperServer,
  // Default tick format is plain "json" (~0.9s per 10s window): the
  // stability tracker is text-anchored and never reads segments, so the
  // verbose payload only adds latency. Pass "verbose_json" explicitly to
  // opt into segments; old builds that reject it still downgrade to "json".
  responseFormat: preferredFormat = "json",
} = {}) {
  let held = null;
  let responseFormat = preferredFormat === "verbose_json" ? "verbose_json" : "json";
  // "json" needs no probing (single attempt). "verbose_json" probes once:
  // on rejection it retries as plain json and stays there.
  let formatProbed = responseFormat === "json";

  function handle() {
    if (!held) held = serverFactory({ modelPath, language, host, port, logger });
    return held.client;
  }

  async function ensureReady() {
    const client = handle();
    const ready = await client.start();
    if (ready) return { ready: true };
    const err = client.getLastError() || { code: "NOT_READY", message: "whisper-server not ready" };
    return { ready: false, error: err };
  }

  async function transcribe(wavBuffer, opts = {}) {
    const client = handle();
    // An explicit per-call format wins for this call only (tests + callers
    // that need segments); otherwise the session default applies.
    const callFormat = opts.responseFormat === "verbose_json" ? "verbose_json" : null;
    const effective = callFormat || responseFormat;
    let result = await client.transcribeBuffer(wavBuffer, {
      responseFormat: effective,
      signal: opts.signal,
    });
    // Old builds may reject verbose_json: retry once as plain json and stay
    // there. The stability logic is text-anchored either way (segments are
    // snapshot-relative hints, never cross-window truth).
    if (result.error && !formatProbed && effective === "verbose_json") {
      formatProbed = true;
      responseFormat = "json";
      result = await client.transcribeBuffer(wavBuffer, { responseFormat, signal: opts.signal });
    } else {
      formatProbed = true;
    }
    return result;
  }

  function dispose() {
    held?.release();
    held = null;
  }

  return {
    ensureReady,
    transcribe,
    dispose,
    getResponseFormat: () => responseFormat,
    // boundPort is the auto-scan claim (8090, 8091, ...) once the server is
    // up; port is the requested port (undefined = default scan path).
    describe: () => ({
      modelPath,
      language,
      port,
      boundPort: held?.client?.getPort?.() ?? null,
      responseFormat,
    }),
  };
}

// ---- Streaming controller ----

export function createStreamingController({
  captureFactory = (opts = {}) => createSoxRollingCapture({ windowMs, ...opts }),
  transcriberFactory = (spec) => createServerTranscriber({ ...spec }),
  trackerFactory = () => createStabilityTracker(),
  clock = { setTimeout, clearTimeout },
  windowMs = STREAMING_DEFAULTS.windowMs,
  cadenceMs = STREAMING_DEFAULTS.cadenceMs,
  stopDrainTimeoutMs = STREAMING_DEFAULTS.stopDrainTimeoutMs,
  stopFinalTimeoutMs = STREAMING_DEFAULTS.stopFinalTimeoutMs,
  stopReadyTimeoutMs = STREAMING_DEFAULTS.stopReadyTimeoutMs,
  model = null,
  logger = null,
  onPartial = null,
  onFinal = null,
  onStateChange = null,
  onError = null,
  onOverflow = null,
} = {}) {
  let capture = null;
  let transcriber = null;
  let tracker = trackerFactory();
  let status = "idle";
  let timer = null;
  let inFlight = false;
  let inFlightPromise = null;
  // Ownership fencing: every async continuation re-checks `generation`
  // after each await, and every inference request carries the AbortSignal of
  // its own generation. A stale continuation must NEVER touch shared state
  // (inFlight flags, transcript, timers, statuses, callbacks) - it returns
  // without effect so a new session's request cannot be clobbered.
  let activeReqController = null;
  let startupPromise = null;
  let stopPromise = null;
  let coalesced = false;
  let finalizing = false;
  let generation = 0;
  // Dictation pause: ticks are skipped (no inference cost) and the mic is
  // SIGSTOPped so paused spans never enter the ring. The tracker needs no
  // changes: the first post-resume snapshot re-reads pre-pause audio it
  // already absorbed, so overlap-join dedupes it.
  let paused = false;
  let lastError = null;
  let fallbackAudio = null;
  let fallbackCoverage = null;
  let pendingModel = model ? { ...model } : null;

  function setStatus(next) {
    status = next;
    try {
      onStateChange?.(next);
    } catch {}
  }

  function emitPartial() {
    const s = tracker.getState();
    try {
      onPartial?.({ stableText: s.stableText, tentativeText: s.tentativeText });
    } catch {}
  }

  function currentTranscript() {
    const s = tracker.getState();
    return {
      stableText: s.stableText,
      tentativeText: s.tentativeText,
      text: `${s.stableText} ${s.tentativeText}`.trim(),
    };
  }

  // Coverage for a fallback WAV when the capture reported none (scripted or
  // legacy captures): approximate from the tail offsets, marked explicitly
  // unverified - a fallback MUST never look complete without evidence.
  function coverageForTail(fin) {
    if (!fin?.wav) return null;
    const toMs = fin.absoluteEndMs ?? fin.durationMs ?? 0;
    const fromMs = fin.absoluteStartMs ?? 0;
    return {
      source: "capture-tail-unverified",
      fromMs,
      toMs,
      totalMs: toMs,
      complete: false,
      retainedRanges: [{ fromMs, toMs }],
      droppedRanges: [],
      message:
        `capture reported no coverage; fallback holds ~${fromMs.toFixed(1)}-${toMs.toFixed(1)}ms; ` +
        `completeness NOT verified`,
    };
  }

  function storeFallback(fin) {
    fallbackAudio = fin?.wav || null;
    fallbackCoverage = fin?.coverage || coverageForTail(fin);
  }

  function schedule(delayMs) {
    clearTimer();
    timer = clock.setTimeout(() => {
      timer = null;
      void tick();
    }, delayMs);
  }

  function clearTimer() {
    if (timer !== null && timer !== undefined) {
      try {
        clock.clearTimeout(timer);
      } catch {}
      timer = null;
    }
  }

  function describeTranscriber() {
    try {
      return transcriber?.describe?.() || null;
    } catch {
      return null;
    }
  }

  // Actual whisper-server port for the warm-lease identity (stt.js keys the
  // parked lease per model/language/port). Null until the server is up.
  function getServerPort() {
    try {
      const d = describeTranscriber();
      return d?.boundPort ?? d?.port ?? null;
    } catch {
      return null;
    }
  }

  function abortActiveRequest() {
    const controller = activeReqController;
    activeReqController = null;
    if (controller) {
      try {
        controller.abort();
      } catch {}
    }
  }

  // Wall-clock timeout that never holds the event loop open: callers must
  // cancel() it once their race settles so `--test` and short-lived CLIs
  // don't wait out the full bound.
  function wallTimeout(ms, value) {
    let timer = null;
    const promise = new Promise((resolve) => {
      timer = setTimeout(() => {
        timer = null;
        resolve(value);
      }, ms);
      timer.unref?.();
    });
    return {
      promise,
      cancel() {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
    };
  }

  // Settle the in-flight request within a wall-clock bound: await it, and on
  // timeout abort its signal and proceed WITHOUT waiting further. A
  // transcriber that ignores the abort settles whenever it settles; the
  // generation/promise-identity guards in tick() drop its result, so the
  // final transcription still never runs concurrently at the controller
  // level. Never throws, never hangs.
  async function settleInFlight(timeoutMs) {
    const pending = inFlightPromise;
    if (!pending) return;
    const timeout = wallTimeout(timeoutMs, false);
    const settled = await Promise.race([
      pending.then(
        () => true,
        () => true,
      ),
      timeout.promise,
    ]);
    timeout.cancel();
    if (!settled) abortActiveRequest();
  }

  async function tick() {
    if (status !== "streaming" || finalizing) return;
    if (paused) {
      // Mic frozen, nothing new to transcribe: keep the cadence timer alive
      // for an instant resume, with zero inference cost while paused.
      schedule(cadenceMs);
      return;
    }
    if (inFlight) {
      // Exactly one in-flight request: coalesce to the newest audio instead
      // of queueing a stale snapshot behind the slow one.
      coalesced = true;
      return;
    }
    const snap = capture?.snapshot?.();
    if (!snap || !snap.wav || snap.wav.length === 0) {
      schedule(cadenceMs); // no audio yet (cold start): keep polling
      return;
    }
    const myGen = generation;
    const reqController = new AbortController();
    activeReqController = reqController;
    inFlight = true;
    const myPromise = (async () => {
      try {
        return await transcriber.transcribe(snap.wav, { signal: reqController.signal });
      } catch (err) {
        return { error: err?.message || String(err), code: "TRANSCRIBE_THROW" };
      }
    })();
    inFlightPromise = myPromise;
    // Cadence continues DURING inference: the next tick is due one cadence
    // after this launch regardless of decode duration. A tick that fires
    // while busy only sets the coalesce flag (no snapshot queue, no
    // backlog); completion then fires one immediate catch-up tick on the
    // newest audio. At most one timer is ever pending.
    schedule(cadenceMs);
    const result = await myPromise;
    // Stale (cancelled/disposed/restarted while awaiting): touch NOTHING.
    // Clearing inFlight here would clobber the new session's request and
    // permit two overlapping physical inferences.
    if (myGen !== generation || inFlightPromise !== myPromise) return;
    inFlight = false;
    inFlightPromise = null;
    if (activeReqController === reqController) activeReqController = null;
    if (finalizing || status !== "streaming") return; // stopped while awaiting
    if (result.error) {
      await handleTranscribeError(result, myGen);
      return;
    }
    const text = (result.text || "").trim();
    if (text) {
      tracker.update(text, {
        absoluteStartMs: snap.absoluteStartMs ?? null,
        absoluteEndMs: snap.absoluteEndMs ?? null,
        seq: snap.seq ?? null,
      });
      emitPartial();
    }
    if (coalesced) {
      coalesced = false;
      schedule(0); // ticks arrived during decode: one catch-up on newest audio
    }
    // Otherwise the cadence timer armed at launch is still pending: the next
    // tick fires exactly one cadence after the last launch, not one cadence
    // after this decode.
  }

  async function handleTranscribeError(result, myGen) {
    // Explicit failure: stop scheduling, preserve what capture has for a
    // later batch fallback. Never silently switch to whisper-cli here.
    // Generation-guarded after the await: a cancel/restart that landed
    // during stopFinal must win over this stale error path.
    clearTimer();
    lastError = { code: result.code || "TRANSCRIBE_FAILED", message: result.error };
    try {
      const fin = await capture?.stopFinal?.();
      if (myGen !== generation) return;
      storeFallback(fin);
    } catch {
      if (myGen !== generation) return;
      fallbackAudio = null;
      fallbackCoverage = null;
    }
    if (myGen !== generation) return;
    setStatus("error");
    try {
      onError?.({
        ...lastError,
        hasFallbackAudio: fallbackAudio !== null,
        fallbackCoverage,
      });
    } catch {}
  }

  // Capture-process failure (async spawn error / unexpected exit): stop the
  // scheduler with an explicit error and retained transcript/audio - never
  // stream forever on a dead mic. During "starting" only records: the
  // startup continuation converts a dead capture into its failure path.
  // During stop/cancel/dispose the owner of that transition wins instead.
  function handleCaptureError(err) {
    const myGen = generation;
    if (status !== "streaming" && status !== "starting") return;
    if (status === "starting") {
      lastError = {
        code: err?.code || "CAPTURE_FAILED",
        message: err?.message || String(err),
        recoverable: true,
      };
      return;
    }
    void (async () => {
      clearTimer();
      lastError = {
        code: err?.code || "CAPTURE_FAILED",
        message: err?.message || String(err),
        recoverable: true,
      };
      try {
        const fin = await capture?.stopFinal?.();
        if (myGen !== generation) return;
        storeFallback(fin);
      } catch {
        if (myGen !== generation) return;
        fallbackAudio = null;
        fallbackCoverage = null;
      }
      if (myGen !== generation) return;
      if (status !== "streaming") return;
      setStatus("error");
      try {
        onError?.({
          ...lastError,
          hasFallbackAudio: fallbackAudio !== null,
          fallbackCoverage,
        });
      } catch {}
    })();
  }

  function start() {
    if (status === "streaming" || status === "starting" || status === "stopping") return false;
    generation += 1; // invalidate any ancient late responses
    paused = false; // a parked-then-reused lease never resumes paused
    abortActiveRequest(); // defensive: no lingering signal from a dead session
    stopPromise = null;
    tracker = trackerFactory();
    lastError = null;
    fallbackAudio = null;
    fallbackCoverage = null;
    coalesced = false;
    finalizing = false;
    if (!capture) {
      capture = captureFactory({
        onError: (err) => handleCaptureError(err),
        onOverflow: (info) => {
          try {
            onOverflow?.(info);
          } catch {}
        },
      });
    }
    if (!transcriber) {
      transcriber = transcriberFactory(pendingModel ? { ...pendingModel } : {});
      model = describeTranscriber() || pendingModel;
    }
    setStatus("starting");
    // Capture FIRST so nothing spoken during model cold start is lost; the
    // recognition ticks only begin after ensureReady resolves.
    try {
      capture.start();
    } catch (err) {
      lastError = { code: "CAPTURE_FAILED", message: err?.message || String(err) };
      setStatus("error");
      try {
        onError?.({ ...lastError, hasFallbackAudio: false });
      } catch {}
      return true;
    }
    void (startupPromise = (async () => {
      const myGen = generation;
      let ready;
      try {
        ready = await transcriber.ensureReady();
      } catch (err) {
        ready = { ready: false, error: { code: "ENSURE_READY_THROW", message: err?.message } };
      }
      if (myGen !== generation) return; // cancelled/stopped/restarted during startup
      // The mic died while the model loaded (capture error already
      // recorded): never enter streaming on a dead capture.
      if (capture?.isAlive?.() === false) {
        const captureErr = capture?.getLastError?.() || lastError;
        ready = {
          ready: false,
          error: captureErr || { code: "CAPTURE_FAILED", message: "capture died during startup" },
        };
      }
      if (!ready?.ready) {
        // Model never loaded, but capture has the audio since t=0: keep it
        // for a later batch fallback.
        try {
          const fin = await capture?.stopFinal?.();
          if (myGen !== generation) return; // lost the race during teardown
          storeFallback(fin);
        } catch {
          if (myGen !== generation) return;
          fallbackAudio = null;
          fallbackCoverage = null;
        }
        if (myGen !== generation) return;
        lastError = ready?.error || { code: "NOT_READY", message: "whisper-server not ready" };
        setStatus("error");
        try {
          onError?.({
            ...lastError,
            hasFallbackAudio: fallbackAudio !== null,
            fallbackCoverage,
          });
        } catch {}
        return;
      }
      if (myGen !== generation || status !== "starting") return;
      setStatus("streaming");
      schedule(0); // first snapshot covers audio buffered since t=0
    })());
    return true;
  }

  // Stop: freeze the transcript and report it. Ordering guarantees:
  //   1. The mic stops FIRST (no extra speech captured after stop) while a
  //      stuck in-flight request is settled within stopDrainTimeoutMs, then
  //      aborted - the final transcription never runs concurrently with a
  //      stale request (one-in-flight holds through finalization).
  //   2. The final transcription is bounded by stopFinalTimeoutMs.
  //   3. A cold-start stop (status "starting") awaits the startup sequence
  //      within stopReadyTimeoutMs, else returns an explicit recoverable
  //      failure - never a silent empty success.
  //   4. Concurrent stop calls share one finalization promise.
  // Every await is followed by a generation/status guard: a cancel/dispose
  // that lands mid-stop owns the outcome, and stop resolves quietly without
  // onPartial/onFinal/state changes.
  async function stop() {
    if (status === "idle" || status === "cancelled") return currentTranscript();
    if (stopPromise) return stopPromise;
    paused = false;
    const stoppingFrom = status;
    const myGen = generation;
    setStatus("stopping");
    clearTimer();
    finalizing = true;
    stopPromise = (async () => {
      try {
        if (stoppingFrom === "starting") return await stopFromStarting(myGen);
        return await stopFromActive(myGen, stoppingFrom);
      } finally {
        finalizing = false;
      }
    })();
    const result = await stopPromise;
    stopPromise = null;
    return result;
  }

  async function stopFromActive(myGen, stoppingFrom, cachedFin = undefined) {
    // Mic first, drain concurrently: stopFinal kills SoX promptly while the
    // old request settles (bounded, then aborted). A cold-start stop passes
    // its already-obtained tail so the spool fallback is never replaced by
    // a second stopFinal's ring tail.
    const finPromise =
      cachedFin !== undefined
        ? Promise.resolve(cachedFin)
        : (async () => {
            try {
              return await capture?.stopFinal?.();
            } catch {
              return null;
            }
          })();
    await settleInFlight(stopDrainTimeoutMs);
    if (myGen !== generation || status !== "stopping") return currentTranscript();
    const fin = await finPromise;
    if (myGen !== generation || status !== "stopping") return currentTranscript();
    storeFallback(fin);
    if (stoppingFrom !== "error" && fin?.wav) {
      const finalController = new AbortController();
      activeReqController = finalController;
      let result;
      const finalTimeout = wallTimeout(stopFinalTimeoutMs, {
        error: `final transcription timed out after ${stopFinalTimeoutMs}ms`,
        code: "STOP_FINAL_TIMEOUT",
      });
      try {
        result = await Promise.race([
          transcriber?.transcribe(fin.wav, { signal: finalController.signal }),
          finalTimeout.promise,
        ]);
      } catch (err) {
        result = { error: err?.message || String(err), code: "TRANSCRIBE_THROW" };
      }
      finalTimeout.cancel();
      if (activeReqController === finalController) activeReqController = null;
      if (result?.code === "STOP_FINAL_TIMEOUT") {
        try {
          finalController.abort();
        } catch {}
      }
      if (myGen !== generation || status !== "stopping") return currentTranscript();
      if (result && !result.error && (result.text || "").trim()) {
        tracker.update(result.text.trim(), {
          absoluteStartMs: fin?.absoluteStartMs ?? null,
          absoluteEndMs: fin?.absoluteEndMs ?? null,
          seq: fin?.seq ?? null,
          final: true,
        });
        emitPartial();
      }
    }
    tracker.commitTail();
    if (myGen !== generation || status !== "stopping") return currentTranscript();
    const done = currentTranscript();
    try {
      onFinal?.({ text: done.text });
    } catch {}
    inFlight = false;
    inFlightPromise = null;
    coalesced = false;
    setStatus("idle"); // server stays loaded for the next dictation
    return done;
  }

  async function stopFromStarting(myGen) {
    // Cold-start stop: capture holds speech since t=0 but the model may
    // never have become ready. Stop the mic promptly, then await the
    // startup sequence within a bound.
    let fin = null;
    try {
      fin = await capture?.stopFinal?.();
    } catch {
      fin = null;
    }
    if (myGen !== generation || status !== "stopping") return currentTranscript();
    storeFallback(fin);
    let startupSettled = false;
    if (startupPromise) {
      const readyTimeout = wallTimeout(stopReadyTimeoutMs, false);
      await Promise.race([
        startupPromise.then(
          () => {
            startupSettled = true;
          },
          () => {
            startupSettled = true;
          },
        ),
        readyTimeout.promise,
      ]);
      readyTimeout.cancel();
    } else {
      startupSettled = true;
    }
    if (myGen !== generation || status !== "stopping") return currentTranscript();
    if (!startupSettled) {
      // Model never became ready: explicit recoverable failure with the
      // t=0 audio preserved - never a silent empty success.
      lastError = {
        code: "STOP_NOT_READY",
        message:
          `stop during cold start: model not ready within ${stopReadyTimeoutMs}ms; ` +
          (fallbackAudio ? "audio preserved for batch fallback" : "no audio captured"),
        recoverable: true,
      };
      setStatus("error");
      try {
        onError?.({
          ...lastError,
          hasFallbackAudio: fallbackAudio !== null,
          fallbackCoverage,
        });
      } catch {}
      return { ...currentTranscript(), error: lastError };
    }
    // Startup settled while we were stopping: its continuation stood down
    // (status check), and readiness is confirmed - finalize with the
    // already-captured tail (never a second stopFinal).
    return await stopFromActive(myGen, "streaming", fin);
  }

  // Pause: freeze the mic (SIGSTOP) and skip recognition ticks so paused
  // spans cost no inference and never enter the transcript. Only valid
  // while streaming; teardown paths (stop/cancel/dispose) clear it, and the
  // capture resumes the mic first so teardown can never hang on SIGINT.
  // An in-flight transcription is left to settle - it is pre-pause speech
  // the overlap tracker already handles.
  function pause() {
    if (status !== "streaming" || paused) return false;
    paused = true;
    try {
      capture?.pause?.();
    } catch {}
    try {
      onStateChange?.("paused");
    } catch {}
    return true;
  }

  function resume() {
    if (status !== "streaming" || !paused) return false;
    try {
      capture?.resume?.();
    } catch {}
    paused = false;
    try {
      onStateChange?.("resumed");
    } catch {}
    schedule(0);
    return true;
  }

  // Cancel: prompt, bounded, invalidates late responses via generation.
  // Aborts the physical in-flight request (no overlapping inference on
  // restart), stops capture, and wins over any concurrent stop/error path
  // via the generation bump. Never waits for inference.
  async function cancel() {
    if (status === "idle") return false;
    paused = false;
    generation += 1;
    abortActiveRequest();
    setStatus("cancelled");
    clearTimer();
    finalizing = false;
    inFlight = false;
    inFlightPromise = null;
    coalesced = false;
    try {
      await capture?.cancel?.();
    } catch {}
    if (status === "cancelled") setStatus("idle");
    return true;
  }

  async function dispose() {
    generation += 1;
    paused = false;
    abortActiveRequest();
    stopPromise = null;
    startupPromise = null;
    clearTimer();
    finalizing = false;
    inFlight = false;
    inFlightPromise = null;
    coalesced = false;
    try {
      await capture?.cancel?.();
    } catch {}
    try {
      transcriber?.dispose?.();
    } catch {}
    try {
      await capture?.dispose?.();
    } catch {}
    capture = null;
    transcriber = null;
    // pendingModel/model are configuration, not runtime: a later start()
    // recreates the transcriber from the same spec (model stays "loaded"
    // conceptually until setModel/dispose semantics change it in stage 2).
    setStatus("idle");
  }

  // Teardown + recreate on model/language change. Refused mid-dictation so a
  // loaded model is never pulled out from under a running session. The next
  // start() builds the transcriber from the new spec, so the model stays
  // loaded across dictations until explicitly changed or disposed.
  // Rebind per-session callbacks when a warm controller is reused across
  // dictations: the transcriber lease (and capture shell) stay, but partials
  // and errors must reach the NEW session's editor/toast, never a stale one.
  // Only honored while idle/errored (never mid-dictation); returns false
  // otherwise so a caller cannot rewire a live session.
  function updateCallbacks(next = {}) {
    if (status === "streaming" || status === "starting" || status === "stopping") return false;
    if (next && typeof next === "object") {
      if ("onPartial" in next) onPartial = next.onPartial ?? null;
      if ("onFinal" in next) onFinal = next.onFinal ?? null;
      if ("onStateChange" in next) onStateChange = next.onStateChange ?? null;
      if ("onError" in next) onError = next.onError ?? null;
      if ("onOverflow" in next) onOverflow = next.onOverflow ?? null;
    }
    return true;
  }
  function setModel(next) {
    if (status === "streaming" || status === "starting" || status === "stopping") return false;
    try {
      transcriber?.dispose?.();
    } catch {}
    transcriber = null;
    pendingModel = next ? { ...next } : null;
    model = pendingModel;
    fallbackAudio = null;
    fallbackCoverage = null;
    lastError = null;
    tracker = trackerFactory();
    return true;
  }

  function getState() {
    const t = currentTranscript();
    let coverage = null;
    try {
      coverage = capture?.getCoverage?.() || null;
    } catch {
      coverage = null;
    }
    return {
      status,
      stableText: t.stableText,
      tentativeText: t.tentativeText,
      inFlight,
      paused,
      lastError,
      hasFallbackAudio: fallbackAudio !== null,
      fallbackCoverage,
      coverage,
      model,
    };
  }

  return {
    start,
    stop,
    pause,
    resume,
    cancel,
    dispose,
    setModel,
    updateCallbacks,
    getState,
    getServerPort,
    getTranscript: currentTranscript,
    // Live level meter source: newest PCM tail (16-bit mono). Null when the
    // capture is gone or has no audio yet; never throws.
    peekPcm: (nBytes) => {
      try {
        return capture?.peekTail?.(nBytes) || null;
      } catch {
        return null;
      }
    },
    getFallbackAudio: () => fallbackAudio,
    getFallbackCoverage: () => fallbackCoverage,
  };
}
