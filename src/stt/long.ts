// Long batch recordings: split PCM at quiet points, transcribe each chunk,
// keep the survivors. One bad chunk costs only itself.

import type { Logger, TranscribeOptions, Transcriber } from "../types.ts";
import { errorMessage, isAbortError } from "../types.ts";
import { cleanTranscript, isLikelyHallucination } from "./filter.ts";

// ---------------------------------------------------------------- wav helpers
// Private minimal WAV parse/write (src/audio/wav.ts is owned elsewhere).

export interface WavInfo {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly dataOffset: number;
  readonly dataLength: number;
}

/** Parse a RIFF/WAVE header by walking chunks. Returns null when not a WAV. */
export function parseWav(wav: Buffer): WavInfo | null {
  if (wav.length < 12) return null;
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt " && body + 16 <= wav.length) {
      channels = wav.readUInt16LE(body + 2);
      sampleRate = wav.readUInt32LE(body + 4);
      bitsPerSample = wav.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (!(sampleRate > 0)) return null;
      // Streaming writers leave 0 / 0xFFFFFFFF: clamp to what is present.
      const dataLength = Math.min(size, wav.length - body);
      return { sampleRate, channels, bitsPerSample, dataOffset: body, dataLength };
    }
    off = body + size + (size % 2);
  }
  return null;
}

/** Duration in seconds; 0 when unparseable. */
export function wavDurationSec(wav: Buffer): number {
  const info = parseWav(wav);
  if (!info) return 0;
  const bytesPerSec = info.sampleRate * info.channels * (info.bitsPerSample / 8);
  return bytesPerSec > 0 ? info.dataLength / bytesPerSec : 0;
}

/** Wrap s16le mono PCM in a 44-byte WAV header. */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export function abortError(): Error {
  const err = new Error("Transcription aborted");
  err.name = "AbortError";
  return err;
}

// ---------------------------------------------------------------- planning

const FRAME_SEC = 0.3;
const STEP_SEC = 0.05;
const SEARCH_SEC = 10;
const MIN_TAIL_SEC = 0.5;

function rms(pcm: Buffer, startSample: number, count: number): number {
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const v = pcm.readInt16LE((startSample + i) * 2);
    sum += v * v;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

/**
 * Cut sample ranges of at most ~maxSec, each cut at the centre of the quietest
 * 300ms frame in the last SEARCH_SEC (or second half) before the boundary.
 * Returns [start, end) sample indices covering the whole buffer.
 */
export function planSplits(
  pcm: Buffer,
  sampleRate: number,
  maxSec: number,
): Array<[number, number]> {
  const total = Math.floor(pcm.length / 2);
  const maxS = Math.max(1, Math.floor(maxSec * sampleRate));
  const frame = Math.max(1, Math.floor(FRAME_SEC * sampleRate));
  const step = Math.max(1, Math.floor(STEP_SEC * sampleRate));
  const searchS = Math.floor(SEARCH_SEC * sampleRate);
  const spans: Array<[number, number]> = [];
  let at = 0;
  while (total - at > maxS) {
    const target = at + maxS;
    const winStart = Math.max(at + Math.floor(maxS / 2), target - searchS);
    let bestCut = target;
    let bestRms = Infinity;
    // Scan backward from the boundary; an earlier frame must be clearly
    // (10%) quieter to win, so uniform audio cuts near the max length
    // instead of drifting early and multiplying chunks.
    for (let s = target - frame; s >= winStart; s -= step) {
      const r = rms(pcm, s, frame);
      if (r < bestRms * 0.9) {
        bestRms = r;
        bestCut = s + Math.floor(frame / 2);
      }
    }
    spans.push([at, bestCut]);
    at = bestCut;
  }
  spans.push([at, total]);
  // A sliver of a tail joins the previous chunk instead of going alone.
  const last = spans[spans.length - 1];
  const prev = spans[spans.length - 2];
  if (last && prev && last[1] - last[0] < MIN_TAIL_SEC * sampleRate) {
    prev[1] = last[1];
    spans.pop();
  }
  return spans;
}

// ---------------------------------------------------------------- transcribe

export interface LongConfig {
  /** Max seconds per chunk (default 30). */
  readonly maxChunkSec?: number;
  readonly logger?: Logger;
}

function filtered(text: string): string {
  const cleaned = cleanTranscript(text);
  return isLikelyHallucination(cleaned) ? "" : cleaned;
}

/**
 * Transcribe a WAV of any length. Output is cleaned and hallucination-
 * filtered ("" = no speech). Long audio is split at quiet points and chunks
 * run sequentially; a failing chunk is logged and skipped. Throws only when
 * every chunk fails, on abort, or when the recording holds no samples.
 */
export async function transcribeLong(
  t: Transcriber,
  wav: Buffer,
  opts: TranscribeOptions,
  cfg: LongConfig = {},
): Promise<string> {
  const maxSec = cfg.maxChunkSec ?? 30;
  const log = (msg: string, level: "debug" | "warn" = "debug"): void =>
    cfg.logger?.log("STT", msg, level);
  const info = parseWav(wav);
  if (info && info.dataLength === 0) {
    throw new Error("Recording is empty — no audio was captured; check the microphone");
  }
  const durSec = wavDurationSec(wav);
  if (!info || info.channels !== 1 || info.bitsPerSample !== 16 || durSec <= maxSec) {
    return filtered(await t.transcribe(wav, opts));
  }

  const pcm = wav.subarray(info.dataOffset, info.dataOffset + info.dataLength);
  const spans = planSplits(pcm, info.sampleRate, maxSec);
  log(`long turn ${durSec.toFixed(0)}s split into ${spans.length} chunks`);
  const parts: string[] = [];
  let failures = 0;
  let firstError: unknown = null;
  for (let i = 0; i < spans.length; i++) {
    if (opts.signal?.aborted) throw abortError();
    const span = spans[i];
    if (!span) continue;
    const chunk = pcmToWav(pcm.subarray(span[0] * 2, span[1] * 2), info.sampleRate);
    try {
      const text = filtered(await t.transcribe(chunk, opts));
      if (text) parts.push(text);
      else log(`chunk ${i + 1}/${spans.length} empty or hallucination, dropped`);
    } catch (err) {
      if (isAbortError(err) || opts.signal?.aborted) throw err;
      failures += 1;
      firstError ??= err;
      log(`chunk ${i + 1}/${spans.length} failed: ${errorMessage(err)}`, "warn");
    }
  }
  log(`chunked transcription kept ${parts.length}/${spans.length} chunks`);
  if (failures === spans.length) {
    throw new Error(
      `Transcription failed for all ${spans.length} parts: ${errorMessage(firstError)}`,
    );
  }
  return parts.join(" ");
}
