import { describe, expect, test } from "bun:test";
import type {
  MicError,
  MicStream,
  StreamingPartial,
  TranscribeOptions,
  Transcriber,
} from "../types.ts";
import { createStreamingSession, type StreamingClock } from "./streaming.ts";
import { normalizeWord, splitWords } from "./transcript.ts";

const RATE = 16000;
const BYTES_PER_MS = (RATE * 2) / 1000;

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function flushAll(): Promise<void> {
  for (let i = 0; i < 5; i++) await flush();
}

function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();
  const clock: StreamingClock = {
    now: () => now,
    setTimeout(cb, ms) {
      seq += 1;
      timers.set(seq, { at: now + ms, cb });
      return seq;
    },
    clearTimeout(handle) {
      if (typeof handle === "number") timers.delete(handle);
    },
  };
  return {
    clock,
    async advance(ms: number): Promise<void> {
      const target = now + ms;
      for (;;) {
        let nextId: number | null = null;
        let nextAt = Infinity;
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < nextAt) {
            nextAt = t.at;
            nextId = id;
          }
        }
        if (nextId === null) break;
        const t = timers.get(nextId);
        timers.delete(nextId);
        now = nextAt;
        t?.cb();
        await flushAll();
      }
      now = target;
      await flushAll();
    },
  };
}

function pcm(ms: number, amplitude: number): Buffer {
  const samples = Math.round(ms * (RATE / 1000));
  const buf = Buffer.alloc(samples * 2);
  const v = Math.round(amplitude * 32767);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 === 0 ? v : -v, i * 2);
  return buf;
}

function fakeMic() {
  const dataCbs = new Set<(c: Buffer) => void>();
  const errCbs = new Set<(e: MicError) => void>();
  const state = { paused: false, stopped: false, killed: false, pauses: 0, resumes: 0 };
  const mic: MicStream = {
    onData(cb) {
      dataCbs.add(cb);
      return () => dataCbs.delete(cb);
    },
    onError(cb) {
      errCbs.add(cb);
      return () => errCbs.delete(cb);
    },
    pause() {
      state.paused = true;
      state.pauses += 1;
    },
    resume() {
      state.paused = false;
      state.resumes += 1;
    },
    get paused() {
      return state.paused;
    },
    async stop() {
      state.stopped = true;
    },
    kill() {
      state.killed = true;
    },
    format: { sampleRate: RATE },
  };
  return {
    mic,
    state,
    /** Deliver audio (dropped while paused, like a real MicStream). */
    push(ms: number, amplitude = 0.3): void {
      if (state.paused) return;
      const chunk = pcm(ms, amplitude);
      for (const cb of dataCbs) cb(chunk);
    },
    /** Deliver audio even while paused (misbehaving mic). */
    pushRaw(ms: number, amplitude = 0.3): void {
      const chunk = pcm(ms, amplitude);
      for (const cb of dataCbs) cb(chunk);
    },
    error(e: MicError): void {
      for (const cb of errCbs) cb(e);
    },
  };
}

interface Call {
  readonly index: number;
  readonly durMs: number;
  readonly signal: AbortSignal | undefined;
}

function fakeTranscriber(handler: (call: Call) => Promise<string> | string) {
  const calls: Call[] = [];
  const transcriber: Transcriber = {
    async transcribe(wav: Buffer, opts: TranscribeOptions) {
      expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(wav.readUInt32LE(24)).toBe(RATE);
      const call = {
        index: calls.length,
        durMs: (wav.length - 44) / BYTES_PER_MS,
        signal: opts.signal,
      };
      calls.push(call);
      return handler(call);
    },
    warm: async () => {},
    describe: () => "fake",
    dispose: async () => {},
  };
  return { transcriber, calls };
}

function scripted(lines: readonly string[]) {
  return (call: Call): string => {
    const line = lines[call.index];
    if (line === undefined) throw new Error(`unexpected call ${call.index}`);
    return line;
  };
}

