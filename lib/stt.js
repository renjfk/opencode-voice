// Speech-to-text: sox recording, whisper-cpp or API transcription, LLM normalization.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync, execSync } from "node:child_process";
import { createBatchStatus } from "./shared/batch-status.js";
import { getSttEngine, getGipformerConfig, transcribeFileGipformer } from "./stt/gipformer.js";

import { getActiveSessionTitle, getRecentConversationContext } from "./shared/session.js";
import { sttLog } from "./shared/stt-log.js";
import { wrapPcmAsWav } from "./stt/audio-chunker.js";
import {
  parseSilenceWindows as parseSpeechSilences,
  planChunkSpans,
  wavDurationSecFromBuffer,
  BATCH_CHUNK_MAX_SEC,
} from "./stt/audio-chunker.js";

let batchStatus = null;
let remoteBatchCapture = null;
let remotePcmFile = null;
let sttPluginOpts = {};

// ---- Audio / remote helpers (relocated to lib/stt/audio.js and lib/stt/remote.js) ----
import {
  __setPluginKv as __setAudioPluginKv,
  __setPluginOpts as __setAudioPluginOpts,
  __setAudioSampleRate as __setAudioSampleRateImpl,
  getAudioSampleRate,
  detectAudioBackend,
  isWSL,
  buildAudioHint,
  buildRecordArgs,
  audioFailureSuffix,
} from "./stt/audio.js";
import {
  __setPluginKv as __setRemotePluginKv,
  __setPluginOpts as __setRemotePluginOpts,
  __setSttCaptureCmd as __setRemoteSttCaptureCmd,
  __setAudioSampleRate as __setRemoteAudioSampleRate,
  getRemoteConfig,
  buildRemoteCaptureCmd,
  buildRemotePlayCmd,
  getSttCaptureCmd,
} from "./stt/remote.js";
import { createSttContext } from "./stt/context.js";
import { createControllerMethods } from "./stt/controller.js";
import { createCommands } from "./stt/commands.js";
import { resolveSttAutoSubmit } from "./shared/auto-submit.js";

// Re-exports so existing imports (tests, live-notes, streaming-stt, tts) keep
// working without edits.
export {
  getRemoteConfig,
  buildRemoteCaptureCmd,
  buildRemotePlayCmd,
  getAudioSampleRate,
  getSttCaptureCmd,
  detectAudioBackend,
  isWSL,
  buildAudioHint,
  buildRecordArgs,
  audioFailureSuffix,
};
export function __setSttCaptureCmd(cmd) {
  __setRemoteSttCaptureCmd(cmd);
}
export function __setAudioSampleRate(rate) {
  __setAudioSampleRateImpl(rate);
  __setRemoteAudioSampleRate(rate);
}

let sttApiEndpoint = null;
let sttApiModel = null;
let sttApiKeyEnv = null;

const WAV_FILENAME = "opencode-stt.wav";
let tmpDir = "/tmp";

const MODELS_DIRS = [
  path.join(os.homedir(), ".local", "share", "whisper-cpp"),
  "/opt/homebrew/share/whisper-cpp/models",
  "/usr/local/share/whisper-cpp/models",
];

const MODELS = {
  "large-v3-turbo-q5_0": {
    label: "Large v3 Turbo Q5 (recommended)",
    file: "ggml-large-v3-turbo-q5_0.bin",
  },
  "large-v3-turbo-q8_0": { label: "Large v3 Turbo Q8", file: "ggml-large-v3-turbo-q8_0.bin" },
  "large-v3-turbo": { label: "Large v3 Turbo (full)", file: "ggml-large-v3-turbo.bin" },
  "medium-q5_0": { label: "Medium Q5 (multilingual, faster)", file: "ggml-medium-q5_0.bin" },
  "small.en": { label: "Small English", file: "ggml-small.en.bin" },
  small: { label: "Small Multilingual", file: "ggml-small.bin" },
  "base.en": { label: "Base English", file: "ggml-base.en.bin" },
  base: { label: "Base Multilingual", file: "ggml-base.bin" },
  "tiny.en": { label: "Tiny English (fastest)", file: "ggml-tiny.en.bin" },
  tiny: { label: "Tiny Multilingual (fastest)", file: "ggml-tiny.bin" },
};
const DEFAULT_MODEL = "large-v3-turbo-q5_0";

const DEFAULT_LANGUAGE = "auto";
// Curated subset for the /stt-language picker; options.sttLanguage accepts any
// whisper.cpp language code.
const LANGUAGES = {
  auto: { label: "Auto-detect" },
  en: { label: "English" },
  zh: { label: "Chinese" },
  yue: { label: "Cantonese" },
  ja: { label: "Japanese" },
  ko: { label: "Korean" },
  de: { label: "German" },
  fr: { label: "French" },
  es: { label: "Spanish" },
  pt: { label: "Portuguese" },
  ru: { label: "Russian" },
  it: { label: "Italian" },
};
let sttDefaultLanguage = DEFAULT_LANGUAGE;
// Bounds for the recent-turns knowledge block sent with normalization.
let sttContextMessages = 8;
let sttContextChars = 3000;
// interpretive (default): fix misheard words using context; strict: transcribe exactly.
let sttNormalizeMode = "interpretive";
// Worst-case budget for one normalize/correction call; on timeout the raw
// transcript is used so a stalled LLM never blocks the turn. 45s: reasoning
// models (muse-spark) routinely take 20-30s on a short repair prompt.
let sttNormalizeTimeoutMs = 45000;

// Pronouns, demonstratives, and capitalized words signal that the transcript
// may reference the conversation (he/she/Cristina/...). Without them the
// knowledge block only adds input tokens, so it is skipped.

const CONTEXT_SIGNALS =
  /\b(he|him|his|she|her|hers|they|them|their|it|its|this|that|these|those|anh|chị|em|cô|chú|bác|ông|bà|nó|họ|này|kia|đó|ấy)\b|[A-ZÀ-ỴĐ][a-zà-ỹ]{1,}/u;

export function needsContext(rawText) {
  if (!rawText || rawText.length < 3) return false;
  return CONTEXT_SIGNALS.test(rawText);
}

// Prefetched conversation context, kicked off while the user is still
// speaking so the fetch usually finishes before the turn ends.

let prefetchedContext = null; // { at, sessionID, promise }

function currentRouteSessionID(api) {
  const route = api?.route?.current;
  const fromRoute = route?.name === "session" ? route?.params?.sessionID || null : null;
  if (fromRoute) return fromRoute;
  // Home screen / dialog route: the gateway still needs a session id, so ask
  // the host for the most recent one (v2 exposes it; v1 falls through).
  try {
    return api?.state?.session?.currentID?.() || null;
  } catch {
    return null;
  }
}

async function fetchContextParts(client, api) {
  const [sessionTitle, recent] = await Promise.all([
    getActiveSessionTitle(client),
    getRecentConversationContext(client, api, {
      maxMessages: sttContextMessages,
      maxChars: sttContextChars,
    }),
  ]);
  return { sessionTitle, recent };
}

function prefetchContextParts(client, api) {
  try {
    prefetchedContext = {
      at: Date.now(),
      sessionID: currentRouteSessionID(api),
      promise: fetchContextParts(client, api),
    };
  } catch {
    prefetchedContext = null;
  }
}

export function isOpenRouterEndpoint(endpoint) {
  return /(^https?:\/\/)?([^/]+\.)?openrouter\.ai(\/|$)/i.test(endpoint || "");
}

function buildMultipartTranscriptionRequest(model, audioBuffer, apiKey) {
  const blob = new Blob([audioBuffer], { type: "audio/wav" });
  const form = new FormData();
  form.append("file", blob, "audio.wav");
  form.append("model", model);
  form.append("response_format", "json");

  const headers = {};
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

  return {
    headers,
    body: form,
  };
}

export function buildOpenRouterTranscriptionRequest(model, audioBuffer, apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

  const payload = {
    model,
    input_audio: {
      data: audioBuffer.toString("base64"),
      format: "wav",
    },
  };

  return {
    headers,
    body: JSON.stringify(payload),
  };
}

function getModelsDir() {
  for (const dir of MODELS_DIRS) {
    if (fs.existsSync(dir)) return dir;
  }
  return MODELS_DIRS[0];
}

// ---- Recording state and control ----

let soxProc = null;
let soxStderr = "";
let recording = false;
let processing = false;
// Invalidated by cancelRecording/discardTurn: a cancel landing between
// LLM normalization and transcript-insert must prevent the stale text from
// landing afterwards. Checked in doTranscribePipeline before any append.
let pipelineGeneration = 0;

// ---- Conversation-mode hooks (wired by index.js) ----
// When voice conversation is active, the plain record/submit keys defer to the
// conversation loop instead of running the one-shot pipeline.

let conversationHooks = { isActive: null, onKey: null };
let conversationStreamingEnabled = false;
let conversationStreamingStopSec = null;
let conversationStreamingOnStopped = null;

export function __setConversationHooks(hooks) {
  conversationHooks = { ...conversationHooks, ...hooks };
}

function conversationActive() {
  try {
    return conversationHooks.isActive?.() === true;
  } catch {
    return false;
  }
}

// Live notes owns the microphone continuously while recording; one-shot and
// conversation-mode STT must stay out of the way while it is active.

let liveNotesHooks = { isActive: null };

export function __setLiveNotesHooks(hooks) {
  liveNotesHooks = { ...liveNotesHooks, ...hooks };
}

function liveNotesActive() {
  try {
    return liveNotesHooks.isActive?.() === true;
  } catch {
    return false;
  }
}

// Read-only guards for other modes (live notes) to check before starting,
// and for one-shot/conversation to refuse while live notes owns the mic.

export function isSttBusy() {
  return recording || processing;
}

// ---- Streaming dictation mode (stage 2) ----
// `sttMode: "batch"` (default) preserves the one-shot pipeline exactly.
// `sttMode: "streaming"` selects live local dictation (no LLM, zero quota).

let streamingDictationActive = false;

export function isStreamingActive() {
  return streamingDictationActive;
}

export function __setStreamingActive(v) {
  streamingDictationActive = !!v;
}

export const STREAMING_MODE_DEFAULTS = {
  windowMs: 10000,
  cadenceMs: 1000,
};

export function resolveSttMode(opts, kv = null) {
  // kv wins when set: the v2 host has been observed delivering only a
  // subset of file-plugin options, so a persisted choice must override.
  try {
    const saved = kv?.get("stt.mode");
    if (saved === "streaming" || saved === "batch") return saved;
  } catch {}
  return opts?.sttMode === "streaming" ? "streaming" : "batch";
}

export { resolveSttAutoSubmit } from "./shared/auto-submit.js";

export function resolveStreamTimings(opts) {
  const windowMs =
    Number(opts?.sttStreamWindowMs) > 0
      ? Math.floor(Number(opts.sttStreamWindowMs))
      : STREAMING_MODE_DEFAULTS.windowMs;
  const cadenceMs =
    Number(opts?.sttStreamStepMs) > 0
      ? Math.floor(Number(opts.sttStreamStepMs))
      : STREAMING_MODE_DEFAULTS.cadenceMs;
  return { windowMs, cadenceMs };
}

// Warm-lease policy for streaming dictation (stage-2 follow-up): the shared
// whisper-server lease stays loaded across finalize/cancel and is released
// only when the server itself is at fault, on model/language change, or on
// plugin unload. Per-dictation failures (capture/mic) preserve the lease.

// Error codes where the mic/capture failed but the server is healthy.
const STREAMING_PER_DICTATION_CODES = new Set([
  "CAPTURE_FAILED",
  "CAPTURE_SPAWN_ENOENT",
  "CAPTURE_SPAWN_FAILED",
  "CAPTURE_SPAWN_ERROR",
  "CAPTURE_EXITED",
  "AUDIO_SPOOL_OVERFLOW",
]);

export function isStreamingServerFault(err) {
  if (!err) return false;
  const code = typeof err === "string" ? null : err?.code || null;
  if (code && STREAMING_PER_DICTATION_CODES.has(code)) return false;
  const message = typeof err === "string" ? err : err?.message || "";
  if (/^capture|^sox|^mic/i.test(message || "")) return false;
  // Any explicit error object/string beyond per-dictation capture faults is
  // treated as server-side (NOT_READY, START_TIMEOUT, PORT_IN_USE,
  // SERVER_BINARY_MISSING, BAD_STATUS, REQUEST_FAILED, STOP_NOT_READY,
  // STOP_FINAL_TIMEOUT, TRANSCRIBE_*). Absence of error means healthy.
  return true;
}

export function streamModelKey(modelPath, language, port) {
  const base = `${modelPath || ""}::${language || "auto"}`;
  // The bound whisper-server port is part of the warm-lease identity: two
  // TUIs are separate processes (no shared state), but within one process
  // leases on different ports must not be mistaken for each other. Omitted
  // port keeps the legacy "model::language" form.
  return port === undefined || port === null ? base : `${base}::${port}`;
}

export function getSttApiConfig() {
  return sttApiEndpoint && sttApiModel
    ? { endpoint: sttApiEndpoint, model: sttApiModel, apiKeyEnv: sttApiKeyEnv }
    : null;
}

export function getTmpDir() {
  return tmpDir;
}

// ---- Sticky recording toast (Option A: polling to simulate persistence) ----
// ---- Sticky processing toast (Transcribing... / Normalizing...) ----
// Single-shot toasts (duration 3000ms) expire long before whisper/LLM finish,
// leaving a silent gap where the user thinks STT died. Poll like the recording
// toast so the stage stays visible until it completes.

let processingToastTimer = null;
let processingToastFn = null;
let processingMessage = "";
const PROCESSING_TOAST_DURATION = 3000;
const PROCESSING_TOAST_INTERVAL = 2500;

let recordingToastTimer = null;
let recordingToastFn = null;
const RECORDING_TOAST_BASE = "● Recording";
const RECORDING_TOAST_DURATION = 3000;
const RECORDING_TOAST_INTERVAL = 2500;
// Live wave + timer config (PR2)
let recordingStartMs = null;
let prevWaveLevels = [];
let noiseFloorRms = null;
let calibrationEndMs = null;
const WAVE_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const WAVE_LEN = 16;
const WAVE_INTERVAL = 35;
const WAVE_DURATION = 70;
let useWave = true;
// v2's toast API has no update/replace: every call stacks as a new
// notification, so the v1 polling pattern becomes a toast storm. v2 shows
// live state in the slot preview instead and uses one-shot toasts.
let toastPolling = true;

export function __setToastPolling(v) {
  toastPolling = !!v;
}

export function __setRecordingToastFn(fn) {
  recordingToastFn = fn;
}

export function __clearRecordingToastState() {
  if (recordingToastTimer) {
    clearInterval(recordingToastTimer);
    recordingToastTimer = null;
  }
  recordingToastFn = null;
  recordingStartMs = null;
  prevWaveLevels = [];
  noiseFloorRms = null;
  calibrationEndMs = null;
}

export function __setUseWave(v) {
  useWave = !!v;
}

export function isRecordingToastActive() {
  return recordingToastTimer !== null;
}

export function __setProcessingToastFn(fn) {
  processingToastFn = fn;
}

export function __clearProcessingToastState() {
  if (processingToastTimer) {
    clearInterval(processingToastTimer);
    processingToastTimer = null;
  }
  processingToastFn = null;
  processingMessage = "";
}

export function isProcessingToastActive() {
  return processingToastTimer !== null;
}

export function showProcessingToast(message) {
  clearProcessingToast();
  processingMessage = message;
  if (!processingToastFn) return;
  processingToastFn({
    message: processingMessage,
    variant: "info",
    duration: PROCESSING_TOAST_DURATION,
  });
  if (!toastPolling) return;
  processingToastTimer = setInterval(() => {
    if (processingToastFn) {
      processingToastFn({
        message: processingMessage,
        variant: "info",
        duration: PROCESSING_TOAST_DURATION,
      });
    }
  }, PROCESSING_TOAST_INTERVAL);
}

export function updateProcessingToast(message) {
  if (!isProcessingToastActive()) {
    showProcessingToast(message);
    return;
  }
  processingMessage = message;
  if (processingToastFn) {
    processingToastFn({
      message: processingMessage,
      variant: "info",
      duration: PROCESSING_TOAST_DURATION,
    });
  }
}

export function clearProcessingToast() {
  if (processingToastTimer) {
    clearInterval(processingToastTimer);
    processingToastTimer = null;
  }
}

