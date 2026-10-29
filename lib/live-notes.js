// Live voice notes: continuous meeting/lecture capture with background
// transcription. The mic is never paused to wait for whisper or the LLM, so
// you can talk for as long as you want.
//
// Two independent lanes:
//
//   capture lane    - one persistent sox process streams raw PCM; the
//                     audio-chunker splits it into self-contained WAV chunks
//                     on natural pauses (or a forced max-duration cut)
//   processing lane - a 2-stage pipeline (transcribe, then normalize+write)
//                     processes chunks one at a time per stage, but the two
//                     stages overlap: chunk N+1 transcribes while chunk N is
//                     still being normalized. Chunks are appended to the
//                     live Markdown/JSONL files strictly in recording order,
//                     even if a stage resolves out of order.
//
// Local whisper transcription uses a persistent whisper-server (loads the
// model once) when available, falling back to per-chunk whisper-cli
// (reloads the model every call - fine for occasional use, but would fall
// behind a long meeting) or the configured STT API endpoint.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  NOTES_SYSTEM_PROMPT,
  buildRecordArgs,
  detectAudioBackend,
  formatElapsed,
  getLanguage,
  getModelPath,
  getSttApiConfig,
  getTmpDir,
  isLikelyWhisperHallucination,
  isStreamingActive,
  isSttBusy,
  normalizeTranscription,
  transcribeApiFile,
  transcribeFileLocal,
} from "./stt.js";
import { createPcmChunker, wrapPcmAsWav } from "./audio-chunker.js";
import { enhanceWavFile } from "./audio-enhance.js";
import { buildSessionBaseName, createNotesWriter } from "./notes-writer.js";
import { acquireSharedWhisperServer } from "./whisper-server.js";

// Single-concurrency FIFO worker. Each stage processes its queue strictly in
// arrival order but never waits for the OTHER stage, so stage A can start
// chunk N+1 while stage B is still finishing chunk N.

function createStage(name, logger, worker) {
  const queue = [];
  let running = false;

  async function pump() {
    if (running) return;
    running = true;
    while (queue.length > 0) {
      const item = queue.shift();
      try {
        await worker(item);
      } catch (err) {
        logger?.log("VOICE", `Live notes ${name} stage error: ${err.message}`, "error");
      }
    }
    running = false;
  }

  return {
    push(item) {
      queue.push(item);
      pump();
    },
    size() {
      return queue.length + (running ? 1 : 0);
    },
  };
}

