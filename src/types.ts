// Shared contracts between modules. Leaf modules (audio, stt engines, tts
// engines, llm) implement these; the session state machines consume them.
// Keep this file free of runtime code except tiny helpers.

// ---------------------------------------------------------------- logging

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface Logger {
  log(scope: string, message: string, level?: LogLevel): void;
}

// ---------------------------------------------------------------- audio

/** Raw PCM is always signed 16-bit little-endian, mono. */
export interface PcmFormat {
  readonly sampleRate: number;
}

export type MicKind = "local" | "remote";

export interface MicConfig {
  readonly kind: MicKind;
  /** Local input device name for sox/coreaudio; undefined = system default. */
  readonly device?: string;
  /**
   * Remote capture argv (e.g. ssh ... capture.sh 16000). Must write raw
   * s16le mono PCM at `sampleRate` to stdout. Required when kind=remote.
   */
  readonly command?: readonly string[];
  readonly sampleRate: number;
  /** Run `adb forward` before a remote ssh capture to 127.0.0.1/localhost. */
  readonly usbAutoForward?: boolean;
}

export type MicErrorCode =
  | "SPAWN_FAILED" // binary missing / spawn threw
  | "CONNECTION" // remote command could not connect (ssh exit 255 etc.)
  | "EXITED" // capture process exited unexpectedly
  | "NO_AUDIO"; // no bytes arrived within the startup window

export interface MicError {
  readonly code: MicErrorCode;
  /** One-line, user-facing, says what happened. */
  readonly message: string;
  /** One-line, user-facing, says what to do. */
  readonly hint?: string;
}

export interface MicStream {
  /** Subscribe to PCM chunks. Returns unsubscribe. */
  onData(cb: (chunk: Buffer) => void): () => void;
  /** Subscribe to fatal errors (emitted at most once). Returns unsubscribe. */
  onError(cb: (err: MicError) => void): () => void;
  /**
   * Drop incoming audio until resume(). The process keeps running and its
   * output keeps being drained, so remote buffers never replay paused speech.
   */
  pause(): void;
  resume(): void;
  readonly paused: boolean;
  /** Graceful stop: flushes remaining output, resolves when the process exited. */
  stop(): Promise<void>;
  /** Immediate kill, no flush. Idempotent. */
  kill(): void;
  readonly format: PcmFormat;
}

export type PlayerOutput =
  | { readonly kind: "local" }
  | { readonly kind: "remote"; readonly command: readonly string[] };

export type PlayerStatus = "idle" | "playing" | "paused";
export type PlayEnd = "ended" | "stopped";

export interface Player {
  /**
   * Play a WAV buffer from the start. Supersedes anything playing (that
   * promise resolves "stopped"). Resolves "ended" on natural finish.
   */
  play(wav: Buffer): Promise<PlayEnd>;
  pause(): boolean;
  resume(): boolean;
  stop(): void;
  status(): PlayerStatus;
  positionSec(): number;
  durationSec(): number;
  /**
   * Jump to an absolute position in the current clip (clamped at 0). A
   * position at or past the end finishes the clip ("ended"). Keeps the
   * paused state. False when nothing is loaded.
   */
  seek(sec: number): boolean;
  /** Playback speed (pitch kept). Applies immediately, also while paused. */
  setRate(rate: number): void;
  rate(): number;
  dispose(): void;
}

export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export const RATE_MIN = 0.5;
export const RATE_MAX = 2;

export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.round(Math.min(RATE_MAX, Math.max(RATE_MIN, rate)) * 100) / 100;
}

// ---------------------------------------------------------------- stt

export type SttLanguage = "auto" | "vi" | "en";

export interface TranscribeOptions {
  readonly language: SttLanguage;
  readonly signal?: AbortSignal;
  /** Optional decoder prompt (vocabulary hint). */
  readonly prompt?: string;
}

export interface Transcriber {
  /** WAV (16-bit mono) in, plain text out. Throws on failure / abort. */
  transcribe(wav: Buffer, opts: TranscribeOptions): Promise<string>;
  /** Start any sidecar early so the first transcription is fast. */
  warm(): Promise<void>;
  /** Short human label, e.g. "whisper large-v3-turbo". */
  describe(): string;
  dispose(): Promise<void>;
}

export interface StreamingPartial {
  /** Text that will not change anymore. */
  readonly stable: string;
  /** Latest guess for the tail; may be revised. */
  readonly tentative: string;
}

// ---------------------------------------------------------------- tts

export type SpeechLang = "vi" | "en";

export interface SpeechSegment {
  readonly lang: SpeechLang;
  readonly text: string;
}

export type SynthName = "vieneu" | "piper";

export interface Synth {
  readonly name: SynthName;
  /** Returns a playable WAV. Throws SynthError on failure / abort. */
  synthesize(seg: SpeechSegment, signal?: AbortSignal): Promise<Buffer>;
  /** True when the engine can say this language well. */
  supports(lang: SpeechLang): boolean;
  /** Start a sidecar early (no-op when not applicable). */
  warm(): void;
  dispose(): Promise<void>;
}

export class SynthError extends Error {
  constructor(
    message: string,
    readonly code: "UNAVAILABLE" | "FAILED" | "ABORTED",
  ) {
    super(message);
    this.name = "SynthError";
  }
}

// ---------------------------------------------------------------- llm

export interface CompleteRequest {
  readonly system: string;
  readonly user: string;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
  /** OpenCode session id for session-scoped gateways. */
  readonly sessionID?: string;
}

export interface Llm {
  /** Resolves trimmed text. Throws on HTTP/network error, abort, or empty. */
  complete(req: CompleteRequest): Promise<string>;
  /** Short label "provider/model" or "unconfigured". */
  describe(): string;
  readonly configured: boolean;
}

// ---------------------------------------------------------------- utils

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) ||
    (err instanceof SynthError && err.code === "ABORTED")
  );
}