// ---- Sticky streaming status (never-silent dictation) ----
// Streaming dictation previously showed one 3s toast on start, then silence
// until the next partial/finalize - long cold loads and slow ticks read as
// crashes. This reuses the polling-toast pattern above: one sticky status,
// re-emitted before the single-shot duration expires, with an elapsed timer
// so every state (loading / live / finalizing) stays visibly alive.
// Partial preview toasts (🎙 ...) continue alongside, not instead.
// Privacy-safe: elapsed time + state words only, never audio paths/secrets.

let streamingToastTimer = null;
let streamingToastFn = null;
let streamingToastBase = "";
let streamingToastStartMs = null;
let streamingLastPartialMs = null;
let lastPartialText = null;
let lastAudioActiveMs = null;
let streamingSlowAfterMs = 2000;
const STREAMING_TOAST_DURATION = 3000;
const STREAMING_TOAST_INTERVAL = 2500;

export function __setStreamingToastFn(fn) {
  streamingToastFn = fn;
}

export function __clearStreamingToastState() {
  if (streamingToastTimer) {
    clearInterval(streamingToastTimer);
    streamingToastTimer = null;
  }
  streamingToastFn = null;
  streamingToastBase = "";
  streamingToastStartMs = null;
  streamingLastPartialMs = null;
  lastAudioActiveMs = null;
  lastPartialText = null;
}

export function isStreamingToastActive() {
  return streamingToastTimer !== null;
}

function buildStreamingMessage() {
  const elapsed =
    streamingToastStartMs === null ? "00:00" : formatElapsed(Date.now() - streamingToastStartMs);
  let message = `${streamingToastBase} · ${elapsed}`;
  // Slow-tick note: no partial for ~2x cadence while live - the mic is fine,
  // the inference is just slow. Trivially detectable via last-partial time.
  if (
    streamingLastPartialMs !== null &&
    Date.now() - streamingLastPartialMs > streamingSlowAfterMs
  ) {
    message += " (listening…)";
  }
  return message;
}

function emitStreamingToast() {
  if (!streamingToastFn) return;
  streamingToastFn({
    message: buildStreamingMessage(),
    variant: "info",
    duration: STREAMING_TOAST_DURATION,
  });
}

/**
 * @param {string} message
 * @param {{slowAfterMs?: number}} [opts]
 */
export function showStreamingToast(message, { slowAfterMs } = {}) {
  clearStreamingToast();
  streamingToastBase = message;
  streamingToastStartMs = Date.now();
  streamingLastPartialMs = null;
  lastAudioActiveMs = null;
  lastPartialText = null;
  if (Number(slowAfterMs) > 0) streamingSlowAfterMs = Math.floor(Number(slowAfterMs));
  if (!streamingToastFn) return;
  sttLog("toast.streaming", `base=${streamingToastBase} polling=${toastPolling}`);
  emitStreamingToast();
  if (!toastPolling) return;
  streamingToastTimer = setInterval(() => {
    emitStreamingToast();
  }, STREAMING_TOAST_INTERVAL);
}

export function updateStreamingToast(message) {
  if (!isStreamingToastActive()) {
    showStreamingToast(message);
    return;
  }
  streamingToastBase = message;
  emitStreamingToast();
}

export function noteStreamingPartial(partial) {
  // Don't reset the silence timer if the partial is identical to the
  // previous one - whisper hallucinating on silence (repeating the same
  // phrase) must not keep the auto-end timer alive.
  const text = partial ? `${partial.stableText || ""} ${partial.tentativeText || ""}`.trim() : "";
  if (text && text === lastPartialText) return;
  lastPartialText = text;
  streamingLastPartialMs = Date.now();
}

export function clearStreamingToast() {
  if (streamingToastTimer) {
    clearInterval(streamingToastTimer);
    streamingToastTimer = null;
  }
  streamingToastBase = "";
  streamingToastStartMs = null;
  streamingLastPartialMs = null;
  lastAudioActiveMs = null;
}

export function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

export function rmsToChar(rms) {
  if (rms < 0.008) return WAVE_CHARS[0];
  if (rms < 0.018) return WAVE_CHARS[1];
  if (rms < 0.035) return WAVE_CHARS[2];
  if (rms < 0.06) return WAVE_CHARS[3];
  if (rms < 0.1) return WAVE_CHARS[4];
  if (rms < 0.16) return WAVE_CHARS[5];
  if (rms < 0.24) return WAVE_CHARS[6];
  return WAVE_CHARS[7];
}

export function rmsToLevel(rms) {
  if (rms < 0.008) return 0;
  if (rms < 0.018) return 1;
  if (rms < 0.035) return 2;
  if (rms < 0.06) return 3;
  if (rms < 0.1) return 4;
  if (rms < 0.16) return 5;
  if (rms < 0.24) return 6;
  return 7;
}

export function computeWaveChar() {
  // kept for tests / fallback single-char
  const wavFile = path.join(tmpDir, WAV_FILENAME);
  try {
    const data = fs.readFileSync(wavFile);
    if (data.length <= 44) return WAVE_CHARS[0];
    const windowSize = 2560;
    const start = Math.max(44, data.length - windowSize);
    const slice = data.subarray(start);
    const samples = Math.floor(slice.length / 2);
    if (samples === 0) return WAVE_CHARS[0];
    let sum = 0;
    for (let i = 0; i < slice.length - 1; i += 2) {
      const s = slice.readInt16LE(i);
      const n = s / 32768;
      sum += n * n;
    }
    const rms = Math.sqrt(sum / samples);
    if (rms < 0.003) return WAVE_CHARS[0];
    return rmsToChar(rms);
  } catch {
    return WAVE_CHARS[0];
  }
}

export function getWaveString() {
  // Fixed-column snapshot: each column = noise-gated RMS of sub-slice of last ~0.08s window
  const wavFile = path.join(tmpDir, WAV_FILENAME);
  try {
    let slice;
    try {
      const fd = fs.openSync(wavFile, "r");
      const stat = fs.fstatSync(fd);
      const fileSize = stat.size;
      if (fileSize <= 44) {
        fs.closeSync(fd);
        prevWaveLevels = Array(WAVE_LEN).fill(0);
        return WAVE_CHARS[0].repeat(WAVE_LEN);
      }
      const windowSize = 1024; // ~0.032s — ultra instant for toast
      const readSize = Math.min(windowSize, fileSize - 44);
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, fileSize - readSize);
      fs.closeSync(fd);
      slice = buf;
    } catch {
      const data = fs.readFileSync(wavFile);
      if (data.length <= 44) {
        prevWaveLevels = Array(WAVE_LEN).fill(0);
        return WAVE_CHARS[0].repeat(WAVE_LEN);
      }
      const windowSize = 1024;
      const start = Math.max(44, data.length - windowSize);
      slice = data.subarray(start);
    }
    const chunkBytes = Math.max(2, Math.floor(slice.length / WAVE_LEN));
    const rawRms = [];
    const levels = [];
    for (let c = 0; c < WAVE_LEN; c++) {
      const off = c * chunkBytes;
      const chunk = slice.subarray(off, Math.min(off + chunkBytes, slice.length));
      const samples = Math.floor(chunk.length / 2);
      if (samples === 0) {
        rawRms.push(0);
        continue;
      }
      let sum = 0;
      for (let i = 0; i < chunk.length - 1; i += 2) {
        const s = chunk.readInt16LE(i);
        const n = s / 32768;
        sum += n * n;
      }
      const rms = Math.sqrt(sum / samples);
      rawRms.push(rms);
    }
    // calibration: first 120ms estimates fan noise floor, but still show live wave
    const now = Date.now();
    if (calibrationEndMs && now < calibrationEndMs) {
      const minRms = Math.min(...rawRms);
      if (noiseFloorRms === null || minRms < noiseFloorRms) noiseFloorRms = minRms;
    }
    if (noiseFloorRms === null) noiseFloorRms = Math.min(...rawRms);
    else {
      // slowly adapt noise floor down (fan may vary) but never jump up quickly
      const minRms = Math.min(...rawRms);
      // if we see a consistently lower min for 500ms, drift down 5%
      noiseFloorRms = Math.min(noiseFloorRms, minRms);
      noiseFloorRms = noiseFloorRms * 0.995 + minRms * 0.005;
    }
    // console.log(`[wave] noiseFloor=${noiseFloorRms?.toFixed(4)} rawMin=${Math.min(...rawRms).toFixed(4)} rawMax=${Math.max(...rawRms).toFixed(4)}`);
    for (const rms of rawRms) {
      const effective = Math.max(0, rms - noiseFloorRms * 1.15);
      // gate: very small effective still flat — fan residue
      if (effective < 0.005) levels.push(0);
      else levels.push(rmsToLevel(effective * 1.6)); // 1.6x gain makes voice pop higher
    }
    // instant attack, very fast decay (0.2) → fan doesn't linger, voice explicit
    if (prevWaveLevels.length !== WAVE_LEN) prevWaveLevels = Array(WAVE_LEN).fill(0);
    const smoothed = levels.map((lvl, i) => {
      const prev = prevWaveLevels[i] || 0;
      if (lvl > prev) return lvl; // instant rise
      const decayed = Math.floor(prev * 0.2);
      return lvl > decayed ? lvl : decayed;
    });
    prevWaveLevels = smoothed.slice();
    return smoothed.map((l) => WAVE_CHARS[l]).join("");
  } catch {
    prevWaveLevels = Array(WAVE_LEN).fill(0);
    return WAVE_CHARS[0].repeat(WAVE_LEN);
  }
}

// ---- Streaming waveform (live transcript + wave) ----
// The batch meter samples a WAV file on disk; streaming keeps PCM in memory,
// so the controller exposes its newest tail instead. Same thresholds and
// noise-floor gating as the batch meter, with slightly slower decay because
// this samples at ~80 ms rather than ~35 ms.

const STREAM_WAVE_BYTES = 2560; // ~80 ms of 16 kHz mono 16-bit PCM
let streamWavePrev = [];
let streamNoiseFloor = null;

export function __resetStreamWave() {
  streamWavePrev = [];
  streamNoiseFloor = null;
}

export function waveLevelsFromPcm(pcm) {
  if (!pcm || pcm.length < 2) return Array(WAVE_LEN).fill(0);
  const chunkBytes = Math.max(2, Math.floor(pcm.length / WAVE_LEN));
  const raw = [];
  for (let column = 0; column < WAVE_LEN; column++) {
    const offset = column * chunkBytes;
    if (offset >= pcm.length) {
      raw.push(0);
      continue;
    }
    const chunk = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length));
    const samples = Math.floor(chunk.length / 2);
    if (samples === 0) {
      raw.push(0);
      continue;
    }
    let sum = 0;
    for (let i = 0; i + 1 < chunk.length; i += 2) {
      const sample = chunk.readInt16LE(i) / 32768;
      sum += sample * sample;
    }
    raw.push(Math.sqrt(sum / samples));
  }
  const floor = Math.min(...raw);
  if (streamNoiseFloor === null) streamNoiseFloor = floor;
  else streamNoiseFloor = Math.min(streamNoiseFloor, floor) * 0.995 + floor * 0.005;
  const levels = raw.map((rms) => {
    const effective = Math.max(0, rms - streamNoiseFloor * 1.15);
    if (effective < 0.005) return 0;
    return rmsToLevel(effective * 1.6);
  });
  if (streamWavePrev.length !== WAVE_LEN) streamWavePrev = Array(WAVE_LEN).fill(0);
  const smoothed = levels.map((level, index) => {
    const prev = streamWavePrev[index] || 0;
    if (level > prev) return level;
    const decayed = Math.floor(prev * 0.35);
    return level > decayed ? level : decayed;
  });
  streamWavePrev = smoothed;
  return smoothed;
}

let currentRecordKeybind = "<leader>[";
export function __setRecordKeybind(kb) {
  if (kb) currentRecordKeybind = kb.replace(/^<leader>/, "leader+");
}

// Temporary stop-hint override for voice conversation mode, whose key differs
// from stt.record. Pass null to restore the previous hint.

let savedRecordKeybind = null;
export function __setStopHint(hint) {
  if (hint) {
    if (savedRecordKeybind === null) savedRecordKeybind = currentRecordKeybind;
    __setRecordKeybind(hint);
  } else if (savedRecordKeybind !== null) {
    currentRecordKeybind = savedRecordKeybind;
    savedRecordKeybind = null;
  }
}
function recordingModeSuffix() {
  // When the conversation loop overrides the stop hint, the toast says so
  // explicitly - otherwise users wonder why it names a key they did not press.
  return savedRecordKeybind !== null ? " (conversation)" : "";
}

export function buildRecordingMessage() {
  const mode = recordingModeSuffix();
  if (!useWave || recordingStartMs === null)
    return `${RECORDING_TOAST_BASE}${mode} · ${currentRecordKeybind} to stop`;
  const elapsed = formatElapsed(Date.now() - recordingStartMs);
  const wave = getWaveString();
  return `${RECORDING_TOAST_BASE}${mode}  ${wave}  ${elapsed} · ${currentRecordKeybind} to stop`;
}

export function showRecordingToast() {
  clearRecordingToast();
  if (!recordingToastFn) return;
  sttLog("toast.recording", `polling=${toastPolling} wave=${useWave}`);
  recordingStartMs = Date.now();
  prevWaveLevels = Array(WAVE_LEN).fill(0);
  noiseFloorRms = null;
  calibrationEndMs = Date.now() + 120;
  if (!toastPolling) {
    recordingToastFn({
      message: `${RECORDING_TOAST_BASE}${recordingModeSuffix()} · ${currentRecordKeybind} to stop`,
      variant: "info",
      duration: RECORDING_TOAST_DURATION,
    });
    return;
  }
  const interval = useWave ? WAVE_INTERVAL : RECORDING_TOAST_INTERVAL;
  const duration = useWave ? WAVE_DURATION : RECORDING_TOAST_DURATION;
  recordingToastFn({
    message: buildRecordingMessage(),
    variant: "info",
    duration,
  });
  recordingToastTimer = setInterval(() => {
    if (recordingToastFn) {
      recordingToastFn({
        message: buildRecordingMessage(),
        variant: "info",
        duration,
      });
    }
  }, interval);
}

export function clearRecordingToast() {
  if (recordingToastTimer) {
    clearInterval(recordingToastTimer);
    recordingToastTimer = null;
  }
  recordingStartMs = null;
  noiseFloorRms = null;
  calibrationEndMs = null;
}

export function createRemoteBatchCapture(child, writer) {
  let bytes = 0;
  let stderr = "";
  let failure = null;
  let stopped = false;
  let closed = false;
  let flushed = false;
  let exitCode = null;
  let exitSignal = null;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  function settle() {
    if (!closed || !flushed) return;
    let error = failure;
    if (!error && exitCode === 255 && bytes === 0)
      error = "Remote audio transport failed (SSH exit 255)";
    if (!error && exitCode !== null && exitCode !== 0 && exitCode !== 255) {
      error = `Remote phone capture failed (exit ${exitCode})`;
    }
    if (!error && exitSignal && !stopped) error = `Remote capture interrupted (${exitSignal})`;
    if (!error && bytes === 0) error = "Remote capture received no PCM audio; check phone recorder";
    if (!error && bytes % 2 !== 0) error = "Remote capture received incomplete 16-bit PCM audio";
    resolveDone({ error, bytes, stderr, code: exitCode, signal: exitSignal });
  }
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    sttLog("STT", `remote capture chunk bytes=${chunk.length} total=${bytes}`);
  });
  child.stdout.on("error", (err) => {
    failure = `Remote audio read failed: ${err.message}`;
    child.kill("SIGTERM");
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4096);
  });
  child.on("error", (err) => {
    failure = `Remote capture failed to start: ${err.message}`;
  });
  writer.on("error", (err) => {
    failure = `Remote audio write failed: ${err.message}`;
    flushed = true;
    child.kill("SIGTERM");
    settle();
  });
  writer.on("finish", () => {
    flushed = true;
    settle();
  });
  // 'exit' can precede trailing stdout. Only 'close' guarantees child pipes
  // have drained; writer 'finish' separately guarantees all PCM reached disk.
  child.on("close", (code, signal) => {
    closed = true;
    exitCode = code;
    exitSignal = signal;
    if (!writer.writableEnded && !writer.destroyed) writer.end();
    settle();
  });
  child.stdout.pipe(writer);
  return {
    done,
    stop(_signal = "SIGINT") {
      stopped = true;
      // Do not kill the local SSH immediately; the caller sends a remote
      // TERM first and waits for capture.done so the current chunk can
      // finish and flush. Killing SSH here truncates the tail audio.
    },
  };
}

