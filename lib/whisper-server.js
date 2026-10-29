// Persistent local whisper-server for live notes.
//
// One-shot STT reuses whisper-cli, which reloads the model on every call -
// fine for a single utterance, but live notes transcribes a new chunk every
// few seconds and reloading a multi-GB model that often would fall behind
// the meeting. whisper-server (shipped alongside whisper-cli by the same
// whisper.cpp build) loads the model once and serves /inference over HTTP.
//
// If the binary is missing, the port is unavailable, or it fails to become
// ready in time, callers fall back to per-chunk whisper-cli - this is an
// optimization, never a hard dependency.
//
// Ownership rules (shared-port safety):
// - Before spawning, the port is probed. If anything already answers, the
//   start is refused with an explicit PORT_IN_USE error - the existing
//   process (possibly another tool, possibly an older live-notes session) is
//   never claimed as ours and never killed.
// - Multi-TUI: callers that OMIT `port` (live-notes, streaming dictation)
//   auto-advance from 127.0.0.1:8090 upward (bounded by `portScanMax`,
//   default 10) and claim the first silent port, so a second TUI lands on
//   8091+ with its own model load (~2GB RAM each). Callers that pass an
//   EXPLICIT `port` keep the strict refusal above. The bound port is
//   visible via getPort(). When every port in range answers, start fails
//   with PORT_RANGE_EXHAUSTED (recoverable - callers fall back to
//   whisper-cli, audio preserved).
// - Bind-race safety: two TUIs probing the same free port resolve without
//   orphan kills - if our spawn loses the race (early exit with an
//   address-in-use diagnostic), that port is treated as PORT_IN_USE and the
//   scan advances; only the owned handle is ever signaled.
// - Readiness is established via GET /health (200 = model loaded, 503 =
//   still loading). Very old server builds without /health fall back to the
//   base URL, but only when the Server response header identifies whisper.cpp
//   - any HTTP response (a proxy, another app) must not count as ready.
// - stop() only ever signals the process this client spawned (by pid handle),
//   never a port-wide pkill.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8090;
// Default-port scan bound: try 8090..8090+MAX-1 before giving up, so ~10
// TUIs can coexist on one machine (one model load per TUI, ~2GB RAM each).
const DEFAULT_PORT_SCAN_MAX = 10;
const READY_TIMEOUT_MS = 20000;
const READY_POLL_MS = 300;

export function whisperServerOnPath() {
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return pathDirs.some((dir) => fs.existsSync(path.join(dir, "whisper-server")));
}

export function buildWhisperServerArgs({ modelPath, language, host, port, threads }) {
  const args = [
    "-m",
    modelPath,
    "-l",
    language || "auto",
    "--host",
    host || DEFAULT_HOST,
    "--port",
    String(port || DEFAULT_PORT),
  ];
  if (threads) args.push("-t", String(threads));
  return args;
}

function buildInferenceRequest(audioBuffer, responseFormat = "json") {
  const blob = new Blob([audioBuffer], { type: "audio/wav" });
  const form = new FormData();
  form.append("file", blob, "audio.wav");
  form.append("response_format", responseFormat);
  form.append("temperature", "0.0");
  return form;
}

// A server that exits before ready because another process won the bind
// race prints an address-in-use diagnostic. Only that pattern advances the
// port scan - any other early exit (missing model, bad flags) aborts, since
// another port would fail the same way.
function isAddressInUse(stderr) {
  return /address already in use|EADDRINUSE|already in use|failed to bind|bind.*fail|address_in_use/i.test(
    stderr || "",
  );
}

export { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_PORT_SCAN_MAX };

