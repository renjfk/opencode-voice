import { describe, expect, test } from "bun:test";
import type { Logger, TranscribeOptions, Transcriber } from "../types.ts";
import { isAbortError } from "../types.ts";
import {
  abortError,
  parseWav,
  pcmToWav,
  planSplits,
  transcribeLong,
  wavDurationSec,
} from "./long.ts";

const SR = 16000;

/** Loud tone everywhere except silent gaps at the given second offsets. */
function speechWithGaps(totalSec: number, gaps: Array<[number, number]>): Buffer {
  const n = totalSec * SR;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const sec = i / SR;
    const silent = gaps.some(([a, b]) => sec >= a && sec < b);
    pcm.writeInt16LE(silent ? 0 : Math.round(8000 * Math.sin(i / 5)), i * 2);
  }
  return pcm;
}

function fakeTranscriber(fn: (wav: Buffer, call: number) => Promise<string>): {
  t: Transcriber;
  calls: Buffer[];
} {
  const calls: Buffer[] = [];
  const t: Transcriber = {
    transcribe: (wav: Buffer, _o: TranscribeOptions) => {
      calls.push(wav);
      return fn(wav, calls.length);
    },
    warm: async () => {},
    describe: () => "fake",
    dispose: async () => {},
  };
  return { t, calls };
}

const opts: TranscribeOptions = { language: "en" };

describe("wav helpers", () => {
  test("round trip and duration", () => {
    const wav = pcmToWav(Buffer.alloc(SR * 2 * 3), SR);
    const info = parseWav(wav);
    expect(info).toEqual({
      sampleRate: SR,
      channels: 1,
      bitsPerSample: 16,
      dataOffset: 44,
      dataLength: SR * 2 * 3,
    });
    expect(wavDurationSec(wav)).toBe(3);
  });

  test("skips extra chunks before data and clamps oversized data length", () => {
    const base = pcmToWav(Buffer.alloc(SR * 2), SR);
    const list = Buffer.alloc(12);
    list.write("LIST", 0, "ascii");
    list.writeUInt32LE(4, 4);
    list.write("INFO", 8, "ascii");
    const wav = Buffer.concat([base.subarray(0, 36), list, base.subarray(36)]);
    wav.writeUInt32LE(0xffffffff, 36 + 12 + 4);
    const info = parseWav(wav);
    expect(info?.dataOffset).toBe(56);
    expect(info?.dataLength).toBe(SR * 2);
  });

  test("non-wav returns null / 0", () => {
    expect(parseWav(Buffer.from("not a wav file at all"))).toBeNull();
    expect(wavDurationSec(Buffer.alloc(4))).toBe(0);
  });
});

describe("planSplits", () => {
  test("cuts inside the quiet gap near each boundary", () => {
    const pcm = speechWithGaps(70, [
      [25, 26],
      [52, 53],
    ]);
    const spans = planSplits(pcm, SR, 30);
    expect(spans).toHaveLength(3);
    const cuts = spans.slice(0, -1).map(([, end]) => end / SR);
    expect(cuts[0]).toBeGreaterThanOrEqual(25);
    expect(cuts[0]).toBeLessThanOrEqual(26);
    expect(cuts[1]).toBeGreaterThanOrEqual(52);
    expect(cuts[1]).toBeLessThanOrEqual(53);
    // contiguous, covering everything
    expect(spans[0]?.[0]).toBe(0);
    expect(spans.at(-1)?.[1]).toBe(70 * SR);
    for (let i = 1; i < spans.length; i++) expect(spans[i]?.[0]).toBe(spans[i - 1]?.[1] ?? -1);
    for (const [a, b] of spans) expect((b - a) / SR).toBeLessThanOrEqual(30);
  });

  test("a sliver tail merges into the previous span", () => {
    // Quiet gap right before the boundary -> cut ~30.75s, 0.25s tail.
    const pcm = speechWithGaps(31, [[30.5, 30.8]]);
    const spans = planSplits(pcm, SR, 30.8);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toEqual([0, 31 * SR]);
  });
});

describe("transcribeLong", () => {
  test("short audio goes straight through, cleaned and filtered", async () => {
    const { t, calls } = fakeTranscriber(async () => " [BLANK_AUDIO] can you fix the test ");
    const wav = pcmToWav(speechWithGaps(5, []), SR);
    expect(await transcribeLong(t, wav, opts)).toBe("can you fix the test");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(wav);
  });

  test("short hallucination returns empty", async () => {
    const { t } = fakeTranscriber(async () => "Thank you.");
    expect(await transcribeLong(t, pcmToWav(speechWithGaps(2, []), SR), opts)).toBe("");
  });

  test("header-only wav throws an actionable error", async () => {
    const { t, calls } = fakeTranscriber(async () => "x");
    await expect(transcribeLong(t, pcmToWav(Buffer.alloc(0), SR), opts)).rejects.toThrow(
      "Recording is empty",
    );
    expect(calls).toHaveLength(0);
  });

  test("long audio is split into valid wav chunks and joined", async () => {
    const { t, calls } = fakeTranscriber(async (_w, n) => `part ${n}`);
    const wav = pcmToWav(speechWithGaps(70, [[25, 26]]), SR);
    expect(await transcribeLong(t, wav, opts)).toBe("part 1 part 2 part 3");
    expect(calls).toHaveLength(3);
    const total = calls.reduce((s, c) => s + wavDurationSec(c), 0);
    expect(total).toBeCloseTo(70, 5);
    for (const c of calls) expect(parseWav(c)?.sampleRate).toBe(SR);
  });

  test("one failing chunk is tolerated and logged", async () => {
    const logs: string[] = [];
    const logger: Logger = { log: (_s, m) => logs.push(m) };
    const { t } = fakeTranscriber(async (_w, n) => {
      if (n === 2) throw new Error("whisper-cli failed: boom");
      return n === 3 ? "Thank you." : `part ${n}`;
    });
    const wav = pcmToWav(speechWithGaps(70, []), SR);
    expect(await transcribeLong(t, wav, opts, { logger })).toBe("part 1");
    expect(logs.some((l) => l.includes("chunk 2/3 failed"))).toBe(true);
    expect(logs.some((l) => l.includes("kept 1/3"))).toBe(true);
  });

  test("all chunks failing throws with the first error", async () => {
    const { t } = fakeTranscriber(async (_w, n) => {
      throw new Error(`fail ${n}`);
    });
    const wav = pcmToWav(speechWithGaps(65, []), SR);
    await expect(transcribeLong(t, wav, opts)).rejects.toThrow(
      "Transcription failed for all 3 parts: fail 1",
    );
  });

  test("all chunks empty is not an error", async () => {
    const { t } = fakeTranscriber(async () => "");
    expect(await transcribeLong(t, pcmToWav(speechWithGaps(65, []), SR), opts)).toBe("");
  });

  test("abort stops at once and rethrows", async () => {
    const ctl = new AbortController();
    const { t, calls } = fakeTranscriber(async () => {
      ctl.abort();
      throw abortError();
    });
    const wav = pcmToWav(speechWithGaps(70, []), SR);
    const err = await transcribeLong(t, wav, { language: "en", signal: ctl.signal }).catch(
      (e: unknown) => e,
    );
    expect(isAbortError(err)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("custom maxChunkSec", async () => {
    const { t, calls } = fakeTranscriber(async () => "x");
    await transcribeLong(t, pcmToWav(speechWithGaps(20, []), SR), opts, { maxChunkSec: 10 });
    expect(calls).toHaveLength(2);
  });
});