function forceKillSox(logger) {
  if (remoteBatchCapture) {
    try {
      remoteBatchCapture.stop("SIGKILL");
    } catch {}
    remoteBatchCapture = null;
  }
  if (soxProc) {
    try {
      process.kill(soxProc.pid, "SIGKILL");
      logger?.log("STT", `Killed sox pid=${soxProc.pid}`, "debug");
    } catch {}
    soxProc = null;
  }
}

function startRecording(
  kv,
  backend,
  toast,
  logger,
  trimSilence = true,
  silenceStopSec = null,
  onStopped = null,
) {
  if (soxProc) {
    logger?.log("STT", "Start recording skipped: sox already running", "debug");
    return;
  }

  const wavFile = path.join(tmpDir, WAV_FILENAME);
  forceKillSox(logger);
  try {
    fs.unlinkSync(wavFile);
  } catch {}

  soxStderr = "";
  const captureCmd = getSttCaptureCmd();
  const sampleRate = getAudioSampleRate();
  if (captureCmd) {
    const pcmFile = path.join(tmpDir, `opencode-stt-${process.pid}-${Date.now()}.pcm`);
    try {
      fs.unlinkSync(pcmFile);
    } catch {}
    soxStderr = "";
    const spawnT0 = Date.now();
    sttLog("STT", "Starting remote batch capture");
    const ws = fs.createWriteStream(pcmFile, { flags: "a" });
    soxProc = spawn(captureCmd[0], captureCmd.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const child = soxProc;
    const capture = createRemoteBatchCapture(child, ws);
    remoteBatchCapture = capture;
    // Silence auto-end for remote capture (conversation/manual auto-end).
    if (silenceStopSec && silenceStopSec > 0) {
      let lastActiveMs = null;
      child.stdout.on("data", (chunk) => {
        let sum = 0;
        let samples = 0;
        for (let i = 0; i + 1 < chunk.length; i += 2) {
          const s = chunk.readInt16LE(i) / 32768;
          sum += s * s;
          samples++;
        }
        const rms = samples > 0 ? Math.sqrt(sum / samples) : 0;
        if (rms < 0.01) {
          if (lastActiveMs === null) lastActiveMs = Date.now();
        } else {
          lastActiveMs = null;
        }
        if (lastActiveMs && Date.now() - lastActiveMs > silenceStopSec * 1000) {
          sttLog("STT", "remote silence auto-stop triggered");
          try {
            child.kill("SIGTERM");
          } catch {}
        }
      });
    }
    capture.done.then((result) => {
      sttLog(
        "STT",
        `remote capture drained code=${result.code} signal=${result.signal} totalBytes=${result.bytes} elapsedMs=${Date.now() - spawnT0}`,
      );
      if (soxProc !== child) {
        // A newer capture took ownership; leave its state untouched.
        return;
      }
      soxProc = null;
      remoteBatchCapture = null;
      soxStderr = result.stderr;
      if (result.error) {
        sttLog(
          "STT",
          `remote capture failed: ${result.error} stderr=${(result.stderr || "").trim().slice(-200)}`,
        );
      }
      if (recording && !processing) {
        recording = false;
        clearRecordingToast();
        if (result.error) toast(result.error, "error");
        if (typeof onStopped === "function" && !result.error) {
          try {
            onStopped();
          } catch {}
        }
      }
    });
    // track pcm file for conversion in transcribeTurn via module var
    remotePcmFile = pcmFile;
    logger?.log(
      "STT",
      `remote capture spawned pid=${soxProc?.pid} after ${Date.now() - spawnT0}ms`,
      "debug",
    );
    recording = true;
    return;
  }

  const mic = kv.get("stt.mic", "") || null;
  const inputArgs = buildRecordArgs(backend, mic);
  const spawnT0 = Date.now();
  logger?.log(
    "STT",
    `Starting recording backend=${backend} mic=${mic || "system default"} silenceStop=${silenceStopSec ?? "off"}`,
    "debug",
  );

  // Trim leading silence, then (optionally) auto-stop after N seconds of
  // silence so hands-free modes (conversation) can finalize without a keypress.
  const silenceArgs = trimSilence ? ["silence", "1", "0.05", "1%"] : [];
  if (silenceStopSec && silenceStopSec > 0) {
    silenceArgs.push("1", String(silenceStopSec), "1%");
  }
  soxProc = spawn(
    "sox",
    [...inputArgs, "-r", String(sampleRate), "-c", "1", "-b", "16", wavFile, ...silenceArgs],
    {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
    },
  );
  logger?.log("STT", `sox spawned pid=${soxProc?.pid} after ${Date.now() - spawnT0}ms`, "debug");

  let firstStderrLogged = false;
  soxProc.stderr.on("data", (chunk) => {
    if (!firstStderrLogged) {
      firstStderrLogged = true;
      logger?.log("STT", `sox first output after ${Date.now() - spawnT0}ms`, "debug");
    }
    soxStderr += chunk.toString();
  });

  soxProc.on("error", (err) => {
    soxProc = null;
    logger?.log("STT", `Recording failed: ${err.message}`, "error");
    if (recording) {
      recording = false;
      clearRecordingToast();
      toast(`Recording failed: ${err.message}${audioFailureSuffix(backend)}`, "error");
    }
  });

  soxProc.on("exit", (code) => {
    soxProc = null;
    logger?.log(
      "STT",
      `sox exited code=${code} stderr=${soxStderr.trim()}`,
      code === 0 || code === null ? "debug" : "warn",
    );
    if (recording && !processing) {
      recording = false;
      clearRecordingToast();
      if (code !== 0 && code !== null) {
        const errLine = soxStderr.trim().split("\n").pop();
        toast(
          `Recording error: ${errLine || `sox exited (code=${code})`}${audioFailureSuffix(backend)}`,
          "error",
        );
      } else {
        // Normal exit (including silence auto-stop): fire the onStopped
        // callback if registered, otherwise show the generic toast.
        if (typeof onStopped === "function") {
          try {
            onStopped();
          } catch {}
        } else {
          toast("Recording stopped unexpectedly", "warning");
        }
      }
    }
  });

  recording = true;
}

function stopRecording(logger) {
  logger?.log("STT", "Stopping recording", "debug");
  if (remoteBatchCapture && soxProc) {
    // Ask the remote capture to finish its current chunk before SSH tears
    // down; SSH alone does not reliably forward signals without a PTY.
    try {
      const cfg = getRemoteConfig();
      const killCmd = `ssh -T -o BatchMode=yes -o ConnectTimeout=3 -i ${cfg.key} -p ${cfg.port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${cfg.host} 'pid=$(cat "$HOME/.cache/phone-audio-bridge/capture.pid" 2>/dev/null); if [ -n "$pid" ]; then kill -TERM "$pid" 2>/dev/null || true; fi'`;
      execSync(killCmd, { stdio: "ignore", timeout: 3000 });
    } catch {}
    remoteBatchCapture.stop();
  } else if (soxProc) {
    soxProc.kill("SIGINT");
  }
}

async function waitForSoxExit(logger, timeoutMs = 2000) {
  if (remoteBatchCapture) {
    const capture = remoteBatchCapture;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        try {
          if (soxProc) process.kill(soxProc.pid, "SIGKILL");
        } catch {}
        resolve({ error: "Remote capture shutdown timed out before PCM drain" });
      }, timeoutMs);
    });
    const result = await Promise.race([capture.done, timeout]);
    clearTimeout(timer);
    if (remoteBatchCapture === capture) remoteBatchCapture = null;
    return result;
  }
  const start = Date.now();
  while (soxProc && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (soxProc) {
    logger?.log("STT", "sox did not stop before timeout", "warn");
    forceKillSox(logger);
  }
}

function getModelName(kv) {
  const model = kv.get("stt.model", DEFAULT_MODEL);
  return MODELS[model] ? model : DEFAULT_MODEL;
}

export function getModelPath(kv) {
  return path.join(getModelsDir(), MODELS[getModelName(kv)].file);
}

export function getLanguage(kv) {
  return kv.get("stt.language") || sttDefaultLanguage;
}

export function buildWhisperArgs(modelPath, wavFile, language) {
  return [
    "-m",
    modelPath,
    "-f",
    wavFile,
    "-l",
    language || DEFAULT_LANGUAGE,
    "-np",
    "-nt",
    "-nth",
    "0.5",
  ];
}

// Transcribe an arbitrary WAV file with local whisper-cli. Generalized out of
// the one-shot `transcribe()` path so live notes can transcribe its own
// per-chunk WAV files with the same model/language resolution and error
// handling, without depending on the one-shot recording's tmpDir/state.

export function transcribeFileLocal(wavFile, modelPath, language, logger) {
  logger?.log(
    "STT",
    `Local transcription requested model=${modelPath} language=${language}`,
    "debug",
  );
  if (!fs.existsSync(modelPath)) {
    logger?.log("STT", `Whisper model missing: ${modelPath}`, "error");
    return Promise.resolve({
      error: `Model not found: ${modelPath}. Download from huggingface.co/ggerganov/whisper.cpp`,
    });
  }
  if (!fs.existsSync(wavFile)) {
    logger?.log("STT", `Recording file missing: ${wavFile}`, "error");
    return Promise.resolve({ error: "No recording file - sox may have failed to capture audio" });
  }
  if (fs.statSync(wavFile).size <= 44) {
    logger?.log("STT", `Recording file empty: ${wavFile}`, "warn");
    return Promise.resolve({ error: "Recording is empty - no audio captured" });
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn("whisper-cli", buildWhisperArgs(modelPath, wavFile, language), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    logger?.log("STT", `Started whisper-cli pid=${proc.pid}`, "debug");

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      logger?.log("STT", "whisper-cli timed out after 60s", "error");
      resolve({ error: "Transcription timed out (60s)" });
    }, 60000);

    proc.on("error", (err) => {
      clearTimeout(timer);
      logger?.log("STT", `whisper-cli error: ${err.message}`, "error");
      resolve({ error: `Transcription failed: ${err.message}` });
    });

    proc.on("exit", (code) => {
      clearTimeout(timer);
      // whisper-cli exits 0 even for an unknown language, printing the error to
      // stderr instead; surface it rather than reporting "no speech detected".
      const langError = stderr.match(/error: unknown language '([^']+)'/);
      if (langError) {
        logger?.log("STT", `whisper-cli rejected language: ${langError[1]}`, "error");
        resolve({ error: `Unknown whisper language: ${langError[1]}` });
        return;
      }
      if (code !== 0) {
        logger?.log("STT", `whisper-cli exited code=${code} stderr=${stderr.trim()}`, "error");
        resolve({ error: stderr.trim().split("\n").pop() || `whisper-cli exited (code=${code})` });
        return;
      }
      logger?.log("STT", `Local transcription succeeded stdoutChars=${stdout.length}`, "debug");
      resolve({
        text: stdout
          .replace(/\[.*?\]/g, "")
          .replace(/\(.*?\)/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      });
    });
  });
}

function transcribe(kv, logger) {
  const wavFile = path.join(tmpDir, WAV_FILENAME);
  if (getSttEngine(kv, sttPluginOpts) === "gipformer") {
    const cfg = getGipformerConfig(kv, sttPluginOpts);
    // Drop-in transcribeFn shape: chunked splitter passes (wav, model, lang,
    // logger); the transducer is Vietnamese-only so whisper model/lang args
    // are intentionally ignored inside the closure.
    return transcribeMaybeChunked(wavFile, cfg, null, logger, (w, _m, _l, log) =>
      transcribeFileGipformer(w, cfg, log),
    );
  }
  return transcribeMaybeChunked(wavFile, getModelPath(kv), getLanguage(kv), logger);
}

// Long recordings die two ways in a single whisper call: the 60s CLI timeout
// on slow machines, and one hallucinated paragraph nuking the whole turn.
// Past CHUNKED_MIN_SEC the file is split on silence (fixed windows when
// ffmpeg is absent) and each span is transcribed alone: a bad span costs
// only itself, survivors still join, and the progress toast ticks per span
// so a 70s turn never looks dead.
const CHUNKED_MIN_SEC = 45;

function wavFileDurationSec(wavFile) {
  try {
    return wavDurationSecFromBuffer(fs.readFileSync(wavFile));
  } catch {
    return 0;
  }
}

function detectSilenceWindows(wavFile, logger) {
  return new Promise((resolve) => {
    let stderr = "";
    let child;
    try {
      child = spawn("ffmpeg", [
        "-hide_banner",
        "-i",
        wavFile,
        "-af",
        "silencedetect=noise=-35dB:d=0.5",
        "-f",
        "null",
        "-",
      ]);
    } catch {
      resolve([]);
      return;
    }
    child.stderr?.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("error", () => resolve([]));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve([]);
    }, 15000);
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(parseSpeechSilences(stderr));
      } catch {
        resolve([]);
      }
    });
  });
}

function extractWavSpan(wavFile, start, dur, outPath, logger) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        String(start),
        "-t",
        String(dur),
        "-i",
        wavFile,
        "-c",
        "copy",
        outPath,
      ]);
    } catch (err) {
      resolve({ ok: false, error: err?.message || String(err) });
      return;
    }
    child.on("error", (err) => resolve({ ok: false, error: err?.message || String(err) }));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve({ ok: false, error: "chunk extract timed out" });
    }, 20000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outPath)) resolve({ ok: true });
      else resolve({ ok: false, error: `extract exited (${code})` });
    });
  });
}

export async function transcribeMaybeChunked(
  wavFile,
  modelPath,
  language,
  logger,
  transcribeFn = transcribeFileLocal,
) {
  const totalSec = wavFileDurationSec(wavFile);
  if (!(totalSec > CHUNKED_MIN_SEC)) {
    return transcribeFn(wavFile, modelPath, language, logger);
  }
  sttLog("STT", `long turn ${totalSec.toFixed(0)}s - chunked transcription`);
  const silences = await detectSilenceWindows(wavFile, logger);
  const spans = planChunkSpans(totalSec, silences, BATCH_CHUNK_MAX_SEC);
  if (spans.length <= 1) {
    return transcribeFn(wavFile, modelPath, language, logger);
  }
  const parts = [];
  let firstError = null;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    try {
      updateProcessingToast(`Transcribing part ${i + 1}/${spans.length}...`);
    } catch {}
    const chunkPath = path.join(tmpDir, `opencode-stt-chunk-${i}.wav`);
    const extracted = await extractWavSpan(wavFile, span.start, span.dur, chunkPath, logger);
    if (!extracted.ok) {
      if (!firstError) firstError = extracted.error;
      continue;
    }
    const r = await transcribeFn(chunkPath, modelPath, language, logger);
    try {
      fs.rmSync(chunkPath, { force: true });
    } catch {}
    if (r?.error) {
      if (!firstError) firstError = r.error;
      continue;
    }
    const text = (r?.text || "").trim();
    if (!text) continue;
    if (isLikelyHallucination(text)) {
      sttLog("STT", `chunk ${i + 1}/${spans.length} discarded as hallucination`);
      continue;
    }
    parts.push(text);
  }
  sttLog("STT", `chunked transcription kept ${parts.length}/${spans.length} spans`);
  if (parts.length) return { text: parts.join(" ") };
  if (firstError) return { error: firstError };
  return { text: "" };
}

