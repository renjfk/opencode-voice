// Managed Chatterbox TTS sidecar (see vendor/chatterbox_server.py).
//
// Why a sidecar instead of a one-shot CLI: Chatterbox loads a large torch
// model. Loading it per utterance would never keep up with a spoken
// conversation, so - exactly like lib/whisper-server.js for whisper.cpp - one
// child process loads the model once and serves synthesis over HTTP while we
// own its lifetime.
//
// Follows the whisper-server conventions deliberately:
// - Port is probed BEFORE spawning; if anything already answers we never claim
//   it and never kill the foreign process. Default-port callers auto-advance
//   upward (bounded) so a second TUI lands on its own port with its own model
//   load instead of being stuck on Piper forever.
// - Readiness is GET /health: 200 = ready, 503 = still loading or failed. The
//   sidecar answers 503 with the real reason ("chatterbox-tts not installed"),
//   so we can fail fast with an actionable message instead of waiting out the
//   whole timeout on an install that will never succeed.
// - stop() only ever signals the handle this client spawned.
// - Every failure is a typed {code, message}, never a silent return of nothing:
//   the caller turns it into a per-utterance Piper fallback.
//
// This client is an OPTIMIZATION. Piper is the default engine and stays the
// zero-setup fallback, so every failure path here ends in Piper, never silence.

import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { vieneuSupportsLang } from "./vieneu-server.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8120;
const DEFAULT_PORT_SCAN_MAX = 4;
// Model load on first run also downloads weights from HuggingFace, so the
// readiness budget is generous. It is a bound, not a promise: a failed load
// reports immediately via the 503 body instead of waiting this out.
const READY_TIMEOUT_MS = 300000;
const READY_POLL_MS = 500;
// One utterance must never stall speech indefinitely.
const SYNTHESIZE_TIMEOUT_MS = 15000;

const SIDECAR_PATH = fileURLToPath(new URL("../vendor/chatterbox_server.py", import.meta.url));

export const CHATTERBOX_VARIANTS = ["multilingual", "turbo", "nano"];
export const DEFAULT_CHATTERBOX_VARIANT = "multilingual";

// Per-variant language support, read off the real package
// (chatterbox-tts 0.1.7) rather than guessed.
//
// MEASURED, and worth stating plainly: the multilingual model speaks 23
// languages and Vietnamese is NOT one of them. Its generate() raises
// ValueError on language_id "vi". Nano/Turbo are English-only by design. So
// every variant routes a vi utterance to Piper, and Chatterbox covers English.
// Do not "fix" this by adding "vi" here - it would fail at synthesis time.
const CHATTERBOX_LANGUAGES = {
  multilingual: new Set([
    "ar",
    "da",
    "de",
    "el",
    "en",
    "es",
    "fi",
    "fr",
    "he",
    "hi",
    "it",
    "ja",
    "ko",
    "ms",
    "nl",
    "no",
    "pl",
    "pt",
    "ru",
    "sv",
    "sw",
    "th",
    "tr",
    "zh",
  ]),
  turbo: new Set(["en"]),
  nano: new Set(["en"]),
};

export function isChatterboxVariant(value) {
  return CHATTERBOX_VARIANTS.includes(value);
}

// Can this variant speak this language? Unknown variants answer false, which
// routes to Piper - the safe default, since Piper always has an answer.
export function chatterboxSupportsLang(variant, lang) {
  const set = CHATTERBOX_LANGUAGES[variant];
  return !!set && set.has(lang);
}

// The one routing decision, pure and exported so it can be tested without a
// sidecar, a model, or an audio device. Returns the engine to use plus the
// reason, which the caller logs (and which keeps per-utterance skips quiet in
// the UI - no toast spam for a language Piper can already read).
export function resolveTtsEngine(opts, lang, warn) {
  const configured = opts?.ttsEngine;
  if (!configured || configured === "piper") return { engine: "piper", reason: "default" };
  if (configured === "vieneu") {
    if (vieneuSupportsLang(lang)) return { engine: "vieneu", reason: "ok" };
    warn?.(`VieNeu-TTS cannot speak "${lang}" - using Piper for this utterance`);
    return { engine: "piper", reason: "unsupported-language" };
  }
  if (configured !== "chatterbox") {
    warn?.(
      `Unknown ttsEngine "${configured}" - expected "piper", "chatterbox", or "vieneu"; using Piper`,
    );
    return { engine: "piper", reason: "unknown-engine" };
  }
  const requested = opts?.ttsChatterboxVariant;
  if (requested && !isChatterboxVariant(requested)) {
    warn?.(
      `Unknown ttsChatterboxVariant "${requested}" - expected ${CHATTERBOX_VARIANTS.join(" | ")}; using "${DEFAULT_CHATTERBOX_VARIANT}"`,
    );
  }
  const variant = isChatterboxVariant(requested) ? requested : DEFAULT_CHATTERBOX_VARIANT;
  if (chatterboxSupportsLang(variant, lang)) return { engine: "chatterbox", variant, reason: "ok" };
  warn?.(`Chatterbox variant "${variant}" cannot speak "${lang}" - using Piper for this utterance`);
  return { engine: "piper", reason: "unsupported-language", variant };
}

