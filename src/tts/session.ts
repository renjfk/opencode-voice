// TTS state machine: prepare text → synthesize part by part (VieNeu, Piper
// fallback) → play, prefetching the next part while the current one plays.
// One operation id guards every async step; stop/new speech invalidates the
// old one so stale audio can never play or clear the status line.
import type { Host } from "../host.ts";
import type { Settings } from "../config.ts";
import type { Llm, Logger, Player, SpeechSegment, Synth, SynthName } from "../types.ts";
import { SynthError, errorMessage, isAbortError } from "../types.ts";

export type TtsPhase =
  | { readonly kind: "idle" }
  | {
      readonly kind: "preparing";
      readonly step: "normalizing" | "synthesizing";
      readonly since: number;
    }
  | { readonly kind: "playing"; readonly part: number; readonly parts: number }
  | { readonly kind: "paused"; readonly part: number; readonly parts: number };

export interface TtsView {
  readonly phase: TtsPhase;
  readonly positionSec: number;
  readonly durationSec: number;
  readonly engine: SynthName | null;
  readonly canReplay: boolean;
}

export interface TtsDeps {
  host: Pick<
    Host,
    "toast" | "currentSessionID" | "anySessionID" | "lastAssistantText" | "onSessionIdle" | "kv"
  >;
  settings: Settings;
  logger: Logger;
  llm: Llm;
  normalizePrompt: string;
  prepareSpeech(markdown: string): string;
  splitSegments(text: string): SpeechSegment[];
  mergeForEngine(segs: SpeechSegment[], engineHandlesMixed: boolean): SpeechSegment[];
  synth(name: SynthName): Synth;
  player: Player;
  /** True while the user is dictating: auto-read must not talk over them. */
  isRecording(): boolean;
  clock?: { now(): number };
}

export interface TtsMachine {
  /** Reply button: read the latest reply, or stop when busy. */
  toggle(): void;
  speakReply(): void;
  speakText(text: string, opts?: { normalize?: boolean }): void;
  /** Pause/resume playback. False when nothing is playing. */
  pause(): boolean;
  stop(): boolean;
  replay(): boolean;
  view(): TtsView;
  isBusy(): boolean;
  onChange(cb: () => void): () => void;
  dispose(): void;
}

const NORMALIZE_TIMEOUT_MS = 15_000;
const NORMALIZE_MAX_CHARS = 6000;
const FALLBACK_NOTICE_MS = 120_000;

