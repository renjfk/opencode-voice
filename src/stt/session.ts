// STT state machine: one owner for batch dictation, streaming dictation and
// correction (Fix). Every operation gets an id; any async step that finishes
// after a newer operation (or a cancel) started is ignored. Every path ends
// in `idle` with a visible result, so nothing can stay stuck "busy".
import type { FocusedTextarea, Host } from "../host.ts";
import type { Options, Settings, SttMode } from "../config.ts";
import type {
  Llm,
  Logger,
  MicConfig,
  MicError,
  MicStream,
  SttLanguage,
  StreamingPartial,
  TranscribeOptions,
  Transcriber,
} from "../types.ts";
import { errorMessage, isAbortError } from "../types.ts";
import { createLiveSpan, insertAtCursor, replaceAll, type LiveSpan } from "./editor.ts";

export type Purpose = "dictate" | "correct";

export type SttPhase =
  | { readonly kind: "idle" }
  | {
      readonly kind: "starting";
      readonly purpose: Purpose;
      readonly mode: SttMode;
      readonly since: number;
    }
  | { readonly kind: "recording"; readonly purpose: Purpose; readonly since: number }
  | {
      readonly kind: "live";
      readonly purpose: Purpose;
      readonly since: number;
      readonly paused: boolean;
    }
  | { readonly kind: "transcribing"; readonly purpose: Purpose; readonly since: number }
  | { readonly kind: "normalizing"; readonly purpose: Purpose; readonly since: number };

export type ResultKind = "ok" | "empty" | "warning" | "error" | "cancelled";

export interface SttResult {
  readonly kind: ResultKind;
  readonly message: string;
  readonly at: number;
}

export interface SttView {
  readonly phase: SttPhase;
  /** 0..1 input level for the meter. */
  readonly level: number;
  /** Live transcript when it cannot be shown in a text field. */
  readonly partial: string;
  readonly micLabel: string;
  readonly last: SttResult | null;
}

/** Subset of the streaming session (src/stt/streaming.ts) the machine uses. */
export interface StreamingHandle {
  start(): void;
  pause(): void;
  resume(): void;
  readonly paused: boolean;
  level(): number;
  silenceMs(): number;
  finish(): Promise<string>;
  cancel(): void;
}

export interface StreamingFactoryInput {
  mic: MicStream;
  transcriber: Transcriber;
  language: SttLanguage;
  onPartial(p: StreamingPartial): void;
  onError(err: Error): void;
}

export interface SttDeps {
  host: Pick<
    Host,
    | "focused"
    | "toast"
    | "promptSession"
    | "alert"
    | "currentSessionID"
    | "anySessionID"
    | "sessionTitle"
    | "recentTurns"
  >;
  settings: Settings;
  options: Options;
  logger: Logger;
  openMic(cfg: MicConfig): Promise<MicStream>;
  transcriber(): Transcriber;
  transcribeFile(t: Transcriber, wav: Buffer, opts: TranscribeOptions): Promise<string>;
  createStreaming(input: StreamingFactoryInput): StreamingHandle;
  wrapPcm(pcm: Buffer, sampleRate: number): Buffer;
  pcmRms(pcm: Buffer): number;
  cleanTranscript(text: string): string;
  isHallucination(text: string): boolean;
  llm: Llm;
  prompts: {
    normalize: string;
    correction: string;
    buildSttUser(raw: string, ctx: { sessionTitle?: string; recent?: string }): string;
    buildCorrectionUser(
      current: string,
      spoken: string,
      ctx?: { sessionTitle?: string; recent?: string },
    ): string;
    needsContext(raw: string): boolean;
    cleanOutput(raw: string, out: string): string;
  };
  /** Called when the mic opens (e.g. pause TTS so the mic does not hear it). */
  onRecordingStart?(): void;
  clock?: {
    now(): number;
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(h: unknown): void;
  };
}

export interface SttMachine {
  /** Speak button: start, or finish the current recording. */
  toggle(): void;
  /** Fix button: start a correction, or finish it. */
  correct(): void;
  /** Done button: finish the current recording (even when paused). */
  finish(): void;
  /** Pause/resume live (streaming) dictation. False when not applicable. */
  pause(): boolean;
  /** Cancel whatever is in flight. False when idle. */
  cancel(): boolean;
  view(): SttView;
  isBusy(): boolean;
  onChange(cb: () => void): () => void;
  dispose(): void;
}

