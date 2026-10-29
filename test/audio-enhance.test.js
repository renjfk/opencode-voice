import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildEnhanceArgs,
  computeGainDb,
  enhanceWavFile,
  measurePcmStats,
  rmsToDb,
} from "../lib/audio-enhance.js";
import { wrapPcmAsWav } from "../lib/audio-chunker.js";

const SAMPLE_RATE = 16000;

function constantPcm(value, ms) {
  const samples = Math.floor((SAMPLE_RATE * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(value, i * 2);
  return buf;
}

function sinePcm(amplitude, ms, freqHz = 440) {
  const samples = Math.floor((SAMPLE_RATE * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(
      Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE)),
      i * 2,
    );
  }
  return buf;
}

function soxAvailable() {
  try {
    const res = spawnSync("sox", ["--version"], { timeout: 5000 });
    return !res.error && res.status === 0;
  } catch {
    return false;
  }
}

test("measurePcmStats reports rms and peak", () => {
  assert.deepEqual(measurePcmStats(Buffer.alloc(640)), { rms: 0, peak: 0 });
  const stats = measurePcmStats(constantPcm(1000, 20));
  assert.ok(Math.abs(stats.rms - 1000 / 32768) < 1e-6);
  assert.ok(Math.abs(stats.peak - 1000 / 32768) < 1e-6);
});

test("computeGainDb brings quiet audio to target, never touches loud audio", () => {
  assert.equal(computeGainDb(0.01, { targetRms: 0.1 }), 20);
  assert.equal(computeGainDb(0.1, { targetRms: 0.1 }), 0);
  assert.equal(computeGainDb(0.3, { targetRms: 0.1 }), 0);
  assert.equal(computeGainDb(0, { targetRms: 0.1 }), 0);
  // Capped so a near-silent chunk never becomes pure amplified noise.
  assert.equal(computeGainDb(0.0001, { targetRms: 0.1, maxGainDb: 24 }), 24);
});

test("rmsToDb converts level to decibels", () => {
  assert.equal(rmsToDb(1), 0);
  assert.ok(Math.abs(rmsToDb(0.1) - -20) < 1e-9);
  assert.equal(rmsToDb(0), -Infinity);
});

test("buildEnhanceArgs strips rumble then applies limited gain", () => {
  assert.deepEqual(buildEnhanceArgs(17.3), ["highpass", "80", "gain", "-l", "17.3"]);
});

test(
  "enhanceWavFile lifts a quiet tone to the target level",
  { skip: !soxAvailable() },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enhance-"));
    const wavPath = path.join(dir, "quiet.wav");
    const pcm = sinePcm(0.02, 1000);
    fs.writeFileSync(wavPath, wrapPcmAsWav(pcm, { sampleRate: SAMPLE_RATE }));

    const stats = await enhanceWavFile(wavPath, pcm, { targetRms: 0.1, maxGainDb: 24 });
    assert.equal(stats.enhanced, true);
    assert.ok(stats.gainDb > 10 && stats.gainDb <= 24, `gainDb=${stats.gainDb}`);
    assert.ok(
      Math.abs(stats.rmsAfter - 0.1) < 0.03,
      `rmsAfter=${stats.rmsAfter} (before=${stats.rmsBefore})`,
    );
    assert.ok(stats.peakAfter <= 1);
    fs.rmSync(dir, { recursive: true, force: true });
  },
);

test("enhanceWavFile is async and never blocks on spawnSync", async () => {
  // Regression: the sync spawnSync stalled the shared event loop (and the
  // live-capture stdout drain). The fast paths must return a real promise.
  const maybe = enhanceWavFile("/nonexistent.wav", Buffer.alloc(32000), {});
  assert.equal(typeof maybe?.then, "function");
  const stats = await maybe;
  assert.equal(stats.enhanced, false);
  assert.equal(stats.reason, "too-quiet");
});

test("enhanceWavFile module uses async spawn only", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "lib", "audio-enhance.js"),
    "utf-8",
  );
  assert.doesNotMatch(src, /spawnSync/);
});

test(
  "enhanceWavFile leaves loud audio and silence untouched",
  { skip: !soxAvailable() },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enhance-"));

    const loudPath = path.join(dir, "loud.wav");
    const loudPcm = sinePcm(0.4, 500);
    fs.writeFileSync(loudPath, wrapPcmAsWav(loudPcm, { sampleRate: SAMPLE_RATE }));
    const before = fs.readFileSync(loudPath);
    const loud = await enhanceWavFile(loudPath, loudPcm, {});
    assert.equal(loud.enhanced, false);
    assert.equal(loud.reason, "already-loud");
    assert.deepEqual(fs.readFileSync(loudPath), before);

    const quietPath = path.join(dir, "silence.wav");
    const silencePcm = Buffer.alloc(32000);
    fs.writeFileSync(quietPath, wrapPcmAsWav(silencePcm, { sampleRate: SAMPLE_RATE }));
    const silence = await enhanceWavFile(quietPath, silencePcm, {});
    assert.equal(silence.enhanced, false);
    assert.equal(silence.reason, "too-quiet");
    fs.rmSync(dir, { recursive: true, force: true });
  },
);