export const STT_SYSTEM_PROMPT = `You are a DETERMINISTIC speech-to-text normalizer for a coding assistant CLI. You are NOT a chatbot. You NEVER answer, explain, greet back, or introduce yourself.

Task: Return ONLY what the user meant to say, cleaned up for use as their message. Fix what the speech recognizer misheard, not just punctuation. No reply. No extra sentences.

Strict rules:
- Output is the user's utterance, cleaned. It is NOT a response to the user.
- Fix punctuation, capitalization, grammar.
- Remove filler words (um, uh, like, you know, etc.).
- Keep technical terms, file names, and code references exact.
- If the user is dictating code, format it appropriately.
- INTERPRET misheard words: speech recognition often produces acoustically-close-but-wrong words ("they face" for "database", "bait" for "page"). Replace a word or short phrase ONLY when ALL of these hold: (1) it sounds similar to the replacement, (2) the <knowledge> conversation context or the domain lists below support the replacement, (3) the sentence makes clearly more sense with it. Otherwise leave the original words untouched.
- Use the <knowledge> conversation context to resolve ambiguous names, pronouns, references, AND misheard content words (that function, the file, it; e.g. Cristina uses he/him if the conversation says so) - never copy unrelated facts from the context into the output.
- Output ONLY the cleaned text, nothing else. No quotes, no prefixes, no suffixes.
- Do NOT add greetings, introductions, offers to help, questions, or commentary.
- Do NOT expand short inputs. Keep output length close to input length (within ~30%); do not add paragraphs or new requests the user did not make.
- If input is a short greeting/noise like "hey", "hello", "hi", "hey there", output exactly that greeting capitalized with a period (e.g., "hey" -> "Hey.") — DO NOT expand to "Hello! I am an AI..." or add self-introduction.

Examples (follow exactly):
Input: "hey"
Output: Hey.

Input: "hello there"
Output: Hello there.

Input: "umm add tests for the a sink user service"
Output: Add tests for the async user service.

Input: "check the locks for the doc container"
Output: Check the logs for the Docker container.

Input: "craft a notion bait tracking our work items"
Output: Craft a Notion page tracking our work items.

Input: "check the notion they face for the next phase target"
Output: Check the Notion database for the next phase target.

If you cannot normalize, return the input trimmed.

CRITICAL DOMAIN CORRECTIONS - Fix common STT homophone errors in software engineering contexts:
- "locks" -> "logs" (unless explicitly talking about mutexes/concurrency)
- "note" / "no" -> "node"
- "app and" -> "append"
- "sink" -> "sync"
- "a sink" -> "async"
- "doc" / "talker" -> "docker"
- "cash" -> "cache"
- "rap" -> "wrap"
- "Jason" -> "JSON"
- "get" -> "Git"
- "react" -> "React"
- "types creep" / "type script" -> "TypeScript"
- "bite" -> "byte"
- "string" -> "String"
- "int" -> "Int"
- "bullion" -> "boolean"

WORKFLOW VOCABULARY - the user works with these tools; prefer these terms when the transcript sounds similar:
- "bait" / "paid" -> "page" (in Notion contexts)
- "they face" / "data base" -> "database"
- "phase target" - keep as-is (not "face target")
- "master" - keep as-is (git branch, not "muster")
- "commit" - keep as-is (not "comet")
- "notion" - keep as-is (not "motion" / "ocean")

Rely heavily on context to fix words that sound similar to programming terminology.`;

// Strict mode: the old transcribe-exactly behavior (no reinterpretation).
// Opt in via "sttNormalizeMode": "strict".

export const STT_SYSTEM_PROMPT_STRICT = `You are a DETERMINISTIC speech-to-text normalizer for a coding assistant CLI. You are NOT a chatbot. You NEVER answer, explain, greet back, or introduce yourself.

Task: Return ONLY the cleaned version of the user's spoken words — exactly what they said, with punctuation and homophone fixes. No reply. No extra sentences.

Strict rules:
- Output is the user's utterance, cleaned. It is NOT a response to the user.
- Fix punctuation, capitalization, grammar minimally.
- Remove filler words (um, uh, like, you know, etc.).
- Keep technical terms, file names, and code references exact.
- If the user is dictating code, format it appropriately.
- Use the <knowledge> conversation context only to resolve ambiguous names, pronouns, and references (that function, the file, it; e.g. Cristina uses he/him if the conversation says so) — do not invent new content and never copy facts from the context into the output.
- Output ONLY the cleaned text, nothing else. No quotes, no prefixes, no suffixes.
- Do NOT add greetings, introductions, offers to help, questions, or commentary.
- Do NOT expand short inputs. Keep output length close to input length; do not add paragraphs.
- If input is a short greeting/noise like "hey", "hello", "hi", "hey there", output exactly that greeting capitalized with a period (e.g., "hey" -> "Hey.") — DO NOT expand to "Hello! I am an AI..." or add self-introduction.

Examples (follow exactly):
Input: "hey"
Output: Hey.

Input: "hello there"
Output: Hello there.

Input: "umm add tests for the a sink user service"
Output: Add tests for the async user service.

Input: "check the locks for the doc container"
Output: Check the logs for the Docker container.

If you cannot normalize, return the input trimmed.

CRITICAL DOMAIN CORRECTIONS - Fix common STT homophone errors in software engineering contexts:
- "locks" -> "logs" (unless explicitly talking about mutexes/concurrency)
- "note" / "no" -> "node"
- "app and" -> "append"
- "sink" -> "sync"
- "a sink" -> "async"
- "doc" / "talker" -> "docker"
- "cash" -> "cache"
- "rap" -> "wrap"
- "Jason" -> "JSON"
- "get" -> "Git"
- "react" -> "React"
- "types creep" / "type script" -> "TypeScript"
- "bite" -> "byte"
- "string" -> "String"
- "int" -> "Int"
- "bullion" -> "boolean"

Rely heavily on context to fix words that sound similar to programming terminology.`;

export function selectSttSystemPrompt(mode, custom) {
  if (custom) return custom;
  return mode === "strict" ? STT_SYSTEM_PROMPT_STRICT : STT_SYSTEM_PROMPT;
}

// Live notes: cleans ONE chunk of a continuous recording (meeting, lecture)
// into readable prose. Different job than STT_SYSTEM_PROMPT's "message to
// submit" framing - this is note-taking, so it must not shorten, summarize,
// or address anyone; it stays close to what was actually said.

export const NOTES_SYSTEM_PROMPT = `You are a DETERMINISTIC transcript cleaner for a live meeting/lecture note-taking tool. You are NOT a chatbot. You NEVER answer, summarize, or add commentary.

Task: Clean up ONE short segment of a continuous spoken recording (already split from a longer session) into readable, accurate prose for a written transcript.

Rules:
- Fix punctuation, capitalization, and speech-recognition mistakes (words that sound similar to the correct word), using the <knowledge> context (the tail of the immediately preceding segment) when it helps.
- Preserve facts, names, numbers, and technical terms exactly. Do not translate the spoken language.
- Remove filler words (um, uh, like, you know) and false starts/stutters, but keep everything else the speaker said - do NOT shorten, paraphrase, or summarize. This is a transcript, not a summary.
- Output length must stay close to the input length (within ~20%).
- If the segment is empty, pure noise, or a speech-recognizer hallucination on silence (e.g. "Thank you for watching", "[Music]", "Subscribe", "Thanks for watching!"), output nothing.
- Output ONLY the cleaned segment text. No labels, no quotes, no timestamps, no commentary.

If you cannot clean it, return the input trimmed.`;

// whisper.cpp loves to "hear" YouTube outros on quiet/noise - English AND
// Vietnamese training data leaks through. Real lecture speech is rarely an
// exact outro CTA, so phrase-level matches are safe to drop.
const NOTES_HALLUCINATION_PATTERNS = [
  /thank(s| you) for watching/i,
  /thanks for watching/i,
  /please (subscribe|like and subscribe)/i,
  /see you (next time|in the next video)/i,
  /^\[.*?(music|applause|noise|silence|blank_audio).*?\]$/i,
  // Vietnamese YouTube-outro hallucinations (seen verbatim in real sessions)
  /hãy subscribe cho kênh/i,
  /đăng k[ýy] kênh/i,
  /ủng hộ kênh/i,
  /ghiền mì gõ/i,
  /đừng quên (like|đăng k[ýy]|nhấn)/i,
  /nhấn chuông/i,
  /video hấp dẫn/i,
  /cảm ơn .* (xem|theo dõi)/i,
  /các bạn hãy .* kênh của mình nhé/i,
];

export function isLikelyWhisperHallucination(text) {
  const t = (text || "").trim();
  if (!t || t.length > 140) return false;
  return NOTES_HALLUCINATION_PATTERNS.some((re) => re.test(t));
}

const STT_HALLUCINATION_PATTERNS = [
  /I am (an )?AI/i,
  /as an AI/i,
  /language model/i,
  /nice to meet you/i,
  /how can I help/i,
  /hello! I am/i,
  /I'm here to help/i,
];

function isHallucinated(raw, normalized) {
  if (!normalized) return false;
  if (STT_HALLUCINATION_PATTERNS.some((re) => re.test(normalized))) return true;
  // blow-up: short input -> long output is hallucination (e.g., "hey" -> paragraph)
  if (raw.length <= 20 && normalized.length > raw.length * 4 + 20) return true;
  if (raw.length <= 10 && normalized.split(/\s+/).length > 10) return true;
  return false;
}

function fallbackForRaw(raw) {
  return raw.trim();
}

// Small bounded cache for LLM normalization/correction. Repeated speech (and
// re-pressing Fix on the same sentence) is common; a reasoning model costs
// tens of seconds each time for an identical answer. Key includes the model
// and prompt so a model/mode change never reuses a stale result.
const NORMALIZE_CACHE_MAX = 64;
const normalizeCache = new Map();

function modelKey() {
  try {
    const p = lastInsertKvStore?.get?.("voice.providerID") || "";
    const m = lastInsertKvStore?.get?.("voice.modelID") || "";
    return `${p}/${m}`;
  } catch {
    return "";
  }
}

function cacheKey(kind, parts) {
  return [kind, modelKey(), sttNormalizeMode, ...parts].join("\u0001");
}

function cacheGet(key) {
  const hit = normalizeCache.get(key);
  if (hit === undefined) return null;
  // Refresh LRU ordering.
  normalizeCache.delete(key);
  normalizeCache.set(key, hit);
  return hit;
}

function cacheSet(key, value) {
  normalizeCache.set(key, value);
  while (normalizeCache.size > NORMALIZE_CACHE_MAX) {
    normalizeCache.delete(normalizeCache.keys().next().value);
  }
}

export function __clearNormalizeCacheForTests() {
  normalizeCache.clear();
}

export async function normalizeTranscription(
  complete,
  rawText,
  contextBlock,
  systemPrompt,
  logger,
  sessionID = null,
) {
  logger?.log(
    "STT",
    `Normalizing transcription chars=${rawText.length} contextChars=${contextBlock?.length || 0}`,
    "debug",
  );
  const prompt = contextBlock
    ? `<knowledge>\n${contextBlock}\n</knowledge>\n<task>Clean up this speech-to-text transcription:\n\n${rawText}</task>`
    : `Clean up this speech-to-text transcription:\n\n${rawText}`;
  const key = cacheKey("normalize", [rawText, contextBlock || "", systemPrompt || ""]);
  const cached = cacheGet(key);
  if (cached) {
    logger?.log("STT", `Normalization cache hit chars=${cached.length}`, "debug");
    return { text: cached, cached: true };
  }
  let timeoutId = null;
  let result;
  try {
    result = await Promise.race([
      complete({
        system: systemPrompt,
        prompt,
        // Spoken turns are short; a cap bounds worst-case latency so a
        // rambling model cannot stall the turn. Reasoning models (muse-spark)
        // spend part of this budget thinking, so it must leave room for the
        // answer — 1024 came back empty when reasoning ate it all.
        // sessionID is pinned: the zen/go gateway rejects a request without
        // x-opencode-session (400 MissingSessionID) when the route has moved.
        config: { temperature: 0, maxTokens: 2048, ...(sessionID ? { sessionID } : {}) },
      }),
      new Promise((resolve) => {
        timeoutId = setTimeout(
          () =>
            resolve({
              text: null,
              error: `Normalization timed out after ${sttNormalizeTimeoutMs}ms`,
              timedOut: true,
            }),
          sttNormalizeTimeoutMs,
        );
      }),
    ]);
  } finally {
    // A rejected/aborted LLM promise also settles the race: clear here or the
    // 45s timer keeps the process alive long after the turn failed.
    if (timeoutId) clearTimeout(timeoutId);
  }
  if (result?.timedOut) {
    logger?.log("STT", `Normalization timeout after ${sttNormalizeTimeoutMs}ms, using raw`, "warn");
  }
  if (result.text && isHallucinated(rawText, result.text)) {
    logger?.log(
      "STT",
      `Hallucination detected rawLen=${rawText.length} normalizedLen=${result.text.length} -> fallback`,
      "warn",
    );
    return { text: fallbackForRaw(rawText) };
  }
  if (result?.text) cacheSet(key, result.text);
  return result;
}

async function getApiModels(logger) {
  if (!sttApiEndpoint) return [];
  try {
    const url = sttApiEndpoint.endsWith("/")
      ? `${sttApiEndpoint}models`
      : `${sttApiEndpoint}/models`;
    const headers = {};
    if (sttApiKeyEnv && process.env[sttApiKeyEnv]) {
      headers["Authorization"] = "Bearer " + process.env[sttApiKeyEnv];
    }
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    logger?.log("STT", `Fetched STT API models status=${resp.status}`, resp.ok ? "debug" : "warn");
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.data || [])
      .filter((m) => m.id && /whisper/i.test(m.id))
      .map((m) => ({ value: m.id, label: m.id }));
  } catch (err) {
    logger?.log("STT", `Failed to fetch STT API models: ${err.message}`, "error");
    return [];
  }
}

export async function transcribeApiFile(wavFile, endpoint, model, apiKeyEnv, logger) {
  if (!endpoint || !model) {
    logger?.log("STT", "STT API transcription skipped: API not configured", "warn");
    return { error: "STT API not configured" };
  }
  logger?.log("STT", `STT API transcription requested model=${model}`, "debug");

  if (!fs.existsSync(wavFile)) {
    logger?.log("STT", `Recording file missing: ${wavFile}`, "error");
    return { error: "No recording file - sox may have failed to capture audio" };
  }
  if (fs.statSync(wavFile).size <= 44) {
    logger?.log("STT", `Recording file empty: ${wavFile}`, "warn");
    return { error: "Recording is empty - no audio captured" };
  }

  try {
    const audioBuffer = await fs.promises.readFile(wavFile);
    const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : null;
    const useOpenRouterFormat = isOpenRouterEndpoint(endpoint);

    const url = endpoint.endsWith("/")
      ? `${endpoint}audio/transcriptions`
      : `${endpoint}/audio/transcriptions`;

    const request = useOpenRouterFormat
      ? buildOpenRouterTranscriptionRequest(model, audioBuffer, apiKey)
      : buildMultipartTranscriptionRequest(model, audioBuffer, apiKey);

    const resp = await fetch(url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(60000),
    });
    logger?.log("STT", `STT API response status=${resp.status}`, resp.ok ? "debug" : "error");

    if (!resp.ok) {
      const responseBody = await resp.text();
      let msg = `STT API error ${resp.status}`;
      try {
        const err = JSON.parse(responseBody);
        msg = err?.error?.message || msg;
      } catch {}
      return { error: msg };
    }

    let data;
    try {
      data = await resp.json();
    } catch (err) {
      logger?.log("STT", `STT API returned invalid JSON: ${err.message}`, "error");
      return { error: `STT API returned invalid JSON: ${err.message}` };
    }
    logger?.log("STT", `STT API transcription succeeded chars=${data.text?.length || 0}`, "debug");
    return { text: data.text?.trim() || "" };
  } catch (err) {
    logger?.log("STT", `STT API request failed: ${err.message}`, "error");
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return { error: "STT API request timed out (60s)" };
    }
    return { error: `STT API request failed: ${err.message}` };
  }
}

async function transcribeApi(kv, logger) {
  const wavFile = path.join(tmpDir, WAV_FILENAME);
  const model = kv.get("stt.api.model") || sttApiModel;
  return transcribeApiFile(wavFile, sttApiEndpoint, model, sttApiKeyEnv, logger);
}

/**
 * Which path owns silence auto-end for the current streaming session.
 * Conversation mode always wins: the plain dictation path submits the text
 * directly, which bypasses the conversation turn (no reply wait, no speech,
 * UI stuck on "Listening"). While a conversation is active the timer either
 * finishes the turn through the conversation callback or stays off - it never
 * falls back to that submit.
 */
export function streamAutoEndRoute({
  conversation,
  conversationStopSec,
  conversationOnStopped,
  previewAutoEnd,
}) {
  if (conversation) {
    const enabled = conversationStopSec > 0 || previewAutoEnd === true;
    return enabled && typeof conversationOnStopped === "function" ? "conversation" : "off";
  }
  return previewAutoEnd === true ? "dictation" : "off";
}

export function insertIntoFocusedInput(renderer, text, submit = false) {
  const focused = renderer?.currentFocusedRenderable;
  if (!focused || typeof focused.insertText !== "function") return false;

  try {
    focused.insertText(text);
    if (submit && typeof focused.submit === "function") focused.submit();
    return true;
  } catch {
    return false;
  }
}