export const AUTO_END_SILENCE_MS = 2500;
const VOICE_RMS = 0.012;
const MIN_AUDIO_SEC = 0.4;
const MAX_BATCH_SEC = 600;
const NORMALIZE_TIMEOUT_MS = 20_000;
const MERGE_TIMEOUT_MS = 30_000;

export function createSttMachine(deps: SttDeps): SttMachine {
  const clock = deps.clock ?? {
    now: () => Date.now(),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>),
  };
  const { host, settings, options, logger } = deps;

  let phase: SttPhase = { kind: "idle" };
  let last: SttResult | null = null;
  let op = 0;
  let disposed = false;
  const listeners = new Set<() => void>();

  // Per-operation resources (reset by end()).
  let mic: MicStream | null = null;
  let stream: StreamingHandle | null = null;
  let span: LiveSpan | null = null;
  let abort: AbortController | null = null;
  let chunks: Buffer[] = [];
  let bytes = 0;
  let level = 0;
  let partial = "";
  let heardVoice = false;
  let silentSince = 0;
  let ticker: unknown = null;
  let target: FocusedTextarea | null = null;
  let finishing = false;
  let lastInserted = "";

  const emit = (): void => {
    for (const cb of listeners) {
      try {
        cb();
      } catch {}
    }
  };

  const setPhase = (next: SttPhase): void => {
    phase = next;
    emit();
  };

  const result = (kind: ResultKind, message: string): void => {
    last = { kind, message, at: clock.now() };
    if (kind === "error") host.toast(message, "error", 6000);
    else if (kind === "warning") host.toast(message, "warning", 5000);
    logger.log("stt", `result ${kind}: ${message.length > 80 ? message.slice(0, 80) : message}`);
  };

  const gatewaySession = (): string | null => host.anySessionID();

  const micLabel = (): string => {
    const m = settings.mic();
    return m === "remote" ? "phone" : m || "mac";
  };

  function micConfig(): MicConfig | string {
    const m = settings.mic();
    if (m === "remote") {
      if (!options.sttCaptureCmd)
        return "Phone mic selected but sttCaptureCmd is not configured — pick a mic with /stt-mic";
      return {
        kind: "remote",
        command: options.sttCaptureCmd,
        sampleRate: options.audioSampleRate,
        usbAutoForward: true,
      };
    }
    return { kind: "local", sampleRate: options.audioSampleRate, ...(m ? { device: m } : {}) };
  }

  function stopTicker(): void {
    if (ticker !== null) clock.clearInterval(ticker);
    ticker = null;
  }

  /** Tear down per-operation resources and go idle. */
  function end(): void {
    stopTicker();
    try {
      mic?.kill();
    } catch {}
    mic = null;
    stream = null;
    span = null;
    abort = null;
    chunks = [];
    bytes = 0;
    level = 0;
    partial = "";
    heardVoice = false;
    silentSince = 0;
    target = null;
    finishing = false;
    setPhase({ kind: "idle" });
  }

  const purposeOf = (): Purpose => ("purpose" in phase ? phase.purpose : "dictate");

  // ------------------------------------------------------------- start

  function start(purpose: Purpose): void {
    if (disposed) return;
    const cfg = micConfig();
    if (typeof cfg === "string") {
      result("error", cfg);
      emit();
      return;
    }
    const mode = settings.sttMode();
    const myOp = ++op;
    abort = new AbortController();
    target = host.focused();
    setPhase({ kind: "starting", purpose, mode, since: clock.now() });
    try {
      deps.onRecordingStart?.();
    } catch {}
    logger.log("stt", `start purpose=${purpose} mode=${mode} mic=${cfg.kind}`);

    let transcriber: Transcriber;
    try {
      transcriber = deps.transcriber();
    } catch (err) {
      end();
      result("error", errorMessage(err));
      return;
    }
    // Warm the engine while the mic opens so the first result is fast.
    void transcriber.warm().catch((err: unknown) => {
      logger.log("stt", `warm failed: ${errorMessage(err)}`, "warn");
    });

    deps.openMic(cfg).then(
      (m) => {
        if (myOp !== op || disposed) {
          m.kill();
          return;
        }
        mic = m;
        m.onError((e) => onMicError(myOp, e));
        if (mode === "streaming") beginLive(myOp, purpose, m, transcriber);
        else beginBatch(myOp, purpose, m);
      },
      (err: unknown) => {
        if (myOp !== op) return;
        end();
        const e = err as Partial<MicError>;
        result(
          "error",
          e?.hint ? `${e.message ?? "Mic failed"} — ${e.hint}` : `Mic failed: ${errorMessage(err)}`,
        );
      },
    );
  }

  function trackSilence(rms: number): void {
    const now = clock.now();
    if (rms >= VOICE_RMS) {
      heardVoice = true;
      silentSince = 0;
    } else if (heardVoice && !silentSince) {
      silentSince = now;
    }
  }

  function beginBatch(myOp: number, purpose: Purpose, m: MicStream): void {
    chunks = [];
    bytes = 0;
    m.onData((chunk) => {
      if (myOp !== op) return;
      chunks.push(chunk);
      bytes += chunk.length;
      level = deps.pcmRms(chunk);
      trackSilence(level);
    });
    setPhase({ kind: "recording", purpose, since: clock.now() });
    ticker = clock.setInterval(() => {
      if (myOp !== op || phase.kind !== "recording") return;
      const sec = bytes / 2 / m.format.sampleRate;
      if (sec >= MAX_BATCH_SEC) {
        result("warning", "Recording reached 10 minutes — transcribing");
        finish();
        return;
      }
      if (settings.autoEnd() && silentSince && clock.now() - silentSince >= AUTO_END_SILENCE_MS) {
        logger.log("stt", "auto-end (batch)");
        finish();
        return;
      }
      emit(); // timer + level meter
    }, 200);
  }

  function beginLive(myOp: number, purpose: Purpose, m: MicStream, transcriber: Transcriber): void {
    span = target ? createLiveSpan(target) : null;
    const s = deps.createStreaming({
      mic: m,
      transcriber,
      language: settings.language(),
      onPartial: (p) => {
        if (myOp !== op || finishing) return;
        const text = `${p.stable} ${p.tentative}`.replace(/\s+/g, " ").trim();
        partial = text;
        // Corrections are merged at the end; only dictation writes live.
        if (purpose === "dictate" && span && !span.detached) span.set(text);
        emit();
      },
      onError: (err) => {
        if (myOp !== op || finishing) return;
        result("warning", `${errorMessage(err)} — finishing with the audio captured so far`);
        finish();
      },
    });
    stream = s;
    s.start();
    setPhase({ kind: "live", purpose, since: clock.now(), paused: false });
    ticker = clock.setInterval(() => {
      if (myOp !== op || phase.kind !== "live") return;
      level = s.paused ? 0 : s.level();
      if (settings.autoEnd() && !s.paused && partial && s.silenceMs() >= AUTO_END_SILENCE_MS) {
        logger.log("stt", "auto-end (streaming)");
        finish();
        return;
      }
      emit();
    }, 200);
  }

  function onMicError(myOp: number, e: MicError): void {
    if (myOp !== op || finishing) return;
    const msg = e.hint ? `${e.message} — ${e.hint}` : e.message;
    if (phase.kind === "recording") {
      const sec = bytes / 2 / options.audioSampleRate;
      if (sec >= 1) {
        result("warning", `${msg}. Transcribing the ${sec.toFixed(0)}s captured`);
        finish();
      } else {
        end();
        result("error", msg);
      }
    }
    // Streaming: the session reports mic errors through onError.
  }

  // ------------------------------------------------------------ finish

  function finish(): void {
    if (finishing) return;
    if (phase.kind !== "recording" && phase.kind !== "live") return;
    finishing = true;
    const myOp = op;
    const purpose = phase.purpose;
    const since = clock.now();
    stopTicker();
    level = 0;
    setPhase({ kind: "transcribing", purpose, since });
    if (stream) void finishLive(myOp, purpose, stream);
    else void finishBatch(myOp, purpose);
  }

  async function finishBatch(myOp: number, purpose: Purpose): Promise<void> {
    const m = mic;
    try {
      await m?.stop();
    } catch {}
    if (myOp !== op) return;
    mic = null;
    const pcm = Buffer.concat(chunks);
    chunks = [];
    const sec = pcm.length / 2 / options.audioSampleRate;
    if (sec < MIN_AUDIO_SEC || !heardVoice) {
      end();
      result("empty", sec < MIN_AUDIO_SEC ? "Recording too short" : "No speech detected");
      return;
    }
    let raw: string;
    try {
      const wav = deps.wrapPcm(pcm, options.audioSampleRate);
      raw = await deps.transcribeFile(deps.transcriber(), wav, {
        language: settings.language(),
        signal: abort?.signal ?? new AbortController().signal,
      });
    } catch (err) {
      if (myOp !== op) return;
      end();
      if (isAbortError(err)) result("cancelled", "Cancelled");
      else result("error", `Transcription failed: ${errorMessage(err)}`);
      return;
    }
    if (myOp !== op) return;
    await deliver(myOp, purpose, raw, settings.normalize() !== "off");
  }

  async function finishLive(myOp: number, purpose: Purpose, s: StreamingHandle): Promise<void> {
    let raw = "";
    try {
      raw = await s.finish();
    } catch (err) {
      if (myOp !== op) return;
      raw = partial;
      logger.log("stt", `stream finish failed: ${errorMessage(err)}`, "warn");
    }
    if (myOp !== op) return;
    mic = null;
    await deliver(myOp, purpose, raw, settings.normalize() === "all");
  }

  // ----------------------------------------------------------- deliver

  async function deliver(
    myOp: number,
    purpose: Purpose,
    rawIn: string,
    normalize: boolean,
  ): Promise<void> {
    const raw = deps.cleanTranscript(rawIn);
    if (!raw || deps.isHallucination(raw)) {
      span?.remove();
      end();
      result("empty", "No speech detected");
      return;
    }
    const sessionID = host.currentSessionID();

    if (purpose === "correct") {
      await deliverCorrection(myOp, raw, sessionID);
      return;
    }

    let text = raw;
    let note = "";
    if (normalize && deps.llm.configured) {
      setPhase({ kind: "normalizing", purpose, since: clock.now() });
      try {
        const context =
          deps.prompts.needsContext(raw) && sessionID
            ? {
                ...(host.sessionTitle(sessionID)
                  ? { sessionTitle: host.sessionTitle(sessionID) as string }
                  : {}),
                recent: host.recentTurns(sessionID),
              }
            : {};
        text = await deps.llm.complete({
          system: deps.prompts.normalize,
          user: deps.prompts.buildSttUser(raw, context),
          maxTokens: 2048,
          signal: anySignal(abort?.signal, NORMALIZE_TIMEOUT_MS),
          ...(gatewaySession() ? { sessionID: gatewaySession() as string } : {}),
        });
        text = deps.prompts.cleanOutput(raw, text);
      } catch (err) {
        if (myOp !== op) return;
        if (abort?.signal.aborted) return; // cancel already handled
        text = raw;
        note = ` (raw: normalize failed — ${errorMessage(err)})`;
        logger.log("stt", `normalize failed: ${errorMessage(err)}`, "warn");
      }
      if (myOp !== op) return;
    }

    const submit = settings.autoSubmit();
    const outcome = await put(text, submit);
    if (myOp !== op) return;
    lastInserted = text;
    end();
    result(note ? "warning" : "ok", `${outcome}${note}`);
  }

  /** Write final text to the field (live span, focused field, or fallback). */
  async function put(text: string, submit: boolean): Promise<string> {
    let field: FocusedTextarea | null = null;
    const targetGone = !target || target.isDestroyed === true;
    if (span && !span.detached && span.set(text)) {
      field = target;
    } else if (span && span.detached && span.written && !targetGone) {
      // User edited during dictation: their text and the live words stay.
      host.toast(
        "You edited the text during dictation — kept the live transcript as is",
        "warning",
      );
      return "Kept live text";
    } else {
      // No live span, or the field it wrote into is gone (navigated away).
      field = host.focused();
      if (field) insertAtCursor(field, text);
    }
    if (field) {
      if (submit) {
        return field.submit() === false ? "Inserted (submit refused — press Enter)" : "Sent";
      }
      return `Inserted ${text.length} chars`;
    }
    if (submit) {
      // A prompt call can resolve only when the agent finishes: send in the
      // background so dictation (and auto-read) are free right away.
      void host.promptSession(text).catch((err: unknown) => {
        host.alert("Voice transcript — not sent", text);
        host.toast(`Not sent: ${errorMessage(err)}`, "error", 6000);
      });
      return "Sent";
    }
    host.alert("Voice transcript — no text field focused", text);
    return "No text field focused — transcript shown in a dialog";
  }

  async function deliverCorrection(
    myOp: number,
    spoken: string,
    sessionID: string | null,
  ): Promise<void> {
    const field = target && !target.isDestroyed ? target : host.focused();
    const current = field?.plainText ?? "";
    if (!field || !current.trim()) {
      const outcome = await put(spoken, false);
      if (myOp !== op) return;
      end();
      result("ok", `${outcome} (nothing to correct)`);
      return;
    }
    if (!deps.llm.configured) {
      // No LLM: replace the last dictation when it is still at the end.
      if (lastInserted && current.trimEnd().endsWith(lastInserted)) {
        const at = current.lastIndexOf(lastInserted);
        replaceAll(field, current.slice(0, at) + spoken + current.slice(at + lastInserted.length));
        lastInserted = spoken;
        end();
        result("ok", "Replaced the last dictation (no LLM configured for smart merge)");
      } else {
        insertAtCursor(field, spoken);
        end();
        result(
          "warning",
          "No LLM configured — correction inserted as text. Pick one with /voice-model",
        );
      }
      return;
    }
    setPhase({ kind: "normalizing", purpose: "correct", since: clock.now() });
    let merged: string;
    try {
      const recent = sessionID ? host.recentTurns(sessionID, 800) : "";
      merged = await deps.llm.complete({
        system: deps.prompts.correction,
        user: deps.prompts.buildCorrectionUser(current, spoken, recent ? { recent } : {}),
        maxTokens: 4096,
        signal: anySignal(abort?.signal, MERGE_TIMEOUT_MS),
        ...(gatewaySession() ? { sessionID: gatewaySession() as string } : {}),
      });
    } catch (err) {
      if (myOp !== op || abort?.signal.aborted) return;
      end();
      result("error", `Correction failed: ${errorMessage(err)} — your text is unchanged`);
      return;
    }
    if (myOp !== op) return;
    if (field.isDestroyed || field.plainText !== current) {
      end();
      host.alert("Voice correction — text changed meanwhile, not applied", merged);
      result("warning", "Text changed while correcting — suggestion shown in a dialog");
      return;
    }
    replaceAll(field, merged);
    lastInserted = "";
    end();
    result("ok", "Corrected");
  }

  // ----------------------------------------------------------- public

  return {
    toggle() {
      switch (phase.kind) {
        case "idle":
          start("dictate");
          return;
        case "starting":
          this.cancel();
          return;
        case "recording":
        case "live":
          if (phase.kind === "live" && phase.paused) {
            this.pause(); // second press on a paused session resumes it
            return;
          }
          finish();
          return;
        case "transcribing":
        case "normalizing":
          host.toast("Still processing the last recording — press Cancel to drop it", "info", 2500);
          return;
      }
    },
    correct() {
      if (phase.kind === "idle") {
        start("correct");
        return;
      }
      if ((phase.kind === "recording" || phase.kind === "live") && phase.purpose === "correct") {
        finish();
        return;
      }
      host.toast("Finish the current recording first, then press Fix", "info", 2500);
    },
    finish() {
      if (phase.kind === "recording" || phase.kind === "live") finish();
    },
    pause() {
      if (phase.kind !== "live" || !stream || finishing) return false;
      if (stream.paused) stream.resume();
      else stream.pause();
      level = 0;
      setPhase({ ...phase, paused: stream.paused });
      return true;
    },
    cancel() {
      if (phase.kind === "idle") return false;
      const purpose = purposeOf();
      op += 1;
      try {
        abort?.abort();
      } catch {}
      try {
        stream?.cancel();
      } catch {}
      if (purpose === "dictate") span?.remove();
      end();
      result("cancelled", "Cancelled");
      return true;
    },
    view() {
      return {
        phase,
        level,
        partial: span && !span.detached ? "" : partial,
        micLabel: micLabel(),
        last,
      };
    },
    isBusy: () => phase.kind !== "idle",
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      disposed = true;
      if (phase.kind !== "idle") {
        op += 1;
        try {
          abort?.abort();
        } catch {}
        try {
          stream?.cancel();
        } catch {}
        end();
      }
      listeners.clear();
    },
  };
}

function anySignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, t]) : t;
}