function waitForProcessExit(getProc, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const proc = getProc();
      if (!proc || Date.now() - start >= timeoutMs) {
        if (proc) {
          try {
            process.kill(proc.pid, "SIGKILL");
          } catch {}
        }
        resolve();
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

export function registerLiveNotes(api, kv, complete, opts, logger, deps = {}) {
  function toast(message, variant = "info") {
    api.ui.toast({ message, variant, duration: 3000 });
  }

  const workspaceDir = api.state?.path?.directory || process.cwd();
  const notesDirOpt = opts?.notesDir || "voice-notes";
  const chunkMaxMs =
    Number(opts?.notesChunkMaxSeconds) > 0 ? Number(opts.notesChunkMaxSeconds) * 1000 : 20000;
  const silenceMs = Number(opts?.notesSilenceMs) > 0 ? Number(opts.notesSilenceMs) : 700;
  const overlapMs = Number(opts?.notesOverlapMs) >= 0 ? Number(opts.notesOverlapMs) : 400;
  const minChunkMs =
    Number(opts?.notesMinChunkSeconds) > 0 ? Number(opts.notesMinChunkSeconds) * 1000 : 3000;
  // Room noise-floor calibration: learn the silence threshold from the first
  // moments of mic audio instead of assuming 0.02 fits every room. An
  // explicit notesSilenceRms disables it and is used as-is.
  const explicitSilenceRms = Number(opts?.notesSilenceRms) > 0 ? Number(opts.notesSilenceRms) : 0;
  const calibrationMs =
    explicitSilenceRms > 0
      ? 0
      : Number(opts?.notesCalibrationMs) >= 0
        ? Number(opts.notesCalibrationMs)
        : 1500;
  const doNormalize = opts?.notesNormalize !== false;
  const keepAudio = opts?.notesKeepAudio === true;
  const useWhisperServer = opts?.notesUseWhisperServer !== false;
  // Voice-only preprocessing before whisper (far-field AGC). Disable with
  // notesEnhance:false if the mic is already close/loud.
  const doEnhance = opts?.notesEnhance !== false;
  const enhanceTargetRms =
    Number(opts?.notesEnhanceTargetRms) > 0 ? Number(opts.notesEnhanceTargetRms) : 0.1;
  const enhanceMaxGainDb =
    Number(opts?.notesEnhanceMaxGainDb) >= 0 ? Number(opts.notesEnhanceMaxGainDb) : 24;

  let active = false;
  let finishing = false;
  let soxProc = null;
  let chunker = null;
  let notesWriter = null;
  let scratchDir = null;
  let recordingDir = null;
  let recordingBaseName = null;
  let recordingStartedAtMs = 0;
  let useApiMode = false;
  // Shared whisper-server lease (stage 2 unification): live-notes and
  // streaming dictation share one owned server per model/language/port via
  // the whisper-server rendezvous instead of racing for the port. The lease
  // is acquired at session start and released at session end; a second
  // claimant on the same port gets explicit PORT_IN_USE, never a kill.
  let whisperServerLease = null;
  let whisperServerClient = null;
  let whisperServerReadyPromise = null;

  function releaseWhisperServerLease() {
    whisperServerClient = null;
    if (whisperServerLease) {
      try {
        whisperServerLease.release();
      } catch {}
      whisperServerLease = null;
    }
  }
  let statusTimer = null;

  async function transcribeLocalChunk(wavPath) {
    if (useApiMode) {
      const apiCfg = getSttApiConfig();
      return transcribeApiFile(wavPath, apiCfg.endpoint, apiCfg.model, apiCfg.apiKeyEnv, logger);
    }
    if (whisperServerReadyPromise) {
      const ready = await whisperServerReadyPromise;
      if (ready && whisperServerClient?.isRunning()) {
        const result = await whisperServerClient.transcribeFile(wavPath);
        if (!result.error) return result;
        logger?.log(
          "VOICE",
          `whisper-server chunk failed, falling back to whisper-cli: ${result.error}`,
          "warn",
        );
      }
    }
    return transcribeFileLocal(wavPath, getModelPath(kv), getLanguage(kv), logger);
  }

  const stageA = createStage("transcribe", logger, async (chunk) => {
    const wavPath = path.join(scratchDir, `chunk-${chunk.seq}.wav`);
    fs.writeFileSync(wavPath, wrapPcmAsWav(chunk.pcm, { sampleRate: 16000 }));

    // Voice-only preprocessing: bring quiet far-field speech up to a
    // healthy level before whisper sees it. Never loses audio - on any
    // failure the original recording is transcribed as-is.
    let audio = { enhanced: false, reason: "disabled" };
    if (doEnhance) {
      audio = await enhanceWavFile(
        wavPath,
        chunk.pcm,
        { targetRms: enhanceTargetRms, maxGainDb: enhanceMaxGainDb },
        logger,
      );
    }

    const t0 = Date.now();
    const result = await transcribeLocalChunk(wavPath);
    const transcribeMs = Date.now() - t0;

    if (keepAudio) {
      try {
        const audioDir = path.join(recordingDir, `${recordingBaseName}-audio`);
        fs.mkdirSync(audioDir, { recursive: true });
        fs.renameSync(
          wavPath,
          path.join(audioDir, `chunk-${String(chunk.seq).padStart(5, "0")}.wav`),
        );
      } catch {}
    } else {
      try {
        fs.unlinkSync(wavPath);
      } catch {}
    }

    stageB.push({
      chunk,
      raw: result.text || "",
      error: result.error || null,
      transcribeMs,
      audio,
    });
  });

  // Consecutive identical transcripts are almost always whisper
  // hallucinating on quiet/noise (e.g. the same YouTube outro 7x in a row),
  // not a professor repeating themselves word-for-word.
  let repeatCount = 0;
  let lastRawText = "";

  const stageB = createStage("normalize", logger, async (item) => {
    const { chunk } = item;
    const base = {
      seq: chunk.seq,
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      forced: chunk.forced,
      audio: item.audio || { enhanced: false, reason: "unknown" },
    };

    if (item.error) {
      repeatCount = 0;
      lastRawText = "";
      notesWriter.appendChunk({ ...base, raw: "", normalized: "", error: item.error });
      logger?.log(
        "VOICE",
        `Live notes chunk ${chunk.seq} transcription failed: ${item.error}`,
        "warn",
      );
      return;
    }

    const raw = item.raw;
    if (raw) {
      repeatCount = raw === lastRawText ? repeatCount + 1 : 1;
      lastRawText = raw;
    } else {
      repeatCount = 0;
      lastRawText = "";
    }
    if (!raw || isLikelyWhisperHallucination(raw) || repeatCount >= 3) {
      notesWriter.appendChunk({
        ...base,
        raw,
        normalized: "",
        skipped: !raw ? "empty" : repeatCount >= 3 ? "repeated" : "hallucination",
        transcribeMs: item.transcribeMs,
      });
      return;
    }

    if (!doNormalize) {
      notesWriter.appendChunk({ ...base, raw, normalized: raw, transcribeMs: item.transcribeMs });
      return;
    }

    const contextBlock = (notesWriter.lastText() || "").slice(-300) || null;
    const t0 = Date.now();
    const llmResult = await normalizeTranscription(
      complete,
      raw,
      contextBlock,
      NOTES_SYSTEM_PROMPT,
      logger,
    );
    const normalizeMs = Date.now() - t0;
    notesWriter.appendChunk({
      ...base,
      raw,
      normalized: llmResult.text || raw,
      transcribeMs: item.transcribeMs,
      normalizeMs,
      error: llmResult.error || null,
    });
  });

  let calibrationLogged = false;
  function routeChunk(chunk) {
    if (!calibrationLogged && chunker?.isCalibrated?.() === true) {
      calibrationLogged = true;
      logger?.log(
        "VOICE",
        `Live notes room calibrated noiseFloor=${chunker.getNoiseFloor?.()?.toFixed(4)} silenceRms=${chunker.getSilenceThreshold?.()?.toFixed(4)}`,
        "debug",
      );
    }
    if (!chunk.hasSpeech) {
      notesWriter.appendChunk({
        seq: chunk.seq,
        startMs: chunk.startMs,
        endMs: chunk.endMs,
        forced: chunk.forced,
        raw: "",
        normalized: "",
        skipped: "silence",
      });
      return;
    }
    stageA.push(chunk);
  }

  function statusMessage() {
    const elapsed = formatElapsed(Date.now() - recordingStartedAtMs);
    const written = notesWriter ? notesWriter.entryCount() : 0;
    const queued = stageA.size() + stageB.size();
    const lagMs = notesWriter
      ? Math.max(0, Date.now() - recordingStartedAtMs - notesWriter.lastWrittenEndMs())
      : 0;
    return `● Live notes  ${elapsed} · written ${written} · queued ${queued} · lag ${Math.round(lagMs / 1000)}s`;
  }

  function showStatusToast() {
    clearStatusToast();
    toast(statusMessage());
    statusTimer = setInterval(() => {
      if (active) toast(statusMessage());
    }, 2500);
  }

  function clearStatusToast() {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  }

  function startCapture(backend) {
    const mic = kv.get("stt.mic", "") || null;
    const inputArgs = buildRecordArgs(backend, mic);
    // Test seam: deterministic capture without a mic (`deps.spawn`).
    // Production passes nothing and uses the real spawn.
    const spawnFn = deps.spawn ?? spawn;
    let stderr = "";
    try {
      soxProc = spawnFn(
        "sox",
        [...inputArgs, "-r", "16000", "-c", "1", "-b", "16", "-t", "raw", "-"],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (err) {
      logger?.log("VOICE", `Live notes failed to start capture: ${err.message}`, "error");
      return false;
    }

    soxProc.stdout.on("data", (buf) => {
      const ready = chunker.push(buf);
      for (const chunk of ready) routeChunk(chunk);
    });
    soxProc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    soxProc.on("error", (err) => {
      soxProc = null;
      logger?.log("VOICE", `Live notes capture process error: ${err.message}`, "error");
      // Terminal capture failure (e.g. sox binary missing): same stop/save
      // path as an unexpected exit, otherwise `active` stays true with the
      // status timer running while no chunks are ever saved.
      if (active && !finishing) {
        toast("Live notes: microphone failed, saving what we have", "error");
        stopCommand();
      }
    });
    soxProc.on("exit", (code) => {
      soxProc = null;
      if (active && code !== 0 && code !== null) {
        logger?.log(
          "VOICE",
          `Live notes capture exited code=${code} stderr=${stderr.trim()}`,
          "error",
        );
        toast("Live notes: microphone stopped unexpectedly, saving what we have", "error");
        stopCommand();
      }
    });
    return true;
  }

  function waitForDrain() {
    return new Promise((resolve) => {
      const check = () => {
        if (stageA.size() === 0 && stageB.size() === 0) resolve();
        else setTimeout(check, 200);
      };
      check();
    });
  }

  async function drainAndSave() {
    finishing = true;
    await waitForDrain();
    releaseWhisperServerLease();
    const paths = await notesWriter.close();
    notesWriter = null;
    finishing = false;
    logger?.log("VOICE", `Live notes saved md=${paths.mdPath} jsonl=${paths.jsonlPath}`, "debug");
    toast(`Live notes saved: ${path.relative(workspaceDir, paths.mdPath)}`, "success");
  }

  async function startNotes() {
    if (active || finishing) {
      toast(
        finishing ? "Live notes still saving the last session" : "Live notes already recording",
        "warning",
      );
      return;
    }
    if (isSttBusy() || isStreamingActive()) {
      toast("STT busy - finish or cancel it first", "warning");
      return;
    }
    if (deps.isConversationActive?.()) {
      toast("Voice conversation is on - exit it first", "warning");
      return;
    }

    const startedAt = new Date();
    recordingDir = path.isAbsolute(notesDirOpt)
      ? notesDirOpt
      : path.join(workspaceDir, notesDirOpt);
    recordingBaseName = buildSessionBaseName(startedAt, opts?.notesTitle);
    const language = getLanguage(kv);
    const modelPath = getModelPath(kv);

    try {
      notesWriter = createNotesWriter({
        dir: recordingDir,
        baseName: recordingBaseName,
        startedAt: startedAt.toISOString(),
        language,
        model: path.basename(modelPath),
      });
    } catch (err) {
      toast(`Could not create notes file: ${err.message}`, "error");
      return;
    }

    scratchDir = path.join(getTmpDir(), "opencode-voice-notes");
    try {
      fs.mkdirSync(scratchDir, { recursive: true });
    } catch (err) {
      logger?.log("VOICE", `Failed to create notes scratch dir: ${err.message}`, "warn");
    }

    chunker = createPcmChunker({
      minChunkMs,
      maxChunkMs: chunkMaxMs,
      silenceMs,
      overlapMs,
      ...(explicitSilenceRms > 0 ? { silenceRmsThreshold: explicitSilenceRms } : {}),
      calibrationMs,
    });
    if (chunker.isCalibrated?.() === false) {
      logger?.log("VOICE", "Live notes calibrating room noise floor...", "debug");
    }

    useApiMode = getSttApiConfig() !== null;
    releaseWhisperServerLease();
    whisperServerReadyPromise = null;
    if (!useApiMode && useWhisperServer) {
      whisperServerLease = acquireSharedWhisperServer({ modelPath, language, logger });
      whisperServerClient = whisperServerLease.client;
      whisperServerReadyPromise = whisperServerClient.start();
    }

    active = true;
    recordingStartedAtMs = Date.now();
    deps.tts?.setLiveNotesActive?.(true);
    deps.tts?.stop?.();

    const backend = detectAudioBackend();
    if (!startCapture(backend)) {
      active = false;
      deps.tts?.setLiveNotesActive?.(false);
      releaseWhisperServerLease();
      await notesWriter.close();
      notesWriter = null;
      toast("Failed to start microphone for live notes", "error");
      return;
    }

    showStatusToast();
    logger?.log(
      "VOICE",
      `Live notes started dir=${recordingDir} base=${recordingBaseName}`,
      "debug",
    );
    toast(`Live notes started: ${recordingBaseName}.md`, "success");
  }

  async function stopCommand() {
    if (finishing) {
      toast("Live notes already saving", "warning");
      return;
    }
    if (!active) {
      toast("Live notes not recording", "warning");
      return;
    }
    // Claim the drain BEFORE the first await (SoX exit wait): startNotes
    // must not replace notesWriter/chunker/lease mid-drain and corrupt
    // sessions.
    finishing = true;
    active = false;
    deps.tts?.setLiveNotesActive?.(false);
    clearStatusToast();
    if (soxProc) {
      try {
        soxProc.kill("SIGINT");
      } catch {}
    }
    await waitForProcessExit(() => soxProc);
    const finalChunk = chunker?.flush();
    if (finalChunk) routeChunk(finalChunk);

    toast(`Draining live notes - ${stageA.size() + stageB.size()} chunk(s) remaining`);
    await drainAndSave();
  }

  function cancelCommand() {
    if (!active) {
      toast("Live notes not recording", "warning");
      return;
    }
    // Same claim as stopCommand: block startNotes for the background drain.
    finishing = true;
    active = false;
    deps.tts?.setLiveNotesActive?.(false);
    clearStatusToast();
    if (soxProc) {
      try {
        soxProc.kill("SIGINT");
      } catch {}
    }
    toast("Live notes stopping - saving remaining chunks in the background", "info");
    (async () => {
      await waitForProcessExit(() => soxProc);
      const finalChunk = chunker?.flush();
      if (finalChunk) routeChunk(finalChunk);
      await drainAndSave();
    })();
  }

  function isActive() {
    return active;
  }

  api.lifecycle?.onDispose?.(() => {
    clearStatusToast();
    if (active) cancelCommand();
    else releaseWhisperServerLease();
  });

  const commands = [
    {
      title: "Voice notes: start",
      value: "voice.notes.start",
      category: "opencode-voice",
      description: "Start continuous live-notes recording with background transcription",
      slash: { name: "voice-notes-start" },
      onSelect() {
        startNotes();
      },
    },
    {
      title: "Voice notes: stop",
      value: "voice.notes.stop",
      category: "opencode-voice",
      description: "Stop live notes, flush the remaining audio, and save",
      slash: { name: "voice-notes-stop" },
      onSelect() {
        stopCommand();
      },
    },
    {
      title: "Voice notes: cancel",
      value: "voice.notes.cancel",
      category: "opencode-voice",
      description: "Stop capturing immediately; finish saving in the background",
      slash: { name: "voice-notes-cancel" },
      onSelect() {
        cancelCommand();
      },
    },
    {
      title: "Voice notes: status",
      value: "voice.notes.status",
      category: "opencode-voice",
      description: "Show live-notes recording status",
      slash: { name: "voice-notes-status" },
      onSelect() {
        toast(active ? statusMessage() : "Live notes not recording");
      },
    },
  ];

  return { commands, controller: { isActive, stop: stopCommand, cancel: cancelCommand } };
}