export function buildChatterboxArgs({ scriptPath, host, port, variant }) {
  return [
    scriptPath || SIDECAR_PATH,
    "--host",
    host || DEFAULT_HOST,
    "--port",
    String(port || DEFAULT_PORT),
    "--variant",
    variant || DEFAULT_CHATTERBOX_VARIANT,
  ];
}

export { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_PORT_SCAN_MAX, SIDECAR_PATH };

export function createChatterboxClient(options = {}) {
  const {
    host = DEFAULT_HOST,
    python,
    variant = DEFAULT_CHATTERBOX_VARIANT,
    voiceRef,
    exaggeration,
    cfgWeight,
    logger,
    readyTimeoutMs = READY_TIMEOUT_MS,
    readyPollMs = READY_POLL_MS,
    synthesizeTimeoutMs = SYNTHESIZE_TIMEOUT_MS,
    portScanMax = DEFAULT_PORT_SCAN_MAX,
    deps = {},
  } = options;
  const scriptPath = options.scriptPath || SIDECAR_PATH;
  const spawnFn = deps.spawn ?? spawn;
  const fetchFn = deps.fetch ?? fetch;

  let proc = null;
  let ready = false;
  let ownerPid = null;
  // Where the port scan starts. The plugin never sets it (so production always
  // begins at 8120), but tests bind an ephemeral port and need to reach it.
  const basePort = options.port ?? DEFAULT_PORT;
  let boundPort = basePort;
  let lastError = null;
  let device = "unknown";
  // A missing reference wav must not kill the whole engine - the sidecar still
  // speaks with its default voice, which is better than falling back to Piper.
  let refPath = voiceRef ? String(voiceRef).replace(/^~(?=\/|$)/, os.homedir()) : "";
  if (refPath && !fs.existsSync(refPath)) {
    logger?.log(
      "VOICE",
      `Chatterbox voice reference not found, using default voice: ${refPath}`,
      "warn",
    );
    refPath = "";
  }

  const baseUrlFor = (p) => `http://${host}:${p}`;

  async function portResponds(p) {
    const base = baseUrlFor(p);
    for (const url of [`${base}/health`, base]) {
      try {
        const resp = await fetchFn(url, { signal: AbortSignal.timeout(1500) });
        if (resp) return true;
      } catch {
        // Connection refused / timeout: try the next URL.
      }
    }
    return false;
  }

  // One probe. "ready" | "loading" | {failed: message} | "down". The failed
  // shape carries the sidecar's own reason so start() can surface it verbatim.
  async function probeOnce() {
    try {
      const resp = await fetchFn(`${baseUrlFor(boundPort)}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!resp) return "down";
      if (resp.status === 503) {
        let body = {};
        try {
          body = await resp.json();
        } catch {
          // Non-JSON 503: treat as still loading rather than guessing.
        }
        if (body?.phase === "failed") return { failed: body?.error || "model load failed" };
        return "loading";
      }
      if (resp?.ok) {
        try {
          const body = await resp.json();
          if (body?.device) device = body.device;
        } catch {
          // 200 with an unparseable body still means the port answered /health.
        }
        return "ready";
      }
      return "down";
    } catch {
      return "down";
    }
  }

  async function pollReady(deadline) {
    while (Date.now() < deadline) {
      if (!proc) return { failed: "chatterbox sidecar exited before becoming ready" };
      const state = await probeOnce();
      if (state === "ready") return state;
      if (state?.failed) return state;
      await new Promise((r) => setTimeout(r, readyPollMs));
    }
    return "timeout";
  }

  // Attempt one port: probe, spawn, wait for readiness. stop() inside only ever
  // signals the handle spawned here.
  async function startOnPort(port) {
    boundPort = port;
    if (await portResponds(port)) {
      return {
        ok: false,
        code: "PORT_IN_USE",
        advancable: true,
        message: `Port ${port} already answers - not starting a second chatterbox sidecar`,
      };
    }
    const args = buildChatterboxArgs({ scriptPath, host, port, variant });
    const bin = python || "python3";
    try {
      proc = spawnFn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
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
    });
    proc.on("exit", (code) => {
      // A late event from a previous child must not wipe the current handle.
      if (proc !== owned) return;
      // Record why, so a sidecar that dies mid-session explains the Piper
      // fallback instead of reporting a bare "not ready". A deliberate stop()
      // already nulled proc, so it never reaches here.
      lastError = { code: "EXITED", message: `chatterbox sidecar exited (code=${code})` };
      proc = null;
      ready = false;
      ownerPid = null;
    });
    proc.on("error", (err) => {
      if (proc !== owned) return;
      logger?.log("VOICE", `chatterbox sidecar process error: ${err.message}`, "warn");
      proc = null;
      ready = false;
      ownerPid = null;
    });

    const outcome = await pollReady(Date.now() + readyTimeoutMs);
    if (outcome !== "ready") {
      const tail = stderr.trim().slice(-300);
      const message =
        outcome === "timeout"
          ? `chatterbox sidecar did not become ready in time (${readyTimeoutMs}ms) stderr=${tail}`
          : `chatterbox sidecar unavailable: ${outcome.failed ?? "unknown"}`;
      const code = outcome === "timeout" ? "START_TIMEOUT" : "MODEL_LOAD_FAILED";
      stop();
      return { ok: false, code, advancable: false, message };
    }
    ownerPid = proc?.pid ?? null;
    return { ok: true };
  }

  async function start() {
    if (proc && ready) return true; // reuse the owned, already-ready sidecar
    const scanMax = Math.max(1, Math.floor(portScanMax) || 1);
    for (let i = 0; i < scanMax; i += 1) {
      const port = basePort + i;
      const r = await startOnPort(port);
      if (r.ok) {
        ready = true;
        lastError = null;
        logger?.log(
          "VOICE",
          `chatterbox sidecar ready at ${baseUrlFor(boundPort)} variant=${variant} device=${device} pid=${ownerPid}`,
          "debug",
        );
        return true;
      }
      if (!r.advancable) {
        lastError = { code: r.code, message: r.message };
        logger?.log("VOICE", r.message, "warn");
        return false;
      }
      logger?.log("VOICE", r.message, "warn");
    }
    lastError = {
      code: "PORT_RANGE_EXHAUSTED",
      message: `No free port in ${basePort}..${basePort + scanMax - 1} - all answer, using Piper`,
    };
    logger?.log("VOICE", lastError.message, "warn");
    return false;
  }

  // One-shot health read, for callers that want to report the engine's state
  // (and for tests). Returns {ok, variant, device, phase, error?}.
  async function health() {
    try {
      const resp = await fetchFn(`${baseUrlFor(boundPort)}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      const body = await resp.json();
      return body;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // Synthesize one utterance. Returns {ok:true, wav:Buffer} or
  // {ok:false, code, message} - never throws, so the caller always has a Piper
  // fallback available. options.signal lets a cancel abort the in-flight request
  // (the sidecar finishes its own generation and discards the result; the
  // caller's generation guard is what actually prevents stale playback).
  async function synthesize(text, languageId, opts = {}) {
    if (!ready) {
      return {
        ok: false,
        code: lastError?.code || "NOT_READY",
        message: lastError?.message || "chatterbox sidecar not ready",
      };
    }
    const body = {
      text,
      language_id: languageId || undefined,
      exaggeration: opts.exaggeration ?? exaggeration ?? undefined,
      cfg_weight: opts.cfgWeight ?? cfgWeight ?? undefined,
      voice_ref: refPath || undefined,
    };
    try {
      // One utterance must never stall speech indefinitely: bound the request,
      // and let an outer cancel abort it too. On timeout we fall back to
      // Piper for THIS utterance only - the sidecar stays up.
      const timeout = AbortSignal.timeout(synthesizeTimeoutMs);
      const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
      const resp = await fetchFn(`${baseUrlFor(boundPort)}/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!resp?.ok) {
        let message = `chatterbox sidecar responded ${resp?.status}`;
        try {
          const data = await resp.json();
          if (data?.error) message = data.error;
        } catch {
          // Keep the status-based message.
        }
        return { ok: false, code: "BAD_STATUS", message };
      }
      const audio = Buffer.from(await resp.arrayBuffer());
      if (audio.length === 0) {
        return { ok: false, code: "EMPTY_AUDIO", message: "chatterbox returned no audio" };
      }
      return { ok: true, wav: audio };
    } catch (err) {
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      return {
        ok: false,
        code: timedOut ? "SYNTH_TIMEOUT" : "REQUEST_FAILED",
        message: `chatterbox synthesis failed: ${err.message}`,
      };
    }
  }

  // Stop ONLY the process this client spawned (by handle). A foreign process
  // on the same port is never signaled.
  function stop() {
    ready = false;
    ownerPid = null;
    if (proc) {
      const owned = proc;
      proc = null;
      try {
        owned.kill("SIGTERM");
      } catch {
        // Already gone.
      }
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

  return { start, stop, health, synthesize, isRunning, getLastError, getPort };
}