async function appendTranscription(client, renderer, text, submit, isCurrent) {
  if (insertIntoFocusedInput(renderer, text, submit)) {
    return true;
  }

  // Only the v2 adapter consumes this fence; v1 request bodies remain
  // unchanged. Re-check after an asynchronous home session create. The
  // `submit` flag lets the adapter distinguish an explicit submit from a
  // plain append with no editable field focused (append must not send).
  const fence = client.tui?.v2 ? { isCurrent, submit } : {};
  let appendResult = await client.tui.appendPrompt({ body: { text }, ...fence });

  if (appendResult?.error?.data?.message === "Expected object, got undefined") {
    appendResult = await client.tui.appendPrompt({ text });
  }

  if (appendResult?.error) {
    throw new Error(
      `appendPrompt failed: ${appendResult.error.data?.message || appendResult.error.name}`,
    );
  }

  if (appendResult?.retained) return appendResult;

  if (submit && !appendResult?.submitted) {
    await client.tui.submitPrompt();
  }
  return appendResult;
}

// Transcribe the finished recording and normalize it, without touching the
// prompt. Leaves the sticky "Normalizing..." toast up on success so the caller
// can submit/speak without a silent gap; error/empty paths clear it and reset
// the flags themselves.

export function isLikelyHallucination(text) {
  const t = String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return true;
  const known = [
    "hay subscribe cho kenh ghien mi go",
    "hay subscribe cho kenh",
    "subscribe cho kenh ghien mi go",
    "dang ky kenh",
    "cam on cac ban da xem",
    "alo alo nghe toi noi gi khong",
    "alo alo nghe toi noi gi",
    "thank you",
    "thank you for watching",
    "please subscribe",
    "subscribe to my channel",
    "like and subscribe",
    "you",
  ];
  // Short entries ("you", "thank you") must match the WHOLE transcript:
  // substring matching dropped real dictation like "can you fix the test".
  if (known.some((k) => t === k || (k.split(" ").length >= 3 && t.includes(k)))) return true;
  if (/subscribe/.test(t) && /(kenh|channel|ghien)/.test(t)) return true;
  // Very short hallucinations on silence are usually a few words.
  if (t.split(" ").length <= 3 && /subscribe|kenh|watching/i.test(t)) return true;
  return false;
}

/**
 * Classify a remote PCM capture so failures read differently from silence.
 * Pure: {kind, bytes, rms}. Kinds: missing (no buffer), empty (0 bytes),
 * short (<0.1s), zero (every sample exactly 0 - the silenced-mic signature),
 * silent (audible-room-tone floor), ok.
 * @param {Buffer|null} pcm
 */
export function classifyRemotePcm(pcm) {
  if (!pcm) return { kind: "missing", bytes: 0, rms: 0 };
  const bytes = pcm.length;
  if (bytes === 0) return { kind: "empty", bytes: 0, rms: 0 };
  if (bytes < 3200) return { kind: "short", bytes, rms: 0 };
  let sum = 0;
  let allZero = true;
  const samples = Math.floor(bytes / 2);
  for (let i = 0; i + 1 < bytes; i += 2) {
    const v = pcm.readInt16LE(i);
    if (v !== 0) allZero = false;
    const s = v / 32768;
    sum += s * s;
  }
  const rms = samples > 0 ? Math.sqrt(sum / samples) : 0;
  if (allZero) return { kind: "zero", bytes, rms };
  if (rms < 0.005) return { kind: "silent", bytes, rms };
  return { kind: "ok", bytes, rms };
}

async function transcribeTurn(kv, complete, client, api, toast, systemPrompt, logger) {
  processing = true;
  const turnGen = pipelineGeneration;
  const resetTurnFlags = () => {
    if (turnGen !== pipelineGeneration) return; // cancelled: flags already reset
    processing = false;
    recording = false;
  };
  clearRecordingToast();
  batchStatus.clear();
  logger?.log("STT", "Turn transcription started", "debug");
  stopRecording(logger);
  await waitForSoxExit(logger, remoteBatchCapture ? 13000 : 2000);

  let skipTranscription = false;
  let skipReason = null;
  if (remotePcmFile) {
    let pcm = null;
    try {
      pcm = fs.readFileSync(remotePcmFile);
    } catch (err) {
      // A failed read used to fall through and transcribe a stale WAV.
      // Report it and stop instead.
      sttLog("STT", `Remote PCM read failed: ${err.message}`);
      skipReason = "read-failed";
    }
    if (!skipReason) {
      const verdict = classifyRemotePcm(pcm);
      sttLog(
        "STT",
        `remote PCM bytes=${verdict.bytes} rms=${verdict.rms.toFixed(4)} kind=${verdict.kind}`,
      );
      if (verdict.kind === "ok") {
        const wav = wrapPcmAsWav(pcm, { sampleRate: getAudioSampleRate() });
        fs.writeFileSync(path.join(tmpDir, WAV_FILENAME), wav);
        sttLog("STT", `remote WAV written: wavBytes=${wav.length}`);
      } else if (verdict.kind === "zero") {
        // All-zero PCM is the silenced-mic signature (Android dumpsys showed
        // src:MIC silenced), not "the user said nothing".
        skipTranscription = true;
        skipReason = "zero-audio";
      } else if (verdict.kind === "missing" || verdict.kind === "empty") {
        skipTranscription = true;
        skipReason = "no-audio";
      } else {
        skipTranscription = true;
        skipReason = "silence";
      }
    }
    remotePcmFile = null;
  }

  if (skipTranscription || skipReason) {
    clearProcessingToast();
    resetTurnFlags();
    if (skipReason === "zero-audio") {
      sttLog("STT", "remote capture all zeros; skipping transcription");
      toast("Phone mic silent (zero audio) - check Termux mic, then retry", "error");
    } else if (skipReason === "no-audio" || skipReason === "read-failed") {
      sttLog("STT", "remote capture produced no audio; skipping transcription");
      toast("Remote capture produced no audio - check the SSH/capture path", "error");
    } else {
      sttLog("STT", "remote capture treated as silence; skipping transcription");
      toast("No speech detected", "warning");
    }
    return { text: null, empty: true, reason: skipReason || "silence" };
  }

  try {
    showProcessingToast("Transcribing...");
    const tTranscribe = Date.now();
    const result = sttApiEndpoint ? await transcribeApi(kv, logger) : await transcribe(kv, logger);
    const transcribeMs = Date.now() - tTranscribe;
    sttLog("STT", `raw transcription chars=${result.text?.length || 0}: ${result.text || ""}`);

    if (result.error) {
      clearProcessingToast();
      resetTurnFlags();
      sttLog("STT", `Transcription failed: ${result.error}`);
      toast(result.error, "error");
      return { error: result.error };
    }
    if (!result.text) {
      clearProcessingToast();
      resetTurnFlags();
      sttLog("STT", "Transcription produced no text");
      toast("No speech detected", "warning");
      return { text: null, empty: true };
    }
    if (isLikelyHallucination(result.text)) {
      clearProcessingToast();
      resetTurnFlags();
      sttLog("STT", `Transcription discarded as hallucination: ${result.text}`);
      toast("No speech detected", "warning");
      return { text: null, empty: true };
    }
    sttLog("STT", `Transcription succeeded chars=${result.text.length}`);

    updateProcessingToast("Normalizing...");
    const tContext = Date.now();
    // Route can change between record start and LLM call (navigate, dialog).
    // Remember the last real session so the gateway header never goes missing.
    const sessionID = currentRouteSessionID(api) || lastSessionID;
    if (sessionID) lastSessionID = sessionID;
    const pref = prefetchedContext;
    prefetchedContext = null;
    const { sessionTitle, recent } =
      pref && Date.now() - pref.at < 60000 && pref.sessionID === sessionID
        ? await pref.promise
        : await fetchContextParts(client, api);
    const contextMs = Date.now() - tContext;
    const withTurns = needsContext(result.text);
    const contextBlock = [
      sessionTitle ? `[session: "${sessionTitle}"]` : null,
      withTurns && recent ? recent : null,
    ]
      .filter(Boolean)
      .join("\n");
    const tNormalize = Date.now();
    const llmResult = await normalizeTranscription(
      complete,
      result.text,
      contextBlock,
      systemPrompt,
      logger,
      sessionID,
    );
    const normalizeMs = Date.now() - tNormalize;

    if (!llmResult.text) {
      clearProcessingToast();
      resetTurnFlags();
      logger?.log("STT", `Normalization failed, using raw input: ${llmResult.error}`, "warn");
      toast(`Normalization failed, using raw input: ${llmResult.error}`, "warning");
      return { text: result.text, fallback: true };
    }

    logger?.log(
      "STT",
      `Turn timings transcribeMs=${transcribeMs} contextMs=${contextMs} contextTurns=${withTurns ? 1 : 0} normalizeMs=${normalizeMs} rawChars=${result.text.length}`,
      "debug",
    );
    return { text: llmResult.text };
  } catch (err) {
    clearProcessingToast();
    resetTurnFlags();
    logger?.log("STT", `Turn transcription error: ${err.message}`, "error");
    toast(`STT error: ${err.message}`, "error");
    return { error: err.message };
  }
}

async function submitTurnText(client, renderer, toast, text, logger) {
  const myGen = pipelineGeneration;
  try {
    await appendTranscription(client, renderer, text, true, () => myGen === pipelineGeneration);
    clearProcessingToast();
    logger?.log("STT", `Turn submitted chars=${text.length}`, "debug");
    if (text) setLastInsertedText(text);
    toast("Transcription submitted", "success");
    return { text };
  } catch (err) {
    clearProcessingToast();
    logger?.log("STT", `Turn submit failed: ${err.message}`, "error");
    toast(`STT error: ${err.message}`, "error");
    return { error: err.message };
  } finally {
    processing = false;
    recording = false;
  }
}

async function appendTurnText(client, renderer, toast, text, logger) {
  const myGen = pipelineGeneration;
  try {
    const appendResult = await appendTranscription(
      client,
      renderer,
      text,
      false,
      () => myGen === pipelineGeneration,
    );
    clearProcessingToast();
    logger?.log("STT", `Turn appended chars=${text.length}`, "debug");
    // The v2 adapter retains the transcript when no editable field has
    // focus — it never sends an unrequested prompt. v1 results carry no
    // marker and keep the original toast.
    const retained = appendResult?.retained === true;
    if (!retained && text) setLastInsertedText(text);
    toast(
      retained
        ? "No text field focused - transcription kept (not sent)"
        : "Transcription added to prompt",
      retained ? "warning" : "success",
    );
    return { text };
  } catch (err) {
    clearProcessingToast();
    logger?.log("STT", `Turn append failed: ${err.message}`, "error");
    toast(`STT error: ${err.message}`, "error");
    return { error: err.message };
  } finally {
    processing = false;
    recording = false;
  }
}

// Drop a transcribed turn without submitting (e.g. voice stop phrase).
// Clears the sticky toast left up by transcribeTurn and resets the flags.

function discardTurn() {
  pipelineGeneration += 1;
  clearProcessingToast();
  processing = false;
  recording = false;
  clearCorrection("discard");
}

// Cancel an in-progress recording without transcribing.

function cancelRecording(logger) {
  pipelineGeneration += 1;
  recording = false;
  // A cancel during transcribe/normalize used to leave processing=true
  // ("STT busy" until the stale pipeline finished) and the toast polling.
  processing = false;
  clearProcessingToast();
  clearRecordingToast();
  batchStatus?.clear();
  clearCorrection("cancel");
  forceKillSox(logger);
}

/**
 * @param {any} kv
 * @param {any} complete
 * @param {any} client
 * @param {any} api
 * @param {any} toast
 * @param {any} systemPrompt
 * @param {boolean | (() => boolean)} submit
 * @param {any} logger
 * @param {any} renderer
 */
async function doTranscribePipeline(
  kv,
  complete,
  client,
  api,
  toast,
  systemPrompt,
  submit = false,
  logger,
  renderer,
) {
  // Auto-submit is decided at delivery time, not at recording start: a toggle
  // mid-recording must win. The only forced submit is an explicit submit=true.
  // A function passed in (ctx.autoSubmitNow) is a live reader, not a bool.
  logger?.log("STT", "Pipeline started", "debug");
  const myGen = pipelineGeneration;
  const turn = await transcribeTurn(kv, complete, client, api, toast, systemPrompt, logger);
  // A cancel during transcribe/normalize invalidates this turn: drop the
  // stale text instead of appending it after the user cancelled.
  if (myGen !== pipelineGeneration) {
    // cancel/discard already reset flags and toasts; touching them here
    // would clobber a recording started after the cancel.
    return;
  }
  if (!turn.text) {
    // An empty/failed/cancelled turn must not leak into a later correction.
    clearCorrection("empty-turn");
    return;
  }
  if (correcting) {
    // One-shot correction turn: merge instead of appending, never submit.
    const res = await runCorrectionMerge({
      complete,
      client,
      api,
      toast,
      logger,
      renderer,
      text: turn.text,
    });
    clearProcessingToast();
    processing = false;
    recording = false;
    return res;
  }
  const doSubmit = submit === true || (typeof submit === "function" && submit() === true);
  logger?.log("STT", `Delivery submit=${doSubmit} explicit=${submit === true}`, "debug");
  if (doSubmit) {
    await submitTurnText(client, renderer, toast, turn.text, logger);
  } else {
    await appendTurnText(client, renderer, toast, turn.text, logger);
  }
}

// ---- Dictation correction ("re-speak to fix") ----
//
// A misheard word ("fit" for "fix") is fixed by speaking the correction once.
// Input: current composer text (read live when the host exposes it, else the
// last text we inserted) + conversation context + the new utterance.
// The LLM merges them; the merged text replaces the original in place.
// Auto-submit is forced off for the correction turn.

let lastInsertedText = null;
// Last session id seen on a real session route; the LLM header fallback.
let lastSessionID = null;
// Persisted mirror of the last inserted dictation (kv survives restarts;
// the module var does not). beginCorrection hydrates from it.
let lastInsertKvStore = null;
let correcting = null;
let composerShapeLogged = false;

export function __setLastInsertedTextForTests(v) {
  lastInsertedText = v || null;
  correcting = null;
}

/**
 * Release correction ownership. Called on cancel, discard, empty/failed
 * turns, and after every merge so a later dictation never becomes a
 * correction by accident.
 * @param {string} [reason]
 */
export function clearCorrection(reason) {
  if (correcting) sttLog("STT", `correction cleared (${reason || "done"})`);
  correcting = null;
}

function setLastInsertedText(text) {
  lastInsertedText = text || null;
  if (!text) correcting = null;
  try {
    // kv has get/set only (no delete): empty string means "none".
    lastInsertKvStore?.set?.("stt.lastInsertedText", text || "");
  } catch {}
}

export function __setLastInsertKvForTests(store) {
  lastInsertKvStore = store || null;
}

function describeFocused(focused) {
  try {
    const keys = focused ? Object.getOwnPropertyNames(focused) : [];
    const proto = focused ? Object.getPrototypeOf(focused) : null;
    const pkeys = proto ? Object.getOwnPropertyNames(proto) : [];
    const probes = ["getText", "setRange", "insertText", "editBuffer", "textarea", "input"];
    const types = probes.map((k) => `${k}:${typeof focused?.[k]}`).join(",");
    return `keys=[${keys.join(",")}] proto=[${pkeys.join(",")}] ${types}`;
  } catch {
    return "uninspectable";
  }
}

// The composer object differs per host version: sometimes the text field
// itself, sometimes a wrapper exposing the real buffer on a child. Probe both.
function composerCandidates(focused) {
  const list = [focused];
  for (const key of ["editBuffer", "textarea", "input", "buffer", "editor"]) {
    try {
      const child = focused?.[key];
      if (child && typeof child === "object") list.push(child);
    } catch {}
  }
  return list;
}

function textFrom(candidate) {
  try {
    if (typeof candidate.getText === "function") {
      const t = candidate.getText();
      if (typeof t === "string") return t;
    }
    if (typeof candidate.getPlainText === "function") {
      const t = candidate.getPlainText();
      if (typeof t === "string") return t;
    }
    if (typeof candidate.getValue === "function") {
      const t = candidate.getValue();
      if (typeof t === "string") return t;
    }
    if (typeof candidate.value === "string") return candidate.value;
    if (typeof candidate.value === "function") {
      const t = candidate.value();
      if (typeof t === "string") return t;
    }
    if (typeof candidate.text === "string") return candidate.text;
    if (typeof candidate.plainText === "string") return candidate.plainText;
  } catch {}
  return null;
}

/** Best-effort read of the composer's current text; null when unreadable. */
export function readComposerText(renderer) {
  const focused = renderer?.currentFocusedRenderable;
  if (!focused) return null;
  if (!composerShapeLogged) {
    composerShapeLogged = true;
    sttLog("STT", `composer shape: ${describeFocused(focused).slice(0, 500)}`);
  }
  for (const candidate of composerCandidates(focused)) {
    const t = textFrom(candidate);
    if (typeof t === "string") return t;
  }
  return null;
}

