// Managed VieNeu-TTS sidecar (see https://github.com/pnnbao97/VieNeu-TTS).
//
// VieNeu-TTS is an open-source Vietnamese TTS with built-in English-Vietnamese
// bilingual code-switching. Unlike Chatterbox (which cannot speak Vietnamese)
// and Piper (which needs separate vi/en voices and can't mix within an
// utterance), VieNeu handles mixed-language text in a single pass.
//
// Like Chatterbox, it ships as a Python sidecar serving an OpenAI-compatible
// API at POST /v1/audio/speech (returns WAV/PCM). The plugin spawns it once
// and keeps it loaded for the session.
//
// Install: `uv pip install vieneu` (or pip). First run downloads model weights.
// CPU-only (ONNX Runtime) works out of the box; GPU needs CUDA torch.

import { spawn } from "node:child_process";
import fs from "node:fs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8000;
const DEFAULT_PORT_SCAN_MAX = 4;
const READY_TIMEOUT_MS = 300000;
const READY_POLL_MS = 1000;
const SYNTHESIZE_TIMEOUT_MS = 30000;

// VieNeu-TTS supports Vietnamese + English code-switching natively.
export const VIENEU_LANGUAGES = new Set(["vi", "en"]);

export function vieneuSupportsLang(lang) {
  return VIENEU_LANGUAGES.has(lang);
}

// Routing: VieNeu handles both vi and en (code-switching), so it is always
// eligible when configured. Returns the engine + reason like resolveTtsEngine.
export function resolveVieneuEngine(opts, lang, warn) {
  const configured = opts?.ttsEngine;
  if (configured !== "vieneu") return { engine: "piper", reason: "not-configured" };
  if (vieneuSupportsLang(lang)) return { engine: "vieneu", reason: "ok" };
  warn?.(`VieNeu-TTS cannot speak "${lang}" - using Piper for this utterance`);
  return { engine: "piper", reason: "unsupported-language" };
}

export function buildVieneuArgs({ host, port }) {
  return [
    "-m",
    "apps.openai_speech",
    "--host",
    host || DEFAULT_HOST,
    "--port",
    String(port || DEFAULT_PORT),
  ];
}

