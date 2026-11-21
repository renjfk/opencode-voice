// Test doubles shared by the state-machine tests.
import type { FocusedTextarea } from "../host.ts";
import type {
  Llm,
  MicError,
  MicStream,
  Player,
  PlayEnd,
  SpeechSegment,
  Synth,
  SynthName,
  Transcriber,
} from "../types.ts";

/** In-memory model of the opentui textarea surface we use. */
export function fakeTextarea(
  initial = "",
  cursor = initial.length,
): FocusedTextarea & { submits: number } {
  let text = initial;
  let cur = cursor;
  const offset = (row: number, col: number): number => {
    const lines = text.split("\n");
    let o = 0;
    for (let i = 0; i < row; i++) o += (lines[i] ?? "").length + 1;
    return o + col;
  };
  return {
    submits: 0,
    get plainText() {
      return text;
    },
    get cursorOffset() {
      return cur;
    },
    set cursorOffset(v: number) {
      cur = Math.max(0, Math.min(v, text.length));
    },
    insertText(t: string) {
      text = text.slice(0, cur) + t + text.slice(cur);
      cur += t.length;
    },
    deleteRange(sr: number, sc: number, er: number, ec: number) {
      const a = offset(sr, sc);
      const b = offset(er, ec);
      text = text.slice(0, a) + text.slice(b);
      cur = a;
    },
    submit() {
      this.submits += 1;
      return true;
    },
  };
}

export interface FakeMic extends MicStream {
  push(chunk: Buffer): void;
  fail(err: MicError): void;
  stops: number;
  kills: number;
}

export function fakeMic(sampleRate = 16000): FakeMic {
  const data = new Set<(c: Buffer) => void>();
  const errs = new Set<(e: MicError) => void>();
  let paused = false;
  const mic: FakeMic = {
    stops: 0,
    kills: 0,
    format: { sampleRate },
    onData(cb) {
      data.add(cb);
      return () => data.delete(cb);
    },
    onError(cb) {
      errs.add(cb);
      return () => errs.delete(cb);
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    get paused() {
      return paused;
    },
    async stop() {
      mic.stops += 1;
    },
    kill() {
      mic.kills += 1;
    },
    push(chunk) {
      if (paused) return;
      for (const cb of data) cb(chunk);
    },
    fail(err) {
      for (const cb of errs) cb(err);
    },
  };
  return mic;
}

/** PCM chunk of `ms` with a constant amplitude (0 = silence). */
export function pcm(ms: number, amplitude = 3000, sampleRate = 16000): Buffer {
  const n = Math.floor((sampleRate * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(i % 2 ? amplitude : -amplitude, i * 2);
  return b;
}

export interface FakeTranscriber extends Transcriber {
  calls: number;
  next: Array<string | Error | Promise<string>>;
  disposed: number;
}

export function fakeTranscriber(
  results: Array<string | Error | Promise<string>> = [],
): FakeTranscriber {
  const t: FakeTranscriber = {
    calls: 0,
    disposed: 0,
    next: [...results],
    async transcribe(_wav, opts) {
      t.calls += 1;
      const r = t.next.shift() ?? "";
      if (r instanceof Error) throw r;
      const v = await r;
      if (opts.signal?.aborted) {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }
      return v;
    },
    async warm() {},
    describe: () => "fake",
    async dispose() {
      t.disposed += 1;
    },
  };
  return t;
}

export interface FakeLlm extends Llm {
  requests: Array<{ system: string; user: string }>;
  reply: string | Error | ((user: string) => string | Promise<string>);
}

export function fakeLlm(reply: FakeLlm["reply"] = "", configured = true): FakeLlm {
  const l: FakeLlm = {
    configured,
    requests: [],
    reply,
    describe: () => "fake/llm",
    async complete(req) {
      l.requests.push({ system: req.system, user: req.user });
      if (l.reply instanceof Error) throw l.reply;
      const out = typeof l.reply === "function" ? await l.reply(req.user) : l.reply;
      if (req.signal?.aborted) {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }
      return out;
    },
  };
  return l;
}

/** Manual clock: intervals fire only when advance() is called. */
export function manualClock(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { fn: () => void; ms: number; at: number }>();
  return {
    now: () => now,
    setInterval(fn: () => void, ms: number): unknown {
      const id = nextId++;
      timers.set(id, { fn, ms, at: now + ms });
      return id;
    },
    clearInterval(h: unknown) {
      timers.delete(h as number);
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        let due: { id: number; t: { fn: () => void; ms: number; at: number } } | null = null;
        for (const [id, t] of timers) if (t.at <= end && (!due || t.at < due.t.at)) due = { id, t };
        if (!due) break;
        now = due.t.at;
        due.t.at += due.t.ms;
        due.t.fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

export const flush = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

export interface FakePlayer extends Player {
  plays: Buffer[];
  seeks: number[];
  rateValue: number;
  pos: number;
  finish(end?: PlayEnd): void;
}

export function fakePlayer(): FakePlayer {
  let resolve: ((e: PlayEnd) => void) | null = null;
  let status: "idle" | "playing" | "paused" = "idle";
  const p: FakePlayer = {
    plays: [],
    play(wav) {
      resolve?.("stopped");
      p.plays.push(wav);
      status = "playing";
      return new Promise<PlayEnd>((r) => {
        resolve = r;
      });
    },
    pause() {
      if (status !== "playing") return false;
      status = "paused";
      return true;
    },
    resume() {
      if (status !== "paused") return false;
      status = "playing";
      return true;
    },
    stop() {
      status = "idle";
      const r = resolve;
      resolve = null;
      r?.("stopped");
    },
    status: () => status,
    seeks: [],
    rateValue: 1,
    positionSec: () => p.pos,
    pos: 1,
    durationSec: () => 2,
    seek(sec) {
      if (status === "idle") return false;
      p.seeks.push(sec);
      if (sec >= 2) {
        p.finish("ended");
        return true;
      }
      p.pos = Math.max(0, sec);
      return true;
    },
    setRate(r) {
      p.rateValue = r;
    },
    rate: () => p.rateValue,
    dispose() {},
    finish(end = "ended") {
      status = "idle";
      const r = resolve;
      resolve = null;
      r?.(end);
    },
  };
  return p;
}

export function fakeSynth(
  name: SynthName,
  impl?: (seg: SpeechSegment) => Promise<Buffer>,
): Synth & { calls: SpeechSegment[] } {
  const s = {
    name,
    calls: [] as SpeechSegment[],
    async synthesize(seg: SpeechSegment) {
      s.calls.push(seg);
      return impl ? impl(seg) : Buffer.from(`${name}:${seg.text}`);
    },
    supports: () => true,
    warm() {},
    async dispose() {},
  };
  return s;
}