/** Best-effort full replace of the composer text; false when unsupported. */
export function tryReplaceComposerText(renderer, next) {
  const focused = renderer?.currentFocusedRenderable;
  if (!focused) return false;
  for (const candidate of composerCandidates(focused)) {
    try {
      if (typeof candidate.setText === "function") {
        candidate.setText(next);
        return true;
      }
      if (typeof candidate.setValue === "function") {
        candidate.setValue(next);
        return true;
      }
      if (typeof candidate.setRange === "function") {
        const current = textFrom(candidate);
        if (typeof current === "string") {
          candidate.setRange(0, current.length, next);
          return true;
        }
      }
      if (typeof candidate.clear === "function" && typeof candidate.insertText === "function") {
        candidate.clear();
        candidate.insertText(next);
        return true;
      }
    } catch {}
  }
  return false;
}

const CORRECTION_SYSTEM_PROMPT = `You repair a voice-dictated sentence with a spoken correction. You are NOT a chatbot. Never answer, explain, or greet.
Input gives ORIGINAL (what was transcribed) and CORRECTION (what the user just said, e.g. "I mean fix not fit" or just the corrected phrase).
Output ONLY the repaired full sentence: the original with the correction applied. Always reply in the language of the ORIGINAL text, even when the correction itself is spoken in a different language. Keep names, casing, punctuation. No quotes, no commentary.`;