export function createVieneuClient(options = {}) {
  const {
    host = DEFAULT_HOST,
    python,
    voice = "Mai Anh",
    logger,
    readyTimeoutMs = READY_TIMEOUT_MS,
    readyPollMs = READY_POLL_MS,
    synthesizeTimeoutMs = SYNTHESIZE_TIMEOUT_MS,
    portScanMax = DEFAULT_PORT_SCAN_MAX,
    deps = {},
  } = options;

  // Default to the venv python if it exists (host truncates plugin options,
  // so ttsVieneuPython may not be delivered).
  const defaultPython = "/Users/duytrinh/.local/share/opencode-voice/vieneu-venv/bin/python";
  const resolvedPython = python || (fs.existsSync(defaultPython) ? defaultPython : "python3");

  const spawnFn = deps.spawn ?? spawn;
  const fetchFn = deps.fetch ?? fetch;

  let proc = null;
  let ready = false;
  let ownerPid = null;
  let boundPort = options.port ?? DEFAULT_PORT;
  let lastError = null;

  const baseUrlFor = (p) => `http://${host}:${p}`;

  async function portResponds(p) {
    try {
      const resp = await fetchFn(`${baseUrlFor(p)}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      return !!resp;
    } catch {
      return false;
    }
  }

  async function probeOnce() {
    try {
      const resp = await fetchFn(`${baseUrlFor(boundPort)}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!resp) return "down";
      if (resp.ok) return "ready";
      return "down";
    } catch {
      return "down";
    }
  }

  async function pollReady(deadline) {
    while (Date.now() < deadline) {
      if (!proc) return { failed: "vieneu sidecar exited before becoming ready" };
      const state = await probeOnce();
      if (state === "ready") return state;
      await new Promise((r) => setTimeout(r, readyPollMs));
    }
    return "timeout";
  }

  async function startOnPort(port) {
    boundPort = port;
    if (await portResponds(port)) {
      return {
        ok: false,
        code: "PORT_IN_USE",
        advancable: true,
        message: `Port ${port} already answers`,
      };
    }
    const bin = resolvedPython;
    try {
      proc = spawnFn(bin, ["-m", "apps.openai_speech"], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (err) {
      proc = null;
      return {
        ok: false,
        code: "SPAWN_FAILED",
        advancable: false,
        message: `Failed to spawn ${bin}: ${err.message}`,
      };
    }

    let stderr = "";
    const owned = proc;
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      // Log stderr in real-time for debugging
      logger?.log?.("VOICE", `vieneu stderr: ${chunk.toString().trim()}`, "debug");
    });
    proc.on("exit", (code) => {
      if (proc !== owned) return;
      lastError = { code: "EXITED", message: `vieneu sidecar exited (code=${code}) stderr=${stderr.trim().slice(-200)}` };
      proc = null;
      ready = false;
      ownerPid = null;
      logger?.log?.("VOICE", `vieneu sidecar exited (code=${code}) stderr=${stderr.trim().slice(-200)}`, "warn");
    });
    proc.on("error", (err) => {
      if (proc !== owned) return;
      logger?.log?.("VOICE", `vieneu sidecar error: ${err.message}`, "warn");
      proc = null;
      ready = false;
      ownerPid = null;
    });

    const outcome = await pollReady(Date.now() + readyTimeoutMs);
    if (outcome !== "ready") {
      const tail = stderr.trim().slice(-300);
      const message =
        outcome === "timeout"
          ? `vieneu sidecar did not become ready in time (${readyTimeoutMs}ms) stderr=${tail}`
          : `vieneu sidecar unavailable: ${outcome.failed ?? "unknown"}`;
      const code = outcome === "timeout" ? "START_TIMEOUT" : "MODEL_LOAD_FAILED";
      stop();
      return { ok: false, code, advancable: false, message };
    }
    ownerPid = proc?.pid ?? null;
    return { ok: true };
  }

  async function start() {
    if (proc && ready) return true;
    const scanMax = Math.max(1, Math.floor(portScanMax) || 1);
    for (let i = 0; i < scanMax; i++) {
      const port = boundPort + i;
      const r = await startOnPort(port);
      if (r.ok) {
        ready = true;
        lastError = null;
        logger?.log?.(
          "VOICE",
          `vieneu sidecar ready at ${baseUrlFor(boundPort)} voice=${voice} pid=${ownerPid}`,
          "debug",
        );
        return true;
      }
      if (!r.advancable) {
        lastError = { code: r.code, message: r.message };
        logger?.log?.("VOICE", r.message, "warn");
        return false;
      }
      logger?.log?.("VOICE", r.message, "warn");
    }
    lastError = {
      code: "PORT_RANGE_EXHAUSTED",
      message: `No free port in ${boundPort}..${boundPort + scanMax - 1}`,
    };
    logger?.log?.("VOICE", lastError.message, "warn");
    return false;
  }

  async function synthesize(text, opts = {}) {
    if (!ready) {
      return {
        ok: false,
        code: lastError?.code || "NOT_READY",
        message: lastError?.message || "vieneu sidecar not ready",
      };
    }
    try {
      const resp = await fetchFn(`${baseUrlFor(boundPort)}/v1/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "vieneu-v3-turbo",
          input: text,
          voice: opts.voice || voice,
          response_format: "wav",
        }),
        signal: AbortSignal.timeout(synthesizeTimeoutMs),
      });
      if (!resp?.ok) {
        let message = `vieneu sidecar responded ${resp?.status}`;
        try {
          const data = await resp.json();
          if (data?.error) message = data.error;
        } catch {}
        return { ok: false, code: "BAD_STATUS", message };
      }
      const audio = Buffer.from(await resp.arrayBuffer());
      if (audio.length === 0) {
        return { ok: false, code: "EMPTY_AUDIO", message: "vieneu returned no audio" };
      }
      return { ok: true, wav: audio };
    } catch (err) {
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      return {
        ok: false,
        code: timedOut ? "SYNTH_TIMEOUT" : "REQUEST_FAILED",
        message: `vieneu synthesis failed: ${err.message}`,
      };
    }
  }

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

  function getPort() {
    return boundPort;
  }

  return { start, stop, synthesize, isRunning, getLastError, getPort };
}

export { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_PORT_SCAN_MAX };
