// Streaming dictation session over an already-open MicStream.
//
// Audio lane: every mic chunk goes into a PCM spool from t=0 (capped at
// maxSpoolSec; beyond the cap the oldest audio is dropped and the full-
// utterance final decode is no longer possible). Level and silence are
// computed from the same audio.
//
// Recognition lane: every cadenceMs a tick transcribes the last windowMs of
// audio and folds the hypothesis into the transcript tracker. At most one
// request is in flight; a tick that fires while one is running is skipped.
// Two consecutive tick failures are tolerated, the third ends the session
// with onError.
//
// finish(): stops ticks, aborts the in-flight tick, stops the mic, then runs
// one final decode. Short utterances (<= fullFinalMaxSec, spool complete) are
// decoded whole and that result always wins when non-empty. Longer ones
// decode only the audio from the window where stable text last advanced and
// join it onto the tracker. Any final failure falls back to the tracker text.

import type {
  Logger,
  MicError,
  MicStream,
  StreamingPartial,
  SttLanguage,
  Transcriber,
} from "../types.ts";
import { errorMessage } from "../types.ts";
import { createTranscriptTracker } from "./transcript.ts";

export interface StreamingClock {
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface StreamingSessionOptions {
  readonly mic: MicStream;
  readonly transcriber: Transcriber;
  readonly language: SttLanguage;
  readonly cadenceMs?: number;
  readonly windowMs?: number;
  readonly fullFinalMaxSec?: number;
  readonly maxSpoolSec?: number;
  /** RMS (0..1) at or above which a 20ms frame counts as voiced. */
  readonly voiceRms?: number;
  readonly onPartial: (p: StreamingPartial) => void;
  readonly onError: (err: Error) => void;
  readonly logger?: Logger;
  readonly clock?: StreamingClock;
}

export interface StreamingSession {
  start(): void;
  pause(): void;
  resume(): void;
  readonly paused: boolean;
  /** RMS (0..1) of the last ~100ms of audio; 0 while paused. */
  level(): number;
  /**
   * ms since the last voiced audio while live. 0 while paused, before any
   * audio arrived, and during the first second of unvoiced audio.
   */
  silenceMs(): number;
  /** Final transcript, trimmed ("" when nothing was said or on cancel). */
  finish(): Promise<string>;
  cancel(): void;
}

const MAX_TICK_ERRORS = 3;
const LEVEL_WINDOW_MS = 100;
const VOICE_FRAME_MS = 20;
const SILENCE_GRACE_MS = 1000;
const FINAL_TIMEOUT_MIN_MS = 60_000;
const SCOPE = "STT";

const realClock: StreamingClock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createStreamingSession(opts: StreamingSessionOptions): StreamingSession {
  const { mic, transcriber, language, logger } = opts;
  const clock = opts.clock ?? realClock;
  const cadenceMs = opts.cadenceMs ?? 1000;
  const windowMs = opts.windowMs ?? 10_000;
  const fullFinalMaxMs = (opts.fullFinalMaxSec ?? 90) * 1000;
  const voiceRms = opts.voiceRms ?? 0.01;
  const sampleRate = mic.format.sampleRate;
  const bytesPerMs = (sampleRate * 2) / 1000;
  const windowBytes = alignDown(Math.round(windowMs * bytesPerMs));
  const spool = createSpool(alignDown(Math.round((opts.maxSpoolSec ?? 600) * 1000 * bytesPerMs)));
  const tracker = createTranscriptTracker();

  let started = false;
  let paused = false;
  let finishing = false;
  let disposed = false;
  let failed = false;
  let errorEmitted = false;
  let timer: unknown = null;
  let tickController: AbortController | null = null;
  let finalController: AbortController | null = null;
  let finishPromise: Promise<string> | null = null;
  let tickErrors = 0;
  let lastTickEnd = 0;
  /** Start byte of the window in which stable text last advanced. */
  let stableStartByte: number | null = null;
  let lastEmitted: StreamingPartial = { stable: "", tentative: "" };
  let firstAudioAt: number | null = null;
  let lastVoiceAt: number | null = null;
  const unsubscribers: Array<() => void> = [];

  const toMs = (bytes: number): number => bytes / bytesPerMs;
  const live = (): boolean => started && !disposed && !finishing && !failed;

  function log(message: string, level: "debug" | "info" | "warn" | "error" = "debug"): void {
    logger?.log(SCOPE, message, level);
  }

  function emitError(err: Error): void {
    if (disposed || finishing || errorEmitted) return;
    errorEmitted = true;
    try {
      opts.onError(err);
    } catch (cbErr) {
      log(`onError callback threw: ${errorMessage(cbErr)}`, "warn");
    }
  }

  function emitPartial(p: StreamingPartial): void {
    if (p.stable === lastEmitted.stable && p.tentative === lastEmitted.tentative) return;
    lastEmitted = p;
    try {
      opts.onPartial(p);
    } catch (cbErr) {
      log(`onPartial callback threw: ${errorMessage(cbErr)}`, "warn");
    }
  }

  function clearTimer(): void {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(): void {
    clearTimer();
    timer = clock.setTimeout(() => {
      timer = null;
      if (!live() || paused) return;
      schedule();
      void tick();
    }, cadenceMs);
  }

  function abortTick(): void {
    const controller = tickController;
    tickController = null;
    controller?.abort();
  }

  function onData(chunk: Buffer): void {
    if (disposed || paused || chunk.length === 0) return;
    const before = spool.total;
    spool.push(chunk);
    const now = clock.now();
    if (firstAudioAt === null) firstAudioAt = now;
    const pcm = spool.slice(alignUp(before), alignDown(spool.total));
    if (isVoiced(pcm, Math.max(2, alignDown(Math.round(VOICE_FRAME_MS * bytesPerMs))), voiceRms)) {
      lastVoiceAt = now;
    }
  }

  function onMicError(err: MicError): void {
    if (disposed || finishing) return;
    failed = true;
    clearTimer();
    abortTick();
    emitError(new Error(err.hint ? `${err.message} ${err.hint}` : err.message));
  }

  async function tick(): Promise<void> {
    if (!live() || paused || tickController !== null) return;
    const end = alignDown(spool.total);
    if (end <= lastTickEnd) return; // no new audio since the last tick
    const start = Math.max(alignUp(spool.start), end - windowBytes);
    lastTickEnd = end;
    const window = { startMs: toMs(start), endMs: toMs(end) };
    const controller = new AbortController();
    tickController = controller;
    try {
      const text = await transcriber.transcribe(pcmToWav(spool.slice(start, end), sampleRate), {
        language,
        signal: controller.signal,
      });
      if (!live() || controller.signal.aborted) return;
      tickErrors = 0;
      const before = tracker.current().stable;
      const partial = tracker.push(text, window);
      if (partial.stable !== before) stableStartByte = start;
      emitPartial(partial);
    } catch (err) {
      if (!live() || controller.signal.aborted) return;
      tickErrors += 1;
      log(`stream tick failed (${tickErrors}/${MAX_TICK_ERRORS}): ${errorMessage(err)}`, "warn");
      if (tickErrors >= MAX_TICK_ERRORS) {
        failed = true;
        clearTimer();
        emitError(
          new Error(
            `Live transcription failed ${MAX_TICK_ERRORS} times in a row (${firstLine(errorMessage(err))}). Check the STT engine, then try again.`,
          ),
        );
      }
    } finally {
      if (tickController === controller) tickController = null;
    }
  }

  async function decodeFinal(pcm: Buffer): Promise<string> {
    const controller = new AbortController();
    finalController = controller;
    const timeoutMs = Math.max(FINAL_TIMEOUT_MIN_MS, 3 * toMs(pcm.length));
    let handle: unknown = null;
    const timeout = new Promise<never>((_, reject) => {
      handle = clock.setTimeout(() => {
        controller.abort();
        reject(new Error(`final transcription timed out after ${Math.round(timeoutMs)}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        transcriber.transcribe(pcmToWav(pcm, sampleRate), { language, signal: controller.signal }),
        timeout,
      ]);
    } finally {
      if (handle !== null) clock.clearTimeout(handle);
      if (finalController === controller) finalController = null;
    }
  }

  async function finalText(): Promise<string> {
    const fallback = (): string => tracker.text().trim();
    const end = alignDown(spool.total);
    const begin = alignUp(spool.start);
    if (end <= begin) return fallback();

    if (spool.complete && toMs(end) <= fullFinalMaxMs) {
      try {
        const text = (await decodeFinal(spool.slice(0, end))).trim();
        log(`final full decode ${Math.round(toMs(end))}ms -> ${text.length} chars`);
        if (text) return text;
      } catch (err) {
        if (disposed) return "";
        log(`final full decode failed, using live transcript: ${errorMessage(err)}`, "warn");
      }
      return fallback();
    }

    // Long or truncated session: decode from the window where stable last
    // advanced (it contains stable's tail for anchoring) to the end.
    const tailStart = Math.max(begin, stableStartByte ?? 0);
    if (tailStart >= end) return fallback();
    try {
      const text = (await decodeFinal(spool.slice(tailStart, end))).trim();
      log(`final tail decode ${Math.round(toMs(end - tailStart))}ms -> ${text.length} chars`);
      if (text) tracker.push(text, { startMs: toMs(tailStart), endMs: toMs(end) });
    } catch (err) {
      if (disposed) return "";
      log(`final tail decode failed, using live transcript: ${errorMessage(err)}`, "warn");
    }
    return fallback();
  }

  async function runFinish(): Promise<string> {
    try {
      await mic.stop();
    } catch (err) {
      log(`mic stop failed: ${errorMessage(err)}`, "warn");
    }
    unsubscribeAll();
    if (disposed) return "";
    const text = await finalText();
    if (disposed) return "";
    disposed = true;
    return text;
  }

  function unsubscribeAll(): void {
    for (const off of unsubscribers.splice(0)) off();
  }

  return {
    start() {
      if (started || disposed || finishing) return;
      started = true;
      unsubscribers.push(mic.onData(onData), mic.onError(onMicError));
      if (!paused) schedule();
    },
    pause() {
      if (paused || disposed || finishing) return;
      paused = true;
      mic.pause();
      clearTimer();
    },
    resume() {
      if (!paused || disposed || finishing) return;
      paused = false;
      mic.resume();
      if (firstAudioAt !== null) lastVoiceAt = clock.now();
      if (live()) schedule();
    },
    get paused() {
      return paused;
    },
    level() {
      if (paused || disposed) return 0;
      const end = alignDown(spool.total);
      const bytes = alignDown(Math.round(LEVEL_WINDOW_MS * bytesPerMs));
      return rms(spool.slice(Math.max(alignUp(spool.start), end - bytes), end));
    },
    silenceMs() {
      if (paused || disposed || finishing || firstAudioAt === null) return 0;
      const now = clock.now();
      if (lastVoiceAt === null) {
        const elapsed = now - firstAudioAt;
        return elapsed > SILENCE_GRACE_MS ? elapsed : 0;
      }
      return Math.max(0, now - lastVoiceAt);
    },
    finish() {
      if (finishPromise) return finishPromise;
      if (disposed) return Promise.resolve("");
      finishing = true;
      clearTimer();
      abortTick();
      finishPromise = runFinish();
      return finishPromise;
    },
    cancel() {
      if (disposed) return;
      disposed = true;
      clearTimer();
      abortTick();
      finalController?.abort();
      unsubscribeAll();
      mic.kill();
    },
  };
}

// ---------------------------------------------------------------- helpers

function alignDown(n: number): number {
  return n - (n % 2);
}

function alignUp(n: number): number {
  return n + (n % 2);
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}

interface Spool {
  push(chunk: Buffer): void;
  /** Absolute bytes received since start. */
  readonly total: number;
  /** Absolute offset of the oldest retained byte. */
  readonly start: number;
  /** False once audio was dropped for the cap. */
  readonly complete: boolean;
  /** Copy of retained bytes in [from, to) (absolute offsets, clamped). */
  slice(from: number, to: number): Buffer;
}

function createSpool(maxBytes: number): Spool {
  const chunks: Buffer[] = [];
  let size = 0;
  let dropped = 0;

  return {
    push(chunk) {
      chunks.push(Buffer.from(chunk));
      size += chunk.length;
      while (size > maxBytes) {
        const head = chunks[0];
        if (head === undefined) break;
        const over = size - maxBytes;
        if (head.length <= over) {
          chunks.shift();
          size -= head.length;
          dropped += head.length;
        } else {
          chunks[0] = head.subarray(over);
          size -= over;
          dropped += over;
        }
      }
    },
    get total() {
      return dropped + size;
    },
    get start() {
      return dropped;
    },
    get complete() {
      return dropped === 0;
    },
    slice(from, to) {
      const lo = Math.max(from, dropped) - dropped;
      const hi = Math.min(to, dropped + size) - dropped;
      if (hi <= lo) return Buffer.alloc(0);
      const out = Buffer.alloc(hi - lo);
      let offset = 0;
      for (const chunk of chunks) {
        const cStart = offset;
        const cEnd = offset + chunk.length;
        offset = cEnd;
        if (cEnd <= lo) continue;
        if (cStart >= hi) break;
        const s = Math.max(lo, cStart);
        const e = Math.min(hi, cEnd);
        chunk.copy(out, s - lo, s - cStart, e - cStart);
      }
      return out;
    },
  };
}

/** RMS of s16le samples, normalized to 0..1. */
function rms(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

function isVoiced(pcm: Buffer, frameBytes: number, threshold: number): boolean {
  for (let off = 0; off < pcm.length; off += frameBytes) {
    if (rms(pcm.subarray(off, Math.min(pcm.length, off + frameBytes))) >= threshold) return true;
  }
  return false;
}

/** 16-bit mono PCM WAV (44-byte header). */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