export async function normalizeCorrection(
  complete,
  original,
  correction,
  contextBlock,
  sessionID = null,
) {
  const prompt =
    (contextBlock ? `<knowledge>\n${contextBlock}\n</knowledge>\n` : "") +
    `<task>Repair this dictation with the spoken correction. The repaired sentence must stay in the ORIGINAL's language, even if the correction is spoken in a different language.\n\nOriginal: ${original}\nCorrection: ${correction}</task>`;
  const key = cacheKey("correction", [original, correction, contextBlock || ""]);
  const cached = cacheGet(key);
  if (cached) {
    sttLog("STT", `correction cache hit chars=${cached.length}`);
    return { text: cached, cached: true };
  }
  let timeoutId = null;
  let result;
  try {
    result = await Promise.race([
      complete({
        system: CORRECTION_SYSTEM_PROMPT,
        prompt,
        // Pinned session: without it the gateway 400s (MissingSessionID) even
        // though dictation normalize worked seconds earlier. 2048 leaves room
        // for a reasoning model's thinking tokens plus the repaired sentence.
        config: { temperature: 0, maxTokens: 2048, ...(sessionID ? { sessionID } : {}) },
      }),
      new Promise((resolve) => {
        timeoutId = setTimeout(
          () =>
            resolve({ text: null, error: `Correction timed out after ${sttNormalizeTimeoutMs}ms` }),
          sttNormalizeTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
  if (result?.text) cacheSet(key, result.text);
  return result;
}

/**
 * Begin a correction turn. Resolves the text to repair (live composer text
 * preferred, last insert as fallback) and arms the one-shot correcting
 * state consumed by doTranscribePipeline. Returns {ok} or {ok:false,reason}.
 * The focused renderable identity is captured so the merge can refuse when
 * focus moved to another field mid-turn.
 *
 * Host note: the installed host exposes only insertText/submit on the
 * focused renderable (see lib/stt/streaming/streaming-editor.js), so a live
 * composer read is best-effort. The last-insert fallback stays because it is
 * the exact text this plugin inserted - deterministic, not a guess - and the
 * identity + suffix fences below still guard the replace.
 * @param {{toast?: Function, renderer?: any}} input
 */
export function beginCorrection({ toast, renderer } = {}) {
  if (typeof conversationActive === "function" && conversationActive()) {
    toast?.("Correction is dictation-only - conversation owns the mic", "warning");
    return { ok: false, reason: "conversation" };
  }
  if (recording || processing || streamingDictationActive) {
    toast?.("STT busy, please wait...", "warning");
    return { ok: false, reason: "busy" };
  }
  const focused = renderer?.currentFocusedRenderable || null;
  const live = readComposerText(renderer);
  if (!lastInsertedText) {
    // Restart-safe: the module var dies with the process, kv does not.
    try {
      const saved = lastInsertKvStore?.get?.("stt.lastInsertedText");
      if (typeof saved === "string" && saved.trim()) lastInsertedText = saved;
    } catch {}
  }
  const original = (typeof live === "string" && live.trim()) || lastInsertedText;
  if (!original || !original.trim()) {
    toast?.("Nothing to correct - dictate something first", "warning");
    return { ok: false, reason: "empty" };
  }
  correcting = {
    original: original.trim(),
    focused,
    live: typeof live === "string" && live.trim().length > 0,
  };
  sttLog(
    "STT",
    `correction armed chars=${original.trim().length} source=${correcting.live ? "composer" : "last-insert"}`,
  );
  toast?.("Recording correction - speak the fix, then stop", "info");
  return { ok: true };
}

export function isCorrecting() {
  return !!correcting;
}

/**
 * Merge one correction turn. Single attempt: failure keeps the original and
 * releases ownership (the user re-speaks only by pressing Fix again).
 * Never submits, never appends a duplicate. Exported for tests.
 */
export async function runCorrectionMerge({ complete, client, api, toast, logger, renderer, text }) {
  const session = correcting;
  // Real conversation context, same resolver as the dictation path; gated on
  // the original text so referents ("that function") resolve. Missing context
  // is "" and the merge proceeds without it.
  let contextBlock = "";
  try {
    const { sessionTitle, recent } = await fetchContextParts(client, api);
    const withTurns = needsContext(session.original);
    contextBlock = [
      sessionTitle ? `[session: "${sessionTitle}"]` : null,
      withTurns && recent ? recent : null,
    ]
      .filter(Boolean)
      .join("\n");
  } catch {}
  let merged = null;
  let failureKind = null;
  let failureDetail = "";
  try {
    showProcessingToast("Merging correction...");
    const sessionID = currentRouteSessionID(api) || lastSessionID;
    if (sessionID) lastSessionID = sessionID;
    const t0 = Date.now();
    const res = await normalizeCorrection(
      complete,
      session.original,
      text,
      contextBlock,
      sessionID,
    );
    sttLog(
      "STT",
      `correction merge elapsedMs=${Date.now() - t0} budgetMs=${sttNormalizeTimeoutMs}`,
    );
    if (res?.text && res.text.trim()) {
      merged = res.text.trim();
      sttLog("STT", `correction merge ok chars=${merged.length}`);
    } else if (res?.timedOut) {
      // normalizeCorrection's own timeout race fired (not a throw).
      failureKind = "timeout";
      failureDetail = res?.error || "LLM timed out";
      sttLog("STT", `correction merge timeout: ${failureDetail}`);
    } else if (res?.error) {
      failureKind = "error";
      failureDetail = res.error;
      sttLog("STT", `correction merge error: ${String(failureDetail).slice(0, 200)}`);
    } else {
      failureKind = "empty";
      sttLog("STT", "correction merge returned empty text");
    }
  } catch (err) {
    failureKind = "error";
    failureDetail = err?.message || String(err);
    sttLog("STT", `correction merge threw: ${String(failureDetail).slice(0, 200)}`);
  } finally {
    clearProcessingToast();
  }
  if (!merged) {
    clearCorrection(`merge-failed-${failureKind || "unknown"}`);
    if (failureKind === "timeout") {
      toast?.(`Correction timed out - kept the original (${failureDetail})`, "warning");
    } else if (failureKind === "error") {
      toast?.(
        `Correction failed - kept the original (${String(failureDetail).slice(0, 160)})`,
        "warning",
      );
    } else {
      toast?.("Correction came back empty - kept the original", "warning");
    }
    return { text: null, kept: true, reason: failureKind || "empty" };
  }
  // Replace only when focus never left the field we armed on AND the composer
  // still ends with the exact text we set out to repair.
  if (renderer?.currentFocusedRenderable !== session.focused) {
    clearCorrection("focus-changed");
    toast?.("Composer changed - keeping original, re-dictate to fix", "warning");
    return { text: null, kept: true };
  }
  const live = readComposerText(renderer);
  if (typeof live === "string" && live.length > 0) {
    if (!live.endsWith(session.original)) {
      clearCorrection("composer-changed");
      toast?.("Composer changed - keeping original, re-dictate to fix", "warning");
      return { text: null, kept: true };
    }
    if (tryReplaceComposerText(renderer, live.slice(0, -session.original.length) + merged)) {
      setLastInsertedText(merged);
      clearCorrection("applied");
      sttLog("STT", `correction applied chars=${merged.length}`);
      toast?.("Correction applied", "success");
      return { text: merged, replaced: true };
    }
  }
  if (!session.live) {
    // Composer unreadable and we only have our last insert: cannot verify,
    // so never blind-clobber.
    clearCorrection("unverifiable");
    toast?.("Composer is append-only here - re-dictate the fixed sentence", "warning");
    return { text: null, kept: true };
  }
  clearCorrection("unreplaceable");
  toast?.("Could not edit composer on this host", "warning");
  return { text: null, kept: true };
}

// ---- Public API for TUI plugin ----

export function registerSTT(api, kv, complete, prompts, opts, logger, deps = {}) {
  __setAudioPluginKv(kv);
  lastInsertKvStore = kv || null;
  __setAudioPluginOpts(opts || {});
  sttPluginOpts = opts || {};
  __setRemotePluginKv(kv);
  __setRemotePluginOpts(opts || {});
  if (deps.isConversationActive || deps.onConversationKey) {
    __setConversationHooks({
      isActive: deps.isConversationActive,
      onKey: deps.onConversationKey,
    });
  }
  if (deps.isLiveNotesActive) {
    __setLiveNotesHooks({ isActive: deps.isLiveNotesActive });
  }
  const client = api.client;
  const renderer = opts?.focusMode === "primary" ? null : api.renderer;
  const preview = api.voicePreview;
  // Seed engine from opts if the host delivered it.
  try {
    if (opts?.ttsEngine && kv.get("tts.engine") == null) {
      kv.set("tts.engine", opts.ttsEngine);
    }
  } catch {}
  try {
    if (opts?.sttEngine && kv.get("stt.engine") == null) {
      kv.set("stt.engine", opts.sttEngine);
    }
  } catch {}
  __setToastPolling(!preview);
  const bootMode = resolveSttMode(opts, kv);
  let modeSource = "default-batch";
  try {
    if (kv?.get("stt.mode") === bootMode) modeSource = "kv";
    else if (opts?.sttMode === bootMode) modeSource = "options";
  } catch {}
  sttLog(
    "register",
    `sttMode=${bootMode} source=${modeSource} preview=${preview ? "yes" : "no"} toastPolling=${!preview} optKeys=${Object.keys(opts || {}).join(",")}`,
  );
  let streamGeneration = 0;
  let streamDisposed = false;
  let finalizingController = null;
  const systemPrompt = selectSttSystemPrompt(sttNormalizeMode, prompts?.stt);
  let captureCmdOpt = opts?.sttCaptureCmd ?? kv.get("sttCaptureCmd") ?? kv.get("stt.captureCmd");
  if (!captureCmdOpt && process.env.STT_CAPTURE_CMD) {
    try {
      captureCmdOpt = JSON.parse(process.env.STT_CAPTURE_CMD);
    } catch {}
  }
  if (Array.isArray(captureCmdOpt) && captureCmdOpt.length) {
    __setSttCaptureCmd(captureCmdOpt);
  }
  let srOpt = opts?.audioSampleRate ?? kv.get("audioSampleRate") ?? kv.get("audio.sampleRate");
  if (!srOpt && process.env.AUDIO_SAMPLE_RATE) srOpt = process.env.AUDIO_SAMPLE_RATE;
  if (Number(srOpt) > 0) {
    __setAudioSampleRate(Number(srOpt));
  }

  const backend = detectAudioBackend();
  logger?.log("STT", `Audio backend=${backend}`, "debug");

  batchStatus = createBatchStatus(api, () => recording, {
    cancel: () => {
      if (recording) {
        cancelRecording(logger);
        batchStatus.clear();
      }
    },
    send: () => {
      if (recording) {
        clearRecordingToast();
        toast("Stopping, transcribing...");
        doTranscribePipeline(
          kv,
          complete,
          client,
          api,
          toast,
          systemPrompt,
          autoSubmitNow,
          logger,
          renderer,
        );
        batchStatus.clear();
      }
    },
    autoEnd: () => {
      const current = kv.get("stt.autoEndOfSpeech") === true;
      const next = !current;
      kv.set("stt.autoEndOfSpeech", next);
      toast(`Auto-end: ${next ? "on" : "off"}`);
    },
  });
  function toast(message, variant = "info") {
    api.ui.toast({ message, variant, duration: 3000 });
  }

  __setRecordingToastFn((input) => api.ui.toast(input));
  __setProcessingToastFn((input) => api.ui.toast(input));
  __setStreamingToastFn((input) => api.ui.toast(input));
  api.lifecycle?.onDispose?.(() => {
    __clearRecordingToastState();
    __clearProcessingToastState();
    __clearStreamingToastState();
  });

  if (opts?.sttEndpoint) {
    sttApiEndpoint = opts.sttEndpoint;
    sttApiModel = opts.sttModel || "whisper-large-v3-turbo";
    sttApiKeyEnv = opts.sttApiKeyEnv || null;
    logger?.log(
      "STT",
      `Configured STT API endpoint=${sttApiEndpoint} model=${sttApiModel}`,
      "debug",
    );
  }

  if (opts?.sttLanguage) {
    sttDefaultLanguage = opts.sttLanguage;
  }
  logger?.log("STT", `Default language=${sttDefaultLanguage}`, "debug");

  if (opts?.sttNormalizeMode === "strict") {
    sttNormalizeMode = "strict";
  }
  logger?.log("STT", `Normalize mode=${sttNormalizeMode}`, "debug");

  if (Number(opts?.sttContextMessages) > 0) {
    sttContextMessages = Math.floor(Number(opts.sttContextMessages));
  }
  if (Number(opts?.sttContextChars) > 0) {
    sttContextChars = Math.floor(Number(opts.sttContextChars));
  }
  if (Number(opts?.sttNormalizeTimeoutMs) > 0) {
    sttNormalizeTimeoutMs = Math.floor(Number(opts.sttNormalizeTimeoutMs));
  }
  logger?.log(
    "STT",
    `Normalize context messages=${sttContextMessages} chars=${sttContextChars}`,
    "debug",
  );

  tmpDir = opts?.tmpDir || "/tmp";
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch (err) {
    logger?.log("STT", `Failed to create tmpDir ${tmpDir}: ${err.message}`, "warn");
  }
  logger?.log("STT", `STT temp dir=${tmpDir}`, "debug");

  const DEFAULT_KEYBINDS = {
    "stt.record": "<leader>[",
  };
  function kb(value) {
    const kb = opts?.keybinds;
    if (!kb || typeof kb !== "object" || Array.isArray(kb)) return DEFAULT_KEYBINDS[value];
    if (!Object.prototype.hasOwnProperty.call(kb, value)) return DEFAULT_KEYBINDS[value];
    const v = kb[value];
    if (!v || v === "none") return undefined;
    return v;
  }
  __setRecordKeybind(kb("stt.record") || "<leader>[");

  // Start a recording for the voice-conversation loop. Returns false when busy.

  // Conversation-mode silence auto-finalize: when set, the recording uses
  // sox silence detection to auto-stop after this many seconds of silence,
  // and the onStopped callback fires. Default null = manual stop only.
  let conversationSilenceStopSec = null;
  let conversationOnStopped = null;

  function startLoopRecording() {
    if (recording || processing || streamingDictationActive) return false;
    const conv = conversationActive();
    const autoEnd = !conv && kv.get("stt.autoEndOfSpeech") === true;
    let autoEndFired = false;
    startRecording(
      kv,
      backend,
      toast,
      logger,
      opts?.trimSilence,
      conv ? conversationSilenceStopSec : autoEnd ? 2.5 : null,
      conv
        ? conversationOnStopped
        : autoEnd
          ? () => {
              // The sox exit handler already set recording=false before
              // calling this, so a `recording` guard made auto-end a silent
              // no-op that discarded the dictation. Guard re-entry locally.
              if (autoEndFired) return;
              autoEndFired = true;
              recording = false;
              clearRecordingToast();
              toast("Stopping, transcribing...");
              doTranscribePipeline(
                kv,
                complete,
                client,
                api,
                toast,
                systemPrompt,
                autoSubmitNow,
                logger,
                renderer,
              );
            }
          : null,
    );
    if (recording) {
      showRecordingToast();
      void batchStatus.begin();
      // Fetch title + recent turns while the user speaks, so the context is
      // usually ready before the turn ends instead of on the critical path.
      prefetchContextParts(client, api);
    }
    return recording;
  }

  // ---- Streaming dictation session (stage 2, local-only, no LLM) ----
  // Mode/auto-submit resolve live from kv first: options seed kv on first
  // boot, then the /stt-mode and /stt-autosubmit commands own the runtime
  // value. This survives hosts that deliver partial plugin options.
  const seedKvFromOpts = () => {
    try {
      if (
        (opts?.sttMode === "streaming" || opts?.sttMode === "batch") &&
        kv.get("stt.mode") == null
      ) {
        kv.set("stt.mode", opts.sttMode);
      }
    } catch {}
    try {
      if (opts?.sttAutoSubmit !== undefined && kv.get("stt.autoSubmit") == null) {
        kv.set("stt.autoSubmit", opts.sttAutoSubmit === true);
      }
    } catch {}
  };
  seedKvFromOpts();
  const currentSttMode = () => resolveSttMode(opts, kv);
  const sttAutoSubmitEnabled = () => resolveSttAutoSubmit(opts, kv);
  // Boot-time snapshot for the mode log line below; behavior branches call
  // currentSttMode() live so /stt-mode takes effect without a restart.
  const sttMode = currentSttMode();
  const streamTimings = resolveStreamTimings(opts);
  logger?.log(
    "STT",
    `Mode=${sttMode} streamWindowMs=${streamTimings.windowMs} streamStepMs=${streamTimings.cadenceMs}`,
    "debug",
  );
  let streamController = null;
  let streamEditor = null;
  let streamTarget = null;
  let streamStarting = false;
  // Auto-end-of-speech: when enabled, a timer checks if no new partial has
  // arrived for AUTO_END_SILENCE_MS and triggers finalize automatically.
  let streamAutoEndTimer = null;
  const AUTO_END_SILENCE_MS = 3000;

  function enableStreamAutoEnd() {
    disableStreamAutoEnd();
    streamAutoEndTimer = setInterval(() => {
      if (!streamingDictationActive || !streamController) {
        disableStreamAutoEnd();
        return;
      }
      const route = streamAutoEndRoute({
        conversation: conversationActive(),
        conversationStopSec: conversationStreamingStopSec,
        conversationOnStopped: conversationStreamingOnStopped,
        previewAutoEnd: preview?.getAutoEndOfSpeech?.() === true,
      });
      if (route === "off") return;
      // Paused or still loading the model: the ring holds a frozen/quiet
      // tail, which used to read as silence and auto-submit a paused
      // dictation. Hold the silence clocks until live capture resumes.
      let ctlState = null;
      try {
        ctlState = streamController.getState?.() || null;
      } catch {}
      if (ctlState && (ctlState.paused || ctlState.status !== "streaming")) {
        lastAudioActiveMs = null;
        streamingLastPartialMs = Date.now();
        return;
      }
      const useConv = route === "conversation";
      const convSec = conversationStreamingStopSec;
      let audioSilent = false;
      let rms = 0;
      try {
        const pcm = streamController.peekPcm?.(STREAM_WAVE_BYTES);
        if (pcm && pcm.length >= 2) {
          let sum = 0;
          const samples = Math.floor(pcm.length / 2);
          for (let i = 0; i + 1 < pcm.length; i += 2) {
            const s = pcm.readInt16LE(i) / 32768;
            sum += s * s;
          }
          rms = Math.sqrt(sum / samples);
          if (rms < 0.01) audioSilent = true;
        }
      } catch {}
      if (audioSilent) {
        if (lastAudioActiveMs === null) lastAudioActiveMs = Date.now();
      } else {
        lastAudioActiveMs = null;
      }
      const audioSilentMs = lastAudioActiveMs ? Date.now() - lastAudioActiveMs : 0;
      const last = streamingLastPartialMs;
      const elapsed = last ? Date.now() - last : 0;
      const threshold = useConv && convSec > 0 ? convSec * 1000 : AUTO_END_SILENCE_MS;
      if (useConv) {
        if (audioSilent && audioSilentMs > threshold) {
          sttLog(
            "stream.autoEnd",
            `conversation triggered rms=${rms.toFixed(4)} silentMs=${audioSilentMs}ms`,
          );
          disableStreamAutoEnd();
          try {
            conversationStreamingOnStopped?.();
          } catch {}
          return;
        }
        if (last && elapsed > threshold * 2) {
          sttLog(
            "stream.autoEnd",
            `conversation triggered (partial) rms=${rms.toFixed(4)} elapsed=${elapsed}ms`,
          );
          disableStreamAutoEnd();
          try {
            conversationStreamingOnStopped?.();
          } catch {}
        }
        return;
      }
      if (audioSilent && audioSilentMs > threshold) {
        sttLog(
          "stream.autoEnd",
          `triggered by silence (audio) rms=${rms.toFixed(4)} silentMs=${audioSilentMs}ms`,
        );
        disableStreamAutoEnd();
        void finalizeStreamingDictation({});
        return;
      }
      if (last && elapsed > threshold * 2) {
        sttLog(
          "stream.autoEnd",
          `triggered by silence (partial only) rms=${rms.toFixed(4)} elapsed=${elapsed}ms`,
        );
        disableStreamAutoEnd();
        void finalizeStreamingDictation({});
      }
    }, 500);
    if (typeof streamAutoEndTimer.unref === "function") streamAutoEndTimer.unref();
  }

  function disableStreamAutoEnd() {
    if (streamAutoEndTimer) {
      clearInterval(streamAutoEndTimer);
      streamAutoEndTimer = null;
    }
  }
  // Warm server lease retained across dictations: the idle controller (mic
  // fully stopped, server still loaded) parks here between sessions. At most
  // one warm lease ever exists; the next start reuses it when the model key
  // matches, or tears it down first when the model/language changed.
  let warmStreamController = null;
  let warmStreamModelKey = null;

  function warmControllerPort(controller) {
    try {
      return controller?.getServerPort?.() ?? undefined;
    } catch {
      return undefined;
    }
  }

  function currentStreamModelKey(port) {
    return streamModelKey(getModelPath(kv), getLanguage(kv), port);
  }

  function disposeWarmStreamController() {
    if (warmStreamController) {
      const c = warmStreamController;
      warmStreamController = null;
      warmStreamModelKey = null;
      try {
        const maybe = c.dispose?.();
        if (maybe && typeof maybe.catch === "function") maybe.catch(() => {});
      } catch {}
    }
  }

  function retainWarmStreamController(controller) {
    // Single-lease invariant: never park a second handle alongside one.
    if (warmStreamController && warmStreamController !== controller) {
      try {
        const maybe = controller.dispose?.();
        if (maybe && typeof maybe.catch === "function") maybe.catch(() => {});
      } catch {}
      return;
    }
    warmStreamController = controller;
    warmStreamModelKey = currentStreamModelKey(warmControllerPort(controller));
  }

  async function startStreamingDictation() {
    if (streamingDictationActive || streamStarting || finalizingController || streamDisposed)
      return false;
    if (recording || processing) {
      toast("STT busy, please wait...");
      return false;
    }
    if (liveNotesActive()) {
      toast("Live notes recording - stop it first (/voice-notes-stop)", "warning");
      return false;
    }
    if (conversationActive() && !conversationStreamingEnabled) {
      toast("Conversation mode is on - use the conversation key to exit", "warning");
      return false;
    }
    const myGen = ++streamGeneration;
    // Held until start resolves (finally): a second press during the
    // import/preview window must not launch a second session.
    streamStarting = true;
    // Model/language change tears down the warm lease first so the next
    // start loads the new model instead of reusing the stale server. The
    // key carries the bound server port, so a lease on a different port is
    // never mistaken for a matching one.
    if (
      warmStreamController &&
      warmStreamModelKey !== currentStreamModelKey(warmControllerPort(warmStreamController))
    ) {
      disposeWarmStreamController();
    }
    let controller = null;
    let reusedWarm = false;
    try {
      const { createStreamingController } = await import("./stt/streaming/streaming-stt.js");
      const { createStreamingEditorAdapter } = await import("./stt/streaming/streaming-editor.js");
      const focused = renderer?.currentFocusedRenderable || null;
      const target = focused && typeof focused.insertText === "function" ? focused : null;
      const editor =
        preview ||
        createStreamingEditorAdapter({
          toast: (message, variant) => api.ui.toast({ message, variant, duration: 2500 }),
          getFocused: () => renderer?.currentFocusedRenderable || null,
        });
      if (preview) await preview.begin();
      else editor.begin(target);
      sttLog("stream.begin", `preview=${preview ? "yes" : "no"}`);
      // Clickable pause lives on the preview line (v2 slot). The toggle
      // action funnels through the same pause/resume path as the command.
      try {
        preview?.setToggleAction?.(() => toggleStreamingPause());
      } catch {}
      // Restore persisted toggle state from kv so it survives restarts.
      // No per-preview auto-submit toggle: the fixed Auto button owns the
      // single global flag, resolved live at delivery.
      try {
        const savedAutoEnd = kv.get("stt.autoEndOfSpeech");
        if (savedAutoEnd === true || savedAutoEnd === false) {
          preview?.setAutoEndOfSpeech?.(savedAutoEnd);
        }
      } catch {}
      try {
        preview?.setAutoEndToggleAction?.(() => {
          const next = !preview.getAutoEndOfSpeech?.();
          preview.setAutoEndOfSpeech?.(next);
          // Persist so it survives restarts.
          try {
            kv.set("stt.autoEndOfSpeech", next);
          } catch {}
          sttLog("stream.autoEnd", `toggled to ${next}`);
          // If recording is active, enable/disable silence auto-finalize.
          if (streamingDictationActive && streamController) {
            if (next) {
              enableStreamAutoEnd();
            } else {
              disableStreamAutoEnd();
            }
          }
        });
      } catch {}
      if (streamDisposed || myGen !== streamGeneration) {
        preview?.clear();
        return false;
      }
      const sessionCallbacks = (ed) => ({
        onPartial: (p) => {
          if (streamDisposed || myGen !== streamGeneration) return;
          try {
            noteStreamingPartial(p);
          } catch {}
          try {
            ed.applyPartial(p);
          } catch {}
          sttLog(
            "stream.partial",
            `stable=${(p?.stableText || "").length} tentative=${(p?.tentativeText || "").length}`,
          );
        },
        onStateChange: (s) => {
          sttLog("stream.state", s);
          try {
            if (s === "streaming") {
              updateStreamingToast("● Streaming dictation — listening");
            }
          } catch {}
        },
        onError: (e) => {
          logger?.log("STT", `Streaming error: ${e?.code || ""} ${e?.message || ""}`, "error");
          try {
            clearStreamingToast();
          } catch {}
          toast(
            `Streaming STT error: ${e?.message || "unknown"}${e?.hasFallbackAudio ? " (audio kept)" : ""}`,
            "error",
          );
        },
      });
      if (warmStreamController) {
        controller = warmStreamController;
        warmStreamController = null;
        warmStreamModelKey = null;
        reusedWarm = true;
        // Rebind to the new session's editor: the warm lease stays, but
        // partials/errors must never reach the previous session's editor.
        try {
          controller.updateCallbacks?.(sessionCallbacks(editor));
        } catch {}
      } else {
        controller = createStreamingController({
          windowMs: streamTimings.windowMs,
          cadenceMs: streamTimings.cadenceMs,
          model: { modelPath: getModelPath(kv), language: getLanguage(kv) },
          logger,
          sampleRate: getAudioSampleRate(),
          captureCmd: getSttCaptureCmd(),
          ...sessionCallbacks(editor),
          // Test seam (stage 3 e2e): deterministic capture/transcriber/clock
          // without a mic. Absent in production; the default path is
          // unchanged when deps.streamingControllerOpts is unset.
          ...deps.streamingControllerOpts,
        });
      }
      streamEditor = editor;
      streamTarget = target;
      streamController = controller;
      if (!controller.start()) {
        streamEditor = null;
        streamTarget = null;
        streamController = null;
        // start() refused (already running): park the warm handle back so
        // the lease is never dropped on a refusal path.
        if (reusedWarm) retainWarmStreamController(controller);
        return false;
      }
      __setStreamingActive(true);
      sttLog("stream.started", `reusedWarm=${reusedWarm}`);
      // Live waveform rides the v2 preview slot next to the live transcript.
      // v1 has no persistent preview surface; its batch wave is unchanged.
      if (preview) {
        __resetStreamWave();
        let pcmLogCount = 0;
        preview.startWave?.(() => {
          const pcm = controller.peekPcm?.(STREAM_WAVE_BYTES);
          if (pcmLogCount < 3 && pcm) {
            pcmLogCount += 1;
            sttLog("stream.pcm", `bytes=${pcm.length}`);
          }
          return pcm ? waveLevelsFromPcm(pcm) : null;
        });
        // Auto-end: always run the timer; it checks the preview's toggle
        // state internally so toggling mid-recording works without restart.
        enableStreamAutoEnd();
      }
      // Sticky, never silent: covers the cold model load ("Loading…") until
      // the controller reports streaming, then live capture with elapsed
      // time. Partial preview toasts continue alongside via the editor.
      showStreamingToast("Loading speech model…", {
        slowAfterMs: Math.max(2000, streamTimings.cadenceMs * 2),
      });
      logger?.log("STT", "Streaming dictation started", "debug");
      return true;
    } catch (err) {
      preview?.clear();
      sttLog("stream.start-failed", err?.message || String(err));
      logger?.log("STT", `Streaming start failed: ${err?.message || err}`, "error");
      try {
        clearStreamingToast();
      } catch {}
      toast(`Streaming STT failed to start: ${err?.message || err}`, "error");
      streamEditor = null;
      streamTarget = null;
      streamController = null;
      if (reusedWarm && controller) {
        // Setup failed after taking the warm handle: park it back so the
        // lease survives a transient editor/import failure.
        retainWarmStreamController(controller);
      } else if (controller) {
        // Fresh handle that never became a session: release any partial
        // lease so a failed start never leaks a server ref.
        try {
          const maybe = controller.dispose?.();
          if (maybe && typeof maybe.catch === "function") maybe.catch(() => {});
        } catch {}
      }
      return false;
    } finally {
      streamStarting = false;
    }
  }

  // Pause/resume for live dictation: freezes the mic (SIGSTOP) and skips
  // recognition ticks so paused spans cost nothing and never enter the
  // transcript. The record key resumes a paused session instead of
  // finalizing it; explicit stop stays on /stt-stop.
  function toggleStreamingPause() {
    if (!streamingDictationActive || !streamController) {
      sttLog("stream.pause", "request ignored: no active streaming session");
      return false;
    }
    let pausedNow = false;
    let status = "?";
    try {
      const s = streamController.getState?.() || {};
      pausedNow = !!s.paused;
      status = s.status || "?";
    } catch {
      sttLog("stream.pause", "request ignored: controller state unreadable");
      return false;
    }
    sttLog("stream.pause", `request status=${status} paused=${pausedNow}`);
    if (pausedNow) {
      let ok = false;
      try {
        ok = streamController.resume() === true;
      } catch {
        ok = false;
      }
      if (ok) {
        preview?.setPaused?.(false);
        updateStreamingToast("● Streaming dictation — listening");
        sttLog("stream.resume", "ok");
      }
      return ok;
    }
    let ok = false;
    try {
      ok = streamController.pause?.() === true;
    } catch {
      ok = false;
    }
    if (ok) {
      preview?.setPaused?.(true);
      updateStreamingToast("⏸ Dictation paused — press record or click ▶ to resume");
      sttLog("stream.pause", "ok");
    }
    return ok;
  }

  // Pause/resume entry point shared by the /stt-pause command. Returns false
  // with a hint toast when there is nothing pausable.
  async function pauseStreamingDictation() {
    if (!streamingDictationActive || !streamController) {
      toast("No streaming dictation in progress", "warning");
      return false;
    }
    if (!toggleStreamingPause()) {
      toast("Pause unavailable right now - use /stt-stop to cancel", "warning");
      return false;
    }
    return true;
  }

  // Finalize: stop the controller (single tail transcription, no LLM),
  // commit the editor range, then insert EXACTLY once via the focused-input
  // helper. Never falls through to primary-chat appendPrompt. When `submit`
  // is set, submits ONLY via the captured target's own submit().
  // Warm-lease semantics: the mic is fully stopped by stop(), but the
  // server lease is RETAINED across dictations (parked as the single warm
  // handle) and released only when the stop result proves the server itself
  // is at fault, on model/language change, or on plugin unload.
  /**
   * @param {{ submit?: boolean | (() => boolean), insert?: boolean }} [opts]
   */
  async function finalizeStreamingDictation({ submit, insert = true } = {}) {
    if (!streamingDictationActive || !streamController) return null;
    sttLog("stream.finalize", `submit=${submit} insert=${insert}`);
    disableStreamAutoEnd();
    const controller = streamController;
    const editor = streamEditor;
    const target = streamTarget;
    const myGen = streamGeneration;
    finalizingController = controller;
    if (preview) processing = true;
    streamController = null;
    streamEditor = null;
    streamTarget = null;
    __setStreamingActive(false);
    // Never silent between the second keypress and the insert: the stop-tail
    // transcription can take ~a second while the screen otherwise freezes.
    try {
      updateStreamingToast("Finalizing…");
    } catch {}
    let done = null;
    try {
      done = await controller.stop();
    } catch (err) {
      finalizingController = null;
      if (preview) processing = false;
      logger?.log("STT", `Streaming stop failed: ${err?.message || err}`, "error");
      try {
        clearStreamingToast();
      } catch {}
      toast(`Streaming stop failed: ${err?.message || err}`, "error");
      // Mid-stop throw: preserve the lease (transient/per-dictation until
      // proven otherwise); the next start re-probes server readiness.
      retainWarmStreamController(controller);
      return null;
    }
    finalizingController = null;
    if (streamDisposed || myGen !== streamGeneration) {
      preview?.clear();
      if (preview) processing = false;
      await controller.dispose?.();
      return null;
    }
    // The stop-tail resolved: the sticky status served its purpose (no
    // silent gap during the wait). Clear before the terminal toasts below.
    try {
      clearStreamingToast();
    } catch {}
    if (done?.error && isStreamingServerFault(done.error)) {
      if (preview) processing = false;
      // Server at fault (not ready / transcribe failure): release the lease
      // so the next start cold-loads from a clean handle instead of reusing
      // a dead server.
      toast(`Streaming stopped with error: ${done.error?.message || done.error}`, "warning");
      try {
        editor?.finalize((done?.text || editor?.getTranscript?.() || "").trim());
      } catch {}
      try {
        await controller.dispose?.();
      } catch {}
      return { text: (done?.text || "").trim(), error: done.error };
    }
    const text = (done?.text || editor?.getTranscript?.() || "").trim();
    if (done?.error) {
      toast(`Streaming stopped with error: ${done.error?.message || done.error}`, "warning");
    }
    // editor.finalize already writes the owned range for live-capable
    // targets (inserted:true) — inserting again would duplicate. Only the
    // fallback path (no range API) needs the single insert below, routed
    // through the captured target, never the current focus.
    let fin = null;
    try {
      fin = editor?.finalize(text);
    } catch {}
    // Every path below retains the warm lease: the mic stopped, the server
    // stays loaded for the next dictation.
    if (!text) {
      if (preview) processing = false;
      toast("No speech detected", "warning");
      retainWarmStreamController(controller);
      return { text: "" };
    }
    // submit is tri-state: true forces submit, false forces append,
    // undefined (and functions) follow the single global auto-submit flag
    // live at delivery time — a mid-recording toggle wins.
    const doSubmit =
      submit === true ||
      (typeof submit === "function" ? submit() === true : submit === undefined && autoSubmitNow());
    if (fin?.inserted) {
      logger?.log("STT", `Streaming finalized via owned range chars=${text.length}`, "debug");
      setLastInsertedText(text);
      if (doSubmit) {
        if (target && typeof target.submit === "function") {
          try {
            target.submit();
            toast("Streaming transcription submitted", "success");
          } catch (err) {
            toast(`Streaming submit failed: ${err?.message || err}`, "error");
          }
        } else {
          toast("Target cannot submit - text inserted, not submitted", "warning");
        }
      } else {
        toast("Streaming transcription added", "success");
      }
      if (preview) processing = false;
      retainWarmStreamController(controller);
      return { text, inserted: true };
    }
    // Fallback session: single insert into the captured target only. A
    // missing/unusable target retains the transcript via toast instead of
    // redirecting into chat or the current focus.
    let inserted = false;
    if (insert) {
      if (target && typeof target.insertText === "function") {
        try {
          target.insertText(text);
          inserted = true;
        } catch {
          inserted = false;
        }
      } else {
        inserted = insertIntoFocusedInput(renderer, text, false);
      }
    }
    if (insert && !inserted) {
      logger?.log("STT", "Streaming finalize: no editable field, transcript retained", "warn");
      toast("No editable field - dictated text kept (not inserted elsewhere)", "warning");
      if (preview) processing = false;
      retainWarmStreamController(controller);
      return { text, inserted: false };
    }
    if (insert) {
      logger?.log("STT", `Streaming finalized chars=${text.length}`, "debug");
      setLastInsertedText(text);
      if (doSubmit) {
        if (target && typeof target.submit === "function") {
          try {
            target.submit();
            toast("Streaming transcription submitted", "success");
          } catch (err) {
            toast(`Streaming submit failed: ${err?.message || err}`, "error");
          }
        } else {
          toast("Target cannot submit - text inserted, not submitted", "warning");
        }
      } else {
        toast("Streaming transcription added", "success");
      }
    }
    if (preview) processing = false;
    retainWarmStreamController(controller);
    return { text, inserted };
  }

  // Cancel: drop the session and remove ONLY plugin-owned dictated text.
  // Fallback path inserted nothing, so there is nothing to remove. The mic
  // is fully stopped by cancel(); the server lease is retained warm for the
  // next dictation (user cancel is per-dictation, never a server fault).
  async function cancelStreamingDictation() {
    streamGeneration += 1;
    sttLog("stream.cancel");
    disableStreamAutoEnd();
    preview?.clear();
    if (preview && processing) cancelRecording(logger);
    if (finalizingController) {
      const finishing = finalizingController;
      finalizingController = null;
      cancelRecording(logger);
      await finishing.cancel();
      processing = false;
      clearStreamingToast();
      return true;
    }
    if (!streamingDictationActive || !streamController) return false;
    const controller = streamController;
    const editor = streamEditor;
    streamController = null;
    streamEditor = null;
    streamTarget = null;
    __setStreamingActive(false);
    try {
      await controller.cancel();
    } catch {}
    let removed = 0;
    try {
      removed = editor?.cancel?.()?.removedChars || 0;
    } catch {}
    retainWarmStreamController(controller);
    logger?.log("STT", `Streaming cancelled removedChars=${removed}`, "debug");
    try {
      clearStreamingToast();
    } catch {}
    toast("Streaming dictation cancelled");
    return true;
  }

  api.lifecycle?.onDispose?.(() => {
    streamDisposed = true;
    streamGeneration += 1;
    preview?.clear();
    if (finalizingController) {
      const finishing = finalizingController;
      finalizingController = null;
      void finishing.dispose?.();
    }
    // Unload mid-recording must not orphan the sox child: cancel kills it,
    // bumps the pipeline generation (late transcriptions are dropped), and
    // clears the sticky toast. processing is not owned by cancel, reset it
    // here so a later registration starts from idle.
    try {
      cancelRecording(logger);
    } catch {}
    processing = false;
    if (streamController) {
      const c = streamController;
      streamController = null;
      streamEditor = null;
      streamTarget = null;
      __setStreamingActive(false);
      try {
        const maybe = c.dispose?.();
        if (maybe && typeof maybe.catch === "function") maybe.catch(() => {});
      } catch {}
    }
    try {
      clearStreamingToast();
    } catch {}
    // Plugin unload releases the parked warm lease: the model must not stay
    // loaded after the plugin is gone.
    disposeWarmStreamController();
  });

  // Low-level seams extracted as standalone functions (Phase C1) so the
  // extracted controller module can reach them through the context.
  function setSilenceAutoFinalize(sec, onStopped) {
    conversationSilenceStopSec = sec && sec > 0 ? sec : null;
    conversationOnStopped = typeof onStopped === "function" ? onStopped : null;
  }
  function setConversationStreamingFinalize(sec, onStopped) {
    conversationStreamingStopSec = sec && sec > 0 ? sec : null;
    conversationStreamingOnStopped = typeof onStopped === "function" ? onStopped : null;
    if (conversationStreamingStopSec) enableStreamAutoEnd();
    else disableStreamAutoEnd();
  }
  function setConversationStreamingEnabled(v) {
    conversationStreamingEnabled = !!v;
  }

  const sttCtx2 = createSttContext({
    api,
    kv,
    complete,
    prompts,
    opts,
    logger,
    toast,
    state: {},
  });
  sttCtx2.getRecording = () => recording;
  sttCtx2.setRecording = (v) => {
    recording = v;
  };
  sttCtx2.getProcessing = () => processing;
  sttCtx2.setProcessing = (v) => {
    processing = v;
  };
  sttCtx2.getStreamingActive = () => streamingDictationActive;
  sttCtx2.setStreamingActive = (v) => {
    streamingDictationActive = v;
  };
  sttCtx2.setSilenceAutoFinalize = setSilenceAutoFinalize;
  sttCtx2.setConversationStreamingFinalize = setConversationStreamingFinalize;
  sttCtx2.setConversationStreamingEnabled = setConversationStreamingEnabled;
  sttCtx2.startLoopRecording = startLoopRecording;
  sttCtx2.startStreamingDictation = startStreamingDictation;
  sttCtx2.finalizeStreamingDictation = finalizeStreamingDictation;
  sttCtx2.cancelStreamingDictation = cancelStreamingDictation;
  sttCtx2.cancelRecording = (lg) => cancelRecording(lg || logger);
  sttCtx2.discardTurn = discardTurn;
  sttCtx2.transcribeTurn = () =>
    transcribeTurn(kv, complete, client, api, toast, systemPrompt, logger);
  sttCtx2.submitTurnText = (text) =>
    submitTurnText(client, client.tui?.v2 ? null : renderer, toast, text, logger);
  sttCtx2.systemPrompt = systemPrompt;
  sttCtx2.client = client;
  sttCtx2.renderer = renderer;
  sttCtx2.toast = toast;
  sttCtx2.complete = complete;
  sttCtx2.kv = kv;
  sttCtx2.api = api;
  sttCtx2.logger = logger;
  sttCtx2.opts = opts;
  sttCtx2.prompts = prompts;
  const autoSubmit = sttAutoSubmitEnabled();
  const autoSubmitNow = () => sttAutoSubmitEnabled();
  sttCtx2.__setStopHint = __setStopHint;

  sttCtx2.sttApiModel = sttApiModel;
  sttCtx2.disposeWarmStreamController = disposeWarmStreamController;

  // Command-surface wiring (Phase C): expose everything the extracted
  // commands module needs through ctx so lib/stt/commands.js can build the
  // command array without touching closures. Additive only.
  sttCtx2.sttApiEndpoint = sttApiEndpoint;
  sttCtx2.autoSubmit = autoSubmit;
  sttCtx2.autoSubmitNow = autoSubmitNow;
  sttCtx2.currentSttMode = currentSttMode;
  sttCtx2.conversationActive = conversationActive;
  sttCtx2.conversationHooks = conversationHooks;
  sttCtx2.liveNotesActive = liveNotesActive;
  sttCtx2.getStreamingActive = () => streamingDictationActive;
  sttCtx2.setStreamingActive = (v) => {
    streamingDictationActive = v;
  };
  sttCtx2.processing = () => processing;
  sttCtx2.setProcessing = (v) => {
    processing = v;
  };
  sttCtx2.recording = () => recording;
  sttCtx2.setRecording = (v) => {
    recording = v;
  };
  sttCtx2.clearRecordingToast = clearRecordingToast;
  sttCtx2.doTranscribePipeline = doTranscribePipeline;
  sttCtx2.beginCorrection = (extra = {}) =>
    beginCorrection({
      toast,
      renderer,
      ...extra,
    });
  sttCtx2.isCorrecting = isCorrecting;
  sttCtx2.clearCorrection = clearCorrection;
  sttCtx2.readComposerText = readComposerText;
  sttCtx2.tryReplaceComposerText = tryReplaceComposerText;
  sttCtx2.startLoopRecording = startLoopRecording;
  sttCtx2.startStreamingDictation = startStreamingDictation;
  sttCtx2.finalizeStreamingDictation = finalizeStreamingDictation;
  sttCtx2.cancelStreamingDictation = cancelStreamingDictation;
  sttCtx2.toggleStreamingPause = toggleStreamingPause;
  sttCtx2.pauseStreamingDictation = pauseStreamingDictation;
  sttCtx2.cancelRecording = (lg) => cancelRecording(lg || logger);
  sttCtx2.getLanguage = getLanguage;
  sttCtx2.getModelName = getModelName;
  sttCtx2.getApiModels = getApiModels;
  sttCtx2.getRemoteConfig = getRemoteConfig;
  sttCtx2.buildRemoteCaptureCmd = buildRemoteCaptureCmd;
  sttCtx2.getSttCaptureCmd = getSttCaptureCmd;
  sttCtx2.backend = backend;
  sttCtx2.listInputDevices = listInputDevices;
  sttCtx2.MODELS = MODELS;
  sttCtx2.LANGUAGES = LANGUAGES;
  sttCtx2.getSttEngine = (k = kv) => getSttEngine(k, sttPluginOpts);
  sttCtx2.getGipformerConfig = (k = kv) => getGipformerConfig(k, sttPluginOpts);
  sttCtx2.kb = kb;
  sttCtx2.sttLog = sttLog;
  sttCtx2.sttAutoSubmitEnabled = sttAutoSubmitEnabled;
  sttCtx2.client = client;
  sttCtx2.renderer = renderer;
  sttCtx2.systemPrompt = systemPrompt;
  sttCtx2.execSync = execSync;
  sttCtx2.spawnSync = spawnSync;
  sttCtx2.streamController = () => streamController;
  sttCtx2.setStreamController = (v) => {
    streamController = v;
  };
  sttCtx2.streamGeneration = () => streamGeneration;
  sttCtx2.setStreamGeneration = (v) => {
    streamGeneration = v;
  };
  sttCtx2.streamDisposed = () => streamDisposed;
  sttCtx2.setStreamDisposed = (v) => {
    streamDisposed = v;
  };
  sttCtx2.finalizingController = () => finalizingController;
  sttCtx2.setFinalizingController = (v) => {
    finalizingController = v;
  };
  sttCtx2.autoSubmitNow = autoSubmitNow;

  const controller = createControllerMethods(sttCtx2);

  const commands = createCommands(sttCtx2);

  // Threaded context (Phase C1 scaffolding): built once here so the extracted
  // controller/commands modules can take a single object instead of 30 closure
  // vars. Behavior is unchanged - the context is additive for now.
  const sttCtx = createSttContext({
    api,
    kv,
    complete,
    prompts,
    opts,
    logger,
    toast,
    state: {},
  });
  sttCtx.controller = controller;
  return { commands, controller, context: sttCtx };
}

export function parsePactlSources(jsonText) {
  const data = JSON.parse(jsonText);
  return (Array.isArray(data) ? data : [])
    .filter((s) => s?.name && !s.name.endsWith(".monitor"))
    .map((s) => ({
      name: s.name,
      label: s.description ? `${s.description} (${s.name})` : s.name,
    }));
}

export function parsePactlSourcesShort(text) {
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((name) => name && !name.endsWith(".monitor"))
    .map((name) => ({ name, label: name }));
}

function listInputDevices(backend) {
  if (backend === "coreaudio") {
    try {
      const json = execSync("system_profiler SPAudioDataType -json 2>/dev/null", {
        encoding: "utf-8",
        timeout: 5000,
      });
      const data = JSON.parse(json);
      return (data.SPAudioDataType?.[0]?._items || [])
        .filter((d) => d.coreaudio_input_source != null)
        .map((d) => {
          const name = d.coreaudio_device_name || d._name;
          return { name, label: name };
        });
    } catch {
      return [];
    }
  }
  if (backend === "pulseaudio") {
    try {
      const json = execSync("pactl -f json list sources 2>/dev/null", {
        encoding: "utf-8",
        timeout: 5000,
      });
      return parsePactlSources(json);
    } catch {
      try {
        const out = execSync("pactl list sources short 2>/dev/null", {
          encoding: "utf-8",
          timeout: 5000,
        });
        return parsePactlSourcesShort(out);
      } catch {
        return [];
      }
    }
  }
  return [];
}