export function createTtsMachine(deps: TtsDeps): TtsMachine {
  const { host, settings, logger, player } = deps;
  const now = deps.clock?.now ?? (() => Date.now());
  let phase: TtsPhase = { kind: "idle" };
  let op = 0;
  let abort: AbortController | null = null;
  let engine: SynthName | null = null;
  let lastWavs: Buffer[] = [];
  let lastFallbackNotice = 0;
  let disposed = false;
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const cb of listeners) {
      try {
        cb();
      } catch {}
    }
  };
  const setPhase = (p: TtsPhase): void => {
    phase = p;
    emit();
  };

  function stopInternal(): boolean {
    const wasBusy = phase.kind !== "idle";
    op += 1;
    try {
      abort?.abort();
    } catch {}
    abort = null;
    player.stop();
    engine = null;
    if (wasBusy) setPhase({ kind: "idle" });
    return wasBusy;
  }

  /** Synthesize one segment; VieNeu failures fall back to Piper per language. */
  async function synthesize(seg: SpeechSegment, signal: AbortSignal): Promise<Buffer[]> {
    const primary = settings.ttsEngine();
    if (primary === "vieneu") {
      try {
        const wav = await deps.synth("vieneu").synthesize(seg, signal);
        engine = "vieneu";
        return [wav];
      } catch (err) {
        if (signal.aborted || isAbortError(err)) throw err;
        const reason = err instanceof SynthError ? err.message : errorMessage(err);
        logger.log("tts", `vieneu failed: ${reason}`, "warn");
        if (now() - lastFallbackNotice > FALLBACK_NOTICE_MS) {
          lastFallbackNotice = now();
          host.toast(
            reason.includes("Piper") ? reason : `VieNeu unavailable (${reason}) — using Piper`,
            "warning",
            5000,
          );
        }
      }
    }
    // Piper speaks one language per voice: re-split mixed text.
    const piper = deps.synth("piper");
    const out: Buffer[] = [];
    for (const part of deps.splitSegments(seg.text)) {
      out.push(await piper.synthesize(part, signal));
    }
    engine = "piper";
    return out;
  }

  async function run(myOp: number, text: string, normalize: boolean): Promise<void> {
    const signal = abort?.signal ?? new AbortController().signal;
    let speech = deps.prepareSpeech(text);
    if (
      normalize &&
      deps.llm.configured &&
      text.length <= NORMALIZE_MAX_CHARS &&
      needsLlmSpeech(text)
    ) {
      setPhase({ kind: "preparing", step: "normalizing", since: now() });
      try {
        const out = await deps.llm.complete({
          system: deps.normalizePrompt,
          user: text,
          maxTokens: 4096,
          signal: AbortSignal.any([signal, AbortSignal.timeout(NORMALIZE_TIMEOUT_MS)]),
          ...(host.anySessionID() ? { sessionID: host.anySessionID() as string } : {}),
        });
        if (out.trim()) speech = deps.prepareSpeech(out);
      } catch (err) {
        if (myOp !== op) return;
        logger.log("tts", `normalize failed, reading locally: ${errorMessage(err)}`, "warn");
      }
      if (myOp !== op) return;
    }
    const segs = deps.mergeForEngine(deps.splitSegments(speech), settings.ttsEngine() === "vieneu");
    if (segs.length === 0) {
      setPhase({ kind: "idle" });
      host.toast("Nothing speakable in that reply", "info", 2500);
      return;
    }
    setPhase({ kind: "preparing", step: "synthesizing", since: now() });
    logger.log("tts", `speak parts=${segs.length} chars=${speech.length}`);
    const wavs: Buffer[] = [];
    try {
      let next: Promise<Buffer[]> | null = synthesize(segs[0] as SpeechSegment, signal);
      for (let i = 0; i < segs.length; i++) {
        const current: Buffer[] = await (next as Promise<Buffer[]>);
        if (myOp !== op) return;
        // Prefetch the next part while this one plays.
        next = i + 1 < segs.length ? synthesize(segs[i + 1] as SpeechSegment, signal) : null;
        next?.catch(() => {}); // surfaced when awaited
        for (const wav of current) {
          wavs.push(wav);
          setPhase({ kind: "playing", part: i + 1, parts: segs.length });
          const end = await player.play(wav);
          if (myOp !== op || end === "stopped") return;
        }
      }
    } catch (err) {
      if (myOp !== op) return;
      if (!isAbortError(err)) {
        host.toast(`Speech failed: ${errorMessage(err)}`, "error", 6000);
        logger.log("tts", `speech failed: ${errorMessage(err)}`, "error");
      }
      if (wavs.length) lastWavs = wavs;
      setPhase({ kind: "idle" });
      return;
    }
    if (myOp !== op) return;
    lastWavs = wavs;
    setPhase({ kind: "idle" });
  }

  function speak(text: string, normalize: boolean): void {
    if (disposed) return;
    stopInternal();
    const myOp = op;
    abort = new AbortController();
    setPhase({ kind: "preparing", step: "normalizing", since: now() });
    void run(myOp, text, normalize).catch((err: unknown) => {
      if (myOp !== op) return;
      host.toast(`Speech failed: ${errorMessage(err)}`, "error");
      setPhase({ kind: "idle" });
    });
  }

  function speakReply(): void {
    const sessionID = host.currentSessionID();
    const text = sessionID ? host.lastAssistantText(sessionID) : "";
    if (!text) {
      host.toast("No assistant reply to read in this session", "info", 2500);
      return;
    }
    speak(text, true);
  }

  // Auto-read: only the TUI showing that session speaks, once per reply
  // (the dedupe key lives in shared storage, so other TUIs skip it).
  host.onSessionIdle((sessionID) => {
    if (disposed || !settings.ttsAuto()) return;
    if (host.currentSessionID() !== sessionID) return;
    const text = host.lastAssistantText(sessionID);
    if (!text) return;
    const key = `${sessionID}:${text.length}:${hash(text)}`;
    if (host.kv.get("tts.lastSpoken") === key) return;
    logger.log("tts", `auto-read session reply chars=${text.length}`);
    host.kv.set("tts.lastSpoken", key);
    if (deps.isRecording()) {
      host.toast("Reply ready — press Reply to hear it", "info", 3000);
      return;
    }
    speak(text, true);
  });

  return {
    toggle() {
      if (phase.kind === "idle") speakReply();
      else stopInternal();
    },
    speakReply,
    speakText(text, opts) {
      speak(text, opts?.normalize ?? false);
    },
    pause() {
      if (phase.kind === "playing" && player.pause()) {
        setPhase({ kind: "paused", part: phase.part, parts: phase.parts });
        return true;
      }
      if (phase.kind === "paused" && player.resume()) {
        setPhase({ kind: "playing", part: phase.part, parts: phase.parts });
        return true;
      }
      return false;
    },
    stop: stopInternal,
    replay() {
      if (lastWavs.length === 0) return false;
      const wavs = lastWavs;
      stopInternal();
      const myOp = op;
      void (async () => {
        try {
          for (let i = 0; i < wavs.length; i++) {
            if (myOp !== op) return;
            setPhase({ kind: "playing", part: i + 1, parts: wavs.length });
            const end = await player.play(wavs[i] as Buffer);
            if (myOp !== op || end === "stopped") return;
          }
        } catch (err) {
          if (myOp === op) host.toast(`Replay failed: ${errorMessage(err)}`, "error");
        }
        if (myOp === op) setPhase({ kind: "idle" });
      })();
      return true;
    },
    view() {
      return {
        phase,
        positionSec: phase.kind === "playing" || phase.kind === "paused" ? player.positionSec() : 0,
        durationSec: phase.kind === "playing" || phase.kind === "paused" ? player.durationSec() : 0,
        engine,
        canReplay: lastWavs.length > 0,
      };
    },
    isBusy: () => phase.kind !== "idle",
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      disposed = true;
      stopInternal();
      listeners.clear();
    },
  };
}

/**
 * Plain prose reads fine after local cleanup; the LLM pass (seconds of
 * latency) is only worth it for code, markup, paths and links.
 */
export function needsLlmSpeech(text: string): boolean {
  return /```|`[^`\n]+`|^\s*\|.*\||^#{1,6}\s|\*\*|https?:\/\/|[\w-]+\/[\w./-]+|\b\w+\.(?:ts|js|py|json|md|go|rs|swift|tsx|jsx|yml|yaml|sh)\b|[{}<>=]/m.test(
    text,
  );
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