export function createWhisperServerClient(options = {}) {
  const {
    modelPath,
    language,
    host = DEFAULT_HOST,
    threads,
    logger,
    readyTimeoutMs = READY_TIMEOUT_MS,
    readyPollMs = READY_POLL_MS,
    portScanMax = DEFAULT_PORT_SCAN_MAX,
    deps = {},
  } = options;
  // Explicit port (caller passed `port`) keeps strict behavior: refuse with
  // PORT_IN_USE, never claim/kill. Default path (no `port` given) scans
  // upward from 8090 and claims the first silent port.
  const explicitPort = options.port !== undefined && options.port !== null;
  const requestedPort = options.port ?? DEFAULT_PORT;
  const spawnFn = deps.spawn ?? spawn;
  const fetchFn = deps.fetch ?? fetch;
  let proc = null;
  let ready = false;
  let ownerPid = null;
  let lastError = null;
  let boundPort = requestedPort;
  const baseUrlFor = (p) => `http://${host}:${p}`;

  // True when something already answers on the port - i.e. a foreign owner.
  // Called before spawn only, so any responder is by definition not ours.
  async function portResponds(p) {
    const base = baseUrlFor(p);
    for (const url of [`${base}/health`, base]) {
      try {
        const resp = await fetchFn(url, { signal: AbortSignal.timeout(1500) });
        if (resp) return true;
      } catch {
        // Connection refused / timeout: keep checking the next URL.
      }
    }
    return false;
  }

  // One readiness probe. Returns "ready" | "loading" | "down".
  async function probeOnce() {
    const base = baseUrlFor(boundPort);
    try {
      const resp = await fetchFn(`${base}/health`, { signal: AbortSignal.timeout(1500) });
      if (resp?.ok) return "ready";
      if (resp?.status === 503) return "loading";
      if (resp?.status === 404) {
        // Build predates /health: only accept the base URL when the Server
        // header identifies whisper.cpp, so a proxy or another app on the
        // port is never mistaken for our service.
        try {
          const baseResp = await fetchFn(base, { signal: AbortSignal.timeout(1500) });
          const server = baseResp?.headers?.get?.("server") || "";
          if (server.toLowerCase().includes("whisper")) return "ready";
        } catch {
          // Fall through to "down".
        }
        return "down";
      }
      return "down";
    } catch {
      return "down";
    }
  }

  async function pollReady(deadline) {
    while (Date.now() < deadline) {
      if (!proc) return false; // exited before becoming ready
      const state = await probeOnce();
      if (state === "ready") {
        if (!proc) return false; // raced with exit; not ours to claim
        return true;
      }
      await new Promise((r) => setTimeout(r, readyPollMs));
    }
    return false;
  }

  // Attempt one port: probe, spawn, wait for readiness. Returns
  // { ok:true } or { ok:false, code, message, advancable } where advancable
  // means "another port may succeed" (PORT_IN_USE only). stop() inside only
  // ever signals the owned handle spawned here - never a foreign pid.
  async function startOnPort(port) {
    boundPort = port;
    if (await portResponds(port)) {
      return {
        ok: false,
        code: "PORT_IN_USE",
        advancable: true,
        message: `Port ${port} already answers - owned by another process, not starting a second whisper-server`,
      };
    }
    const args = buildWhisperServerArgs({ modelPath, language, host, port, threads });
    logger?.log("VOICE", `Starting whisper-server ${args.join(" ")}`, "debug");
    try {
      proc = spawnFn("whisper-server", args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      proc = null;
      return {
        ok: false,
        code: "SPAWN_FAILED",
        advancable: false,
        message: `Failed to spawn whisper-server: ${err.message}`,
      };
    }

    let stderr = "";
    // Bind to the spawned handle: a late event from an old child after a
    // restart must never wipe the new handle (ready false, stop() unable to
    // signal). Shared state mutates only when proc is still this handle.
    const owned = proc;
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("exit", (code) => {
      if (proc !== owned) return;
      if (!ready) {
        logger?.log(
          "VOICE",
          `whisper-server exited before ready code=${code} stderr=${stderr.trim().slice(-300)}`,
          "warn",
        );
      }
      proc = null;
      ready = false;
      ownerPid = null;
    });
    proc.on("error", (err) => {
      if (proc !== owned) return;
      logger?.log("VOICE", `whisper-server process error: ${err.message}`, "warn");
      proc = null;
      ready = false;
      ownerPid = null;
    });

    ready = await pollReady(Date.now() + readyTimeoutMs);
    if (!ready) {
      const exitedEarly = !proc;
      const tail = stderr.trim().slice(-300);
      if (exitedEarly && isAddressInUse(tail)) {
        // Bind race: a sibling TUI claimed the port between our probe and
        // our spawn. Our proc already exited; nothing foreign to signal.
        stop();
        return {
          ok: false,
          code: "PORT_IN_USE",
          advancable: true,
          message: `Port ${port} lost the bind race - owned by another process, trying the next port`,
        };
      }
      const failure = exitedEarly
        ? {
            code: "EXITED_EARLY",
            message: `whisper-server exited before ready stderr=${tail}`,
          }
        : {
            code: "START_TIMEOUT",
            message: `whisper-server did not become ready in time (${readyTimeoutMs}ms)`,
          };
      logger?.log("VOICE", failure.message, "warn");
      stop();
      return { ok: false, ...failure, advancable: false };
    }
    ownerPid = proc?.pid ?? null;
    return { ok: true };
  }

  async function start() {
    if (proc && ready) return true; // reuse the owned, already-ready server
    if (!whisperServerOnPath()) {
      lastError = {
        code: "SERVER_BINARY_MISSING",
        message: "whisper-server not on PATH, falling back to whisper-cli",
      };
      logger?.log("VOICE", lastError.message, "warn");
      return false;
    }
    if (explicitPort) {
      const r = await startOnPort(requestedPort);
      if (!r.ok) {
        lastError = { code: r.code, message: r.message };
        logger?.log("VOICE", lastError.message, "warn");
        return false;
      }
      lastError = null;
      logger?.log(
        "VOICE",
        `whisper-server ready at ${baseUrlFor(boundPort)} pid=${ownerPid}`,
        "debug",
      );
      return true;
    }
    const scanMax = Math.max(1, Math.floor(portScanMax) || 1);
    for (let i = 0; i < scanMax; i += 1) {
      const port = DEFAULT_PORT + i;
      const r = await startOnPort(port);
      if (r.ok) {
        lastError = null;
        logger?.log(
          "VOICE",
          `whisper-server ready at ${baseUrlFor(boundPort)} pid=${ownerPid}`,
          "debug",
        );
        return true;
      }
      if (!r.advancable) {
        lastError = { code: r.code, message: r.message };
        logger?.log("VOICE", lastError.message, "warn");
        return false;
      }
      logger?.log("VOICE", r.message, "warn");
    }
    lastError = {
      code: "PORT_RANGE_EXHAUSTED",
      message: `No free port in ${DEFAULT_PORT}..${DEFAULT_PORT + scanMax - 1} - all answer, falling back to whisper-cli`,
    };
    logger?.log("VOICE", lastError.message, "warn");
    return false;
  }

  // Transcribe one WAV file. responseFormat "verbose_json" additionally
  // returns snapshot-relative segments (start/end/duration are relative to
  // the submitted audio, NOT absolute session time - see
  // lib/streaming-transcript.js). Defaults to "json" (live-notes behavior).
  // options.signal aborts the HTTP request (streaming stop/cancel/restart
  // must not leave a doomed request running while a new session starts).
  async function transcribeFile(wavPath, options = {}) {
    if (!ready) {
      return {
        error: lastError?.message || "whisper-server not ready",
        code: lastError?.code || "NOT_READY",
      };
    }
    const responseFormat = options.responseFormat || "json";
    const timeout = AbortSignal.timeout(60000);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    try {
      const audioBuffer = await fs.promises.readFile(wavPath);
      const resp = await fetchFn(`${baseUrlFor(boundPort)}/inference`, {
        method: "POST",
        body: buildInferenceRequest(audioBuffer, responseFormat),
        signal,
      });
      if (!resp.ok) {
        return { error: `whisper-server responded ${resp.status}`, code: "BAD_STATUS" };
      }
      const data = await resp.json();
      const result = { text: (data?.text || "").trim() };
      if (Array.isArray(data?.segments)) result.segments = data.segments;
      return result;
    } catch (err) {
      if (err?.name === "AbortError") {
        return { error: "whisper-server request aborted", code: "ABORTED" };
      }
      return { error: `whisper-server request failed: ${err.message}`, code: "REQUEST_FAILED" };
    }
  }

  // Transcribe an in-memory WAV buffer (streaming snapshots never touch the
  // disk). Same contract as transcribeFile (including options.signal).
  async function transcribeBuffer(wavBuffer, options = {}) {
    if (!ready) {
      return {
        error: lastError?.message || "whisper-server not ready",
        code: lastError?.code || "NOT_READY",
      };
    }
    const responseFormat = options.responseFormat || "json";
    const timeout = AbortSignal.timeout(60000);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    try {
      const resp = await fetchFn(`${baseUrlFor(boundPort)}/inference`, {
        method: "POST",
        body: buildInferenceRequest(wavBuffer, responseFormat),
        signal,
      });
      if (!resp.ok) {
        return { error: `whisper-server responded ${resp.status}`, code: "BAD_STATUS" };
      }
      const data = await resp.json();
      const result = { text: (data?.text || "").trim() };
      if (Array.isArray(data?.segments)) result.segments = data.segments;
      return result;
    } catch (err) {
      if (err?.name === "AbortError") {
        return { error: "whisper-server request aborted", code: "ABORTED" };
      }
      return { error: `whisper-server request failed: ${err.message}`, code: "REQUEST_FAILED" };
    }
  }

  // Stop ONLY the process this client spawned (by handle). A foreign process
  // on the same port is never signaled - see PORT_IN_USE above.

  // Stop ONLY the process this client spawned (by handle). A foreign process
  // on the same port is never signaled - see PORT_IN_USE above.
  function stop() {
    ready = false;
    ownerPid = null;
    if (proc) {
      const owned = proc;
      proc = null;
      try {
        owned.kill("SIGTERM");
      } catch {}
    }
  }

  function isRunning() {
    return ready && proc !== null;
  }

  function getLastError() {
    return lastError;
  }

  function getOwnerPid() {
    return ownerPid;
  }

  // The port this client is bound (or will try to bind) to. Default-path
  // clients advance upward from 8090; explicit-port clients stay put.
  function getPort() {
    return boundPort;
  }

  return {
    start,
    transcribeFile,
    transcribeBuffer,
    stop,
    isRunning,
    getLastError,
    getOwnerPid,
    getPort,
  };
}

// Shared rendezvous so the streaming dictation controller and live-notes
// reuse one owned server per model/language/port instead of racing for the
// port. Callers that omit `port` share one auto-scan client (keyed "auto")
// whose start() claims the first silent port from 8090 upward; callers with
// an explicit port share per that port and keep strict PORT_IN_USE refusal.
// A second claimant never kills: explicit collisions fail, auto scans ahead.
const sharedServers = new Map();

function sharedKey({ modelPath, language, host, port }) {
  // The actual bound port distinguishes entries: explicit ports key per
  // port, the default path keys per "auto" so in-process sharing coalesces
  // to the single auto-scan client (whose getPort() reports the claim).
  const portPart = port === undefined || port === null ? "auto" : String(port);
  return `${host || DEFAULT_HOST}:${portPart}:${modelPath}:${language || "auto"}`;
}

export function acquireSharedWhisperServer(options = {}) {
  const key = sharedKey(options);
  let entry = sharedServers.get(key);
  if (!entry) {
    entry = { client: createWhisperServerClient(options), refs: 0 };
    sharedServers.set(key, entry);
  }
  entry.refs += 1;
  let released = false;
  return {
    client: entry.client,
    release() {
      if (released) return;
      released = true;
      entry.refs -= 1;
      if (entry.refs <= 0) {
        sharedServers.delete(key);
        entry.client.stop();
      }
    },
  };
}

export function __clearSharedWhisperServersForTest() {
  sharedServers.clear();
}
