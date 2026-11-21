// TTS state machine: prepare text → synthesize part by part (VieNeu, Piper
// fallback) ahead of playback → play the clips in order. Position, duration
// and seeking are on the timeline of the whole reply; parts are an internal
// detail (logged, and shown in /voice-status).
// One operation id guards every async step; stop/new speech invalidates the
// old one so stale audio can never play or clear the status line.
import type { Host } from "../host.ts";
import type { Settings } from "../config.ts";
import type { Llm, Logger, Player, SpeechSegment, Synth, SynthName } from "../types.ts";
import { PLAYBACK_RATES, SynthError, clampRate, errorMessage, isAbortError } from "../types.ts";

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
  /** Position in the whole reply. */
  readonly positionSec: number;
  /** Duration of the parts synthesized so far. */
  readonly durationSec: number;
  /** False while later parts are still being synthesized (duration grows). */
  readonly durationFinal: boolean;
  readonly engine: SynthName | null;
  readonly canReplay: boolean;
  /** Playback speed, e.g. 1.25. */
  readonly rate: number;
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
  /** Duration of a WAV clip in seconds (for seeking across clips). */
  clipDuration(wav: Buffer): number;
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
  /** Jump by `deltaSec` (negative = back). False when nothing is playing. */
  seekBy(deltaSec: number): boolean;
  /** Set the speed (saved). Applies right away. */
  setRate(rate: number): void;
  /** Next preset speed, wrapping: 0.75 → 1 → 1.25 → 1.5 → 1.75 → 2 → 0.75. */
  cycleRate(): number;
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
  player.setRate(settings.ttsRate());

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
    jump = null;
    current = null;
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
    const list = newPlaylist(segs.length);
    // Producer: synthesize every part ahead of playback, in order.
    void (async () => {
      try {
        for (const seg of segs) {
          if (myOp !== op) return;
          const wavs = await synthesize(seg, signal);
          if (myOp !== op) return;
          list.add(wavs);
        }
      } catch (err) {
        list.fail(err);
        return;
      }
      list.done();
    })();
    await playList(myOp, list);
  }

  // ------------------------------------------------------------ playlist

  interface Playlist {
    readonly clips: Buffer[];
    /** Duration of each clip in seconds. */
    readonly durs: number[];
    /** Expected number of parts while synthesis runs (for the "2/3" label). */
    readonly expected: number;
    finished: boolean;
    error: unknown;
    add(wavs: Buffer[]): void;
    done(): void;
    fail(err: unknown): void;
    /** Resolves when clip `idx` exists or synthesis ended. */
    wait(idx: number): Promise<void>;
  }

  function newPlaylist(expected: number, clips: Buffer[] = [], finished = false): Playlist {
    let wake: (() => void) | null = null;
    const notify = (): void => {
      const w = wake;
      wake = null;
      w?.();
    };
    const pl: Playlist = {
      clips,
      durs: clips.map((c) => deps.clipDuration(c)),
      expected,
      finished,
      error: null,
      add(wavs) {
        pl.clips.push(...wavs);
        pl.durs.push(...wavs.map((w) => deps.clipDuration(w)));
        notify();
      },
      done() {
        pl.finished = true;
        notify();
      },
      fail(err) {
        pl.error = err;
        pl.finished = true;
        notify();
      },
      wait(idx) {
        if (idx < pl.clips.length || pl.finished) return Promise.resolve();
        return new Promise((r) => {
          wake = r;
        });
      },
    };
    return pl;
  }

  /** Start of clip `idx` on the whole-reply timeline. */
  const startOf = (list: Playlist, idx: number): number =>
    list.durs.slice(0, idx).reduce((a, b) => a + b, 0);
  const totalOf = (list: Playlist): number => startOf(list, list.durs.length);
  const fmt = (sec: number): string => sec.toFixed(2);

  /** Where playback must continue after a seek crossed a clip boundary. */
  let jump: { idx: number; offset: number } | null = null;
  let current: { list: Playlist; idx: number } | null = null;

  async function playList(myOp: number, list: Playlist): Promise<void> {
    let idx = 0;
    let offset = 0;
    try {
      for (;;) {
        if (idx >= list.clips.length && !list.finished) {
          await list.wait(idx);
          if (myOp !== op) return;
        }
        const wav = list.clips[idx];
        if (!wav) {
          if (list.error && !isAbortError(list.error)) throw list.error;
          break; // all parts played
        }
        current = { list, idx };
        const parts = Math.max(list.expected, list.clips.length);
        const pausedBefore = phase.kind === "paused";
        // Load the clip before announcing it, so the status line never shows
        // the previous clip's position under the new part number.
        const ended = player.play(wav);
        if (offset > 0) player.seek(offset);
        if (pausedBefore) player.pause(); // keep a paused session paused across a jump
        setPhase({ kind: pausedBefore ? "paused" : "playing", part: idx + 1, parts });
        logger.log(
          "tts",
          `part ${idx + 1}/${parts} start offset=${fmt(offset)} dur=${fmt(list.durs[idx] ?? 0)} at=${fmt(startOf(list, idx) + offset)}/${fmt(totalOf(list))}${list.finished ? "" : "+"}`,
        );
        offset = 0;
        const end = await ended;
        if (myOp !== op) return;
        if (jump) {
          ({ idx, offset } = jump);
          jump = null;
          continue;
        }
        if (end === "stopped") break;
        idx += 1;
      }
    } catch (err) {
      if (myOp !== op) return;
      if (!isAbortError(err)) {
        host.toast(`Speech failed: ${errorMessage(err)}`, "error", 6000);
        logger.log("tts", `speech failed: ${errorMessage(err)}`, "error");
      }
    } finally {
      // Whatever was synthesized stays replayable, also after a stop.
      if (list.clips.length) lastWavs = [...list.clips];
      if (myOp === op) {
        current = null;
        setPhase({ kind: "idle" });
      } else {
        emit(); // canReplay changed
      }
    }
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
  const retried = new Set<string>();
  function autoRead(sessionID: string, isRetry = false): void {
    if (disposed || !settings.ttsAuto()) return;
    if (isRetry && !host.lastAssistantText(sessionID)) return;
    if (host.currentSessionID() !== sessionID) return;
    const text = host.lastAssistantText(sessionID);
    if (!text) {
      // The final message can reach the store after the idle event.
      if (!retried.has(sessionID)) {
        retried.add(sessionID);
        setTimeout(() => {
          retried.delete(sessionID);
          autoRead(sessionID, true);
        }, 1500).unref?.();
      }
      return;
    }
    const key = `${sessionID}:${text.length}:${hash(text)}`;
    if (host.kv.get("tts.lastSpoken") === key) return;
    logger.log("tts", `auto-read session reply chars=${text.length}`);
    host.kv.set("tts.lastSpoken", key);
    if (deps.isRecording()) {
      host.toast("Reply ready — press Reply to hear it", "info", 3000);
      return;
    }
    speak(text, true);
  }
  host.onSessionIdle((sessionID) => autoRead(sessionID));

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
      void playList(myOp, newPlaylist(wavs.length, [...wavs], true));
      return true;
    },
    seekBy(deltaSec) {
      if ((phase.kind !== "playing" && phase.kind !== "paused") || !current) return false;
      const { list, idx } = current;
      const from = startOf(list, idx) + player.positionSec();
      const total = totalOf(list);
      const target = Math.max(0, from + deltaSec);
      // Find the part that holds `target` on the whole-reply timeline.
      let i = 0;
      let start = 0;
      while (i < list.durs.length && target >= start + (list.durs[i] as number)) {
        start += list.durs[i] as number;
        i += 1;
      }
      const offset = target - start;
      logger.log(
        "tts",
        `seek ${deltaSec > 0 ? "+" : ""}${deltaSec}s: part ${idx + 1} at=${fmt(from)} → ${i < list.durs.length ? `part ${i + 1} offset=${fmt(offset)}` : list.finished ? "end" : `part ${i + 1} (not synthesized yet) from start`} at=${fmt(Math.min(target, total))}/${fmt(total)}${list.finished ? "" : "+"}`,
      );
      if (i === idx) return player.seek(offset);
      if (i >= list.durs.length && list.finished) {
        // Past the end of the reply: finish the current part and stop there.
        jump = { idx: list.durs.length, offset: 0 };
        return player.seek(Number.POSITIVE_INFINITY);
      }
      // Another part (or the next one still being synthesized, from its start).
      jump = { idx: i, offset: i < list.durs.length ? offset : 0 };
      return player.seek(Number.POSITIVE_INFINITY); // ends this clip; the loop jumps
    },
    setRate(rate) {
      const r = clampRate(rate);
      settings.setTtsRate(r);
      player.setRate(r);
      emit();
    },
    cycleRate() {
      const cur = player.rate();
      const next = PLAYBACK_RATES.find((r) => r > cur + 0.001) ?? PLAYBACK_RATES[0];
      this.setRate(next);
      return next;
    },
    view() {
      return {
        phase,
        positionSec: current ? startOf(current.list, current.idx) + player.positionSec() : 0,
        durationSec: current ? totalOf(current.list) : 0,
        durationFinal: current ? current.list.finished : true,
        engine,
        canReplay: lastWavs.length > 0,
        rate: player.rate(),
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