function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  let reject: (e: Error) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(
  handler: (call: Call) => Promise<string> | string,
  extra: {
    windowMs?: number;
    fullFinalMaxSec?: number;
    maxSpoolSec?: number;
  } = {},
) {
  const clk = fakeClock();
  const m = fakeMic();
  const t = fakeTranscriber(handler);
  const partials: StreamingPartial[] = [];
  const errors: Error[] = [];
  const session = createStreamingSession({
    mic: m.mic,
    transcriber: t.transcriber,
    language: "en",
    clock: clk.clock,
    onPartial: (p) => partials.push(p),
    onError: (e) => errors.push(e),
    ...extra,
  });
  /** One second of speech, then one cadence. */
  async function step(ms = 1000, amplitude = 0.3): Promise<void> {
    m.push(ms, amplitude);
    await clk.advance(ms);
  }
  return { clk, m, t, partials, errors, session, step };
}

function hasRepeatedPhrase(text: string, n = 3): boolean {
  const words = splitWords(text).map(normalizeWord);
  const seen = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) {
    const key = words.slice(i, i + n).join(" ");
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

describe("ticks and partials", () => {
  test("emits partials only when they change", async () => {
    const s = setup(
      scripted(["hello world", "hello world how", "hello world how", "hello world how"]),
    );
    s.session.start();
    for (let i = 0; i < 4; i++) await s.step();
    expect(s.t.calls.length).toBe(4);
    expect(s.partials).toEqual([
      { stable: "", tentative: "hello world" },
      { stable: "hello world", tentative: "how" },
      { stable: "hello world how", tentative: "" },
    ]);
  });

  test("each tick decodes at most windowMs of audio", async () => {
    const s = setup(() => "", { windowMs: 3000 });
    s.session.start();
    for (let i = 0; i < 5; i++) await s.step();
    expect(s.t.calls.map((c) => c.durMs)).toEqual([1000, 2000, 3000, 3000, 3000]);
  });

  test("no tick without new audio", async () => {
    const s = setup(() => "x");
    s.session.start();
    await s.clk.advance(3000);
    expect(s.t.calls.length).toBe(0);
    await s.step();
    await s.clk.advance(3000);
    expect(s.t.calls.length).toBe(1);
  });

  test("never overlaps requests: ticks skip while one is in flight", async () => {
    const d = deferred<string>();
    const s = setup((call) => (call.index === 0 ? d.promise : "a b"));
    s.session.start();
    for (let i = 0; i < 5; i++) await s.step();
    expect(s.t.calls.length).toBe(1);
    d.resolve("a");
    await flushAll();
    expect(s.partials).toEqual([{ stable: "", tentative: "a" }]);
    await s.step();
    expect(s.t.calls.length).toBe(2);
  });

  test("regression: rolling window never duplicates the hypothesis", async () => {
    const s = setup(
      scripted([
        "the quick brown fox jumps over the lazy dog",
        "uick brown fox jumps over the lazy dog and runs",
        "brown fox jumps over the lazy dog and ran away",
        "Fox jumped over the lazy dog and ran away fast today",
      ]),
      { windowMs: 3000 },
    );
    s.session.start();
    for (let i = 0; i < 4; i++) await s.step();
    const last = s.partials.at(-1);
    const text = `${last?.stable ?? ""} ${last?.tentative ?? ""}`.trim();
    expect(hasRepeatedPhrase(text)).toBe(false);
    expect(text).toBe("the quick brown fox jumps over the lazy dog and ran away fast today");
  });

  test("revised tentative is replaced", async () => {
    const s = setup(scripted(["a b c d", "a b c d e", "a b c d f g"]));
    s.session.start();
    for (let i = 0; i < 3; i++) await s.step();
    expect(s.partials.at(-1)).toEqual({ stable: "a b c d", tentative: "f g" });
  });
});

describe("tick errors", () => {
  test("two consecutive failures are tolerated, the third ends the session", async () => {
    const s = setup((call) => {
      if (call.index === 2) return "ok";
      throw new Error("server 500");
    });
    s.session.start();
    for (let i = 0; i < 5; i++) await s.step();
    // calls 0,1 fail, 2 succeeds (resets), 3,4 fail: still alive.
    expect(s.errors.length).toBe(0);
    await s.step();
    expect(s.errors.length).toBe(1);
    expect(s.errors[0]?.message).toContain("failed 3 times in a row (server 500)");
    expect(s.errors[0]?.message).not.toContain("\n");
    const callsAtFailure = s.t.calls.length;
    for (let i = 0; i < 3; i++) await s.step();
    expect(s.t.calls.length).toBe(callsAtFailure);
    expect(s.errors.length).toBe(1);
  });
});

describe("pause / level / silence", () => {
  test("pause stops inference and freezes silence at 0", async () => {
    const s = setup(() => "words");
    s.session.start();
    await s.step();
    await s.step();
    expect(s.t.calls.length).toBe(2);
    expect(s.session.level()).toBeGreaterThan(0.2);

    s.session.pause();
    expect(s.session.paused).toBe(true);
    expect(s.m.state.paused).toBe(true);
    s.m.pushRaw(500); // a mic that leaks audio while paused is ignored too
    for (let i = 0; i < 5; i++) await s.step();
    expect(s.t.calls.length).toBe(2);
    expect(s.session.silenceMs()).toBe(0);
    expect(s.session.level()).toBe(0);

    s.session.resume();
    expect(s.m.state.resumes).toBe(1);
    expect(s.session.paused).toBe(false);
    expect(s.session.silenceMs()).toBe(0);
    await s.step(1000, 0); // silent audio after resume
    expect(s.t.calls.length).toBe(3);
    expect(s.session.silenceMs()).toBe(1000);
    // The window after resume contains no paused audio: 2s before + 1s after.
    expect(s.t.calls[2]?.durMs).toBe(3000);
  });

  test("silenceMs: 0 before audio, grace for unvoiced start, then time since voice", async () => {
    const s = setup(() => "");
    s.session.start();
    await s.clk.advance(2000);
    expect(s.session.silenceMs()).toBe(0);
    s.m.push(100, 0); // unvoiced audio starts at t=2000
    await s.clk.advance(500);
    expect(s.session.silenceMs()).toBe(0);
    await s.clk.advance(1000);
    expect(s.session.silenceMs()).toBe(1500);
    s.m.push(100, 0.3); // voiced at t=3500
    expect(s.session.silenceMs()).toBe(0);
    await s.clk.advance(2500);
    expect(s.session.silenceMs()).toBe(2500);
    expect(s.session.level()).toBeGreaterThan(0.2);
  });
});

test("silenceMs on a noisy mic: background noise above the laptop threshold still counts as silence", async () => {
  const s = setup(() => "");
  s.session.start();
  for (let i = 0; i < 10; i++) s.m.push(100, 0.02); // phone-like noise floor
  s.m.push(300, 0.3); // speech
  await s.clk.advance(100);
  for (let i = 0; i < 20; i++) s.m.push(100, 0.02); // noise again
  await s.clk.advance(2400);
  expect(s.session.silenceMs()).toBeGreaterThanOrEqual(2400);
});

describe("finish", () => {
  test("full-utterance final decode wins even when shorter than the live text", async () => {
    const s = setup((call) =>
      call.index < 2 ? (["a b c", "a b c d e"][call.index] ?? "") : "clean",
    );
    s.session.start();
    await s.step();
    await s.step();
    s.m.push(300);
    const text = await s.session.finish();
    expect(text).toBe("clean");
    expect(s.m.state.stopped).toBe(true);
    expect(s.t.calls.at(-1)?.durMs).toBe(2300);
  });

  test("falls back to the live transcript when the final decode throws", async () => {
    const s = setup((call) => {
      if (call.index === 0) return "hello there";
      if (call.index === 1) return "hello there friend";
      throw new Error("boom");
    });
    s.session.start();
    await s.step();
    await s.step();
    expect(await s.session.finish()).toBe("hello there friend");
    expect(s.errors.length).toBe(0);
  });

  test("falls back to the live transcript when the final decode is empty", async () => {
    const s = setup((call) => (call.index === 0 ? "only words" : "   "));
    s.session.start();
    await s.step();
    expect(await s.session.finish()).toBe("only words");
  });

  test("final decode timeout falls back to the live transcript", async () => {
    const s = setup((call) => (call.index === 0 ? "live" : new Promise<string>(() => {})));
    s.session.start();
    await s.step();
    const done = s.session.finish();
    await flushAll();
    await s.clk.advance(60_000);
    expect(await done).toBe("live");
  });

  test("returns empty when nothing was captured", async () => {
    const s = setup(() => "never");
    s.session.start();
    expect(await s.session.finish()).toBe("");
    expect(s.t.calls.length).toBe(0);
  });

  test("long session decodes only the tail after the last stable window", async () => {
    const s = setup(
      scripted([
        "one two",
        "one two three",
        "two three four",
        "three four five",
        "four five six",
        "four five six seven",
      ]),
      { windowMs: 2000, fullFinalMaxSec: 3 },
    );
    s.session.start();
    for (let i = 0; i < 5; i++) await s.step();
    expect(s.partials.at(-1)).toEqual({ stable: "one two three four five", tentative: "six" });
    s.m.push(500);
    const text = await s.session.finish();
    // Stable last advanced in the [3000, 5000] window: tail = 3000..5500.
    expect(s.t.calls.at(-1)?.durMs).toBe(2500);
    expect(text).toBe("one two three four five six seven");
  });

  test("spool overflow disables the full decode and uses the tail", async () => {
    const s = setup(scripted(["a b", "a b c", "b c d", "b c d e"]), {
      windowMs: 2000,
      maxSpoolSec: 2,
    });
    s.session.start();
    for (let i = 0; i < 3; i++) await s.step();
    const text = await s.session.finish();
    // 3s captured but only 2s retained: tail from the retained start.
    expect(s.t.calls.at(-1)?.durMs).toBe(2000);
    expect(text).toBe("a b c d e");
  });

  test("aborts the in-flight tick, stops the mic, and is idempotent", async () => {
    const tick = deferred<string>();
    const s = setup((call) => (call.index === 0 ? tick.promise : "final words"));
    s.session.start();
    await s.step();
    const first = s.session.finish();
    const second = s.session.finish();
    expect(first).toBe(second);
    expect(s.t.calls[0]?.signal?.aborted).toBe(true);
    expect(await first).toBe("final words");
    expect(s.m.state.stopped).toBe(true);
    tick.resolve("late");
    await flushAll();
    expect(s.partials.length).toBe(0);
    // Finished sessions stay quiet.
    s.m.error({ code: "EXITED", message: "gone" });
    expect(s.errors.length).toBe(0);
  });
});

describe("cancel and mic errors", () => {
  test("cancel kills the mic and suppresses every later callback", async () => {
    const tick = deferred<string>();
    const s = setup(() => tick.promise);
    s.session.start();
    await s.step();
    s.session.cancel();
    expect(s.m.state.killed).toBe(true);
    expect(s.t.calls[0]?.signal?.aborted).toBe(true);
    tick.resolve("late words");
    await flushAll();
    s.m.error({ code: "EXITED", message: "gone" });
    await s.step();
    expect(s.partials.length).toBe(0);
    expect(s.errors.length).toBe(0);
    expect(s.t.calls.length).toBe(1);
    expect(await s.session.finish()).toBe("");
  });

  test("cancel during the final decode makes finish return empty", async () => {
    const final = deferred<string>();
    const s = setup((call) => (call.index === 0 ? "live" : final.promise));
    s.session.start();
    await s.step();
    const done = s.session.finish();
    await flushAll();
    s.session.cancel();
    expect(s.t.calls[1]?.signal?.aborted).toBe(true);
    final.resolve("final");
    expect(await done).toBe("");
  });

  test("mic error reports once and stops ticks", async () => {
    const s = setup(() => "x");
    s.session.start();
    await s.step();
    s.m.error({
      code: "EXITED",
      message: "Mic stopped unexpectedly.",
      hint: "Check the mic and retry.",
    });
    s.m.error({ code: "EXITED", message: "again" });
    expect(s.errors.map((e) => e.message)).toEqual([
      "Mic stopped unexpectedly. Check the mic and retry.",
    ]);
    for (let i = 0; i < 3; i++) await s.step();
    expect(s.t.calls.length).toBe(1);
  });
});
