import { describe, expect, test } from "bun:test";
import { parseWav, pcmRms, wavDurationSec, wrapPcm } from "./wav.ts";

function pcmOf(samples: number[]): Buffer {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
}

describe("wav", () => {
  test("wrapPcm round-trips through parseWav", () => {
    const pcm = pcmOf([1, -2, 3, 32767]);
    const wav = wrapPcm(pcm, 16000);
    expect(wav.length).toBe(44 + pcm.length);
    const info = parseWav(wav);
    expect(info).not.toBeNull();
    expect(info?.sampleRate).toBe(16000);
    expect(info?.channels).toBe(1);
    expect(info?.bits).toBe(16);
    expect(info?.data.equals(pcm)).toBe(true);
  });

  test("tolerates a data size larger than the buffer (streamed 0xFFFFFFFF)", () => {
    const pcm = Buffer.alloc(3200);
    const wav = wrapPcm(pcm, 16000);
    wav.writeUInt32LE(0xffffffff, 40);
    wav.writeUInt32LE(0xffffffff, 4);
    const info = parseWav(wav);
    expect(info?.data.length).toBe(3200);
    expect(wavDurationSec(wav)).toBeCloseTo(0.1, 6);
  });

  test("walks extra chunks (LIST, odd-sized pad) before data", () => {
    const pcm = pcmOf([5, 6]);
    const base = wrapPcm(pcm, 22050);
    const list = Buffer.alloc(8 + 3 + 1);
    list.write("LIST", 0, "ascii");
    list.writeUInt32LE(3, 4);
    const wav = Buffer.concat([base.subarray(0, 36), list, base.subarray(36)]);
    const info = parseWav(wav);
    expect(info?.sampleRate).toBe(22050);
    expect(info?.data.equals(pcm)).toBe(true);
  });

  test("rejects non-WAV, missing fmt, and truncated input", () => {
    expect(parseWav(Buffer.from("hello world, not a wav"))).toBeNull();
    expect(parseWav(Buffer.alloc(4))).toBeNull();
    const noFmt = Buffer.alloc(20);
    noFmt.write("RIFF", 0, "ascii");
    noFmt.write("WAVE", 8, "ascii");
    noFmt.write("data", 12, "ascii");
    noFmt.writeUInt32LE(0, 16);
    expect(parseWav(noFmt)).toBeNull();
    expect(wavDurationSec(Buffer.from("nope"))).toBeNull();
  });

  test("wavDurationSec uses real data length", () => {
    expect(wavDurationSec(wrapPcm(Buffer.alloc(32000), 16000))).toBe(1);
  });

  test("pcmRms", () => {
    expect(pcmRms(Buffer.alloc(0))).toBe(0);
    expect(pcmRms(Buffer.alloc(1))).toBe(0);
    expect(pcmRms(pcmOf([0, 0, 0]))).toBe(0);
    expect(pcmRms(pcmOf([-32768, -32768]))).toBe(1);
    expect(pcmRms(pcmOf([16384, -16384]))).toBeCloseTo(0.5, 6);
  });
});
