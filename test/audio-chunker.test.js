import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWavHeader,
  calibrateSilenceThreshold,
  createPcmChunker,
  pcm16Rms,
  wrapPcmAsWav,
} from "../lib/audio-chunker.js";

const SAMPLE_RATE = 16000;

function silenceBuffer(ms) {
  const samples = (SAMPLE_RATE / 1000) * ms;
  return Buffer.alloc(samples * 2, 0);
}

// Constant-value buffer (not a real waveform, but deterministic and well
// above any sane silence threshold) - simplest way to simulate "speech".
function toneBuffer(ms, amplitude = 20000) {
  const samples = (SAMPLE_RATE / 1000) * ms;
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(amplitude, i * 2);
  return buf;
}

test("pcm16Rms is 0 for silence and matches amplitude ratio for constant tone", () => {
  assert.equal(pcm16Rms(silenceBuffer(20)), 0);
  const rms = pcm16Rms(toneBuffer(20, 16384));
  assert.ok(Math.abs(rms - 0.5) < 1e-9);
  assert.equal(pcm16Rms(Buffer.alloc(0)), 0);
  assert.equal(pcm16Rms(Buffer.alloc(1)), 0); // odd length, no full samples
});

test("builds a valid 44-byte PCM WAV header", () => {
  const header = buildWavHeader(1000, { sampleRate: 16000, channels: 1, bitsPerSample: 16 });
  assert.equal(header.length, 44);
  assert.equal(header.toString("ascii", 0, 4), "RIFF");
  assert.equal(header.toString("ascii", 8, 12), "WAVE");
  assert.equal(header.readUInt32LE(4), 36 + 1000);
  assert.equal(header.readUInt32LE(40), 1000);
  assert.equal(header.readUInt16LE(22), 1); // channels
  assert.equal(header.readUInt32LE(24), 16000); // sample rate
  assert.equal(header.readUInt16LE(34), 16); // bits per sample
});

test("wraps PCM as a self-contained WAV buffer", () => {
  const pcm = toneBuffer(20);
  const wav = wrapPcmAsWav(pcm, { sampleRate: 16000 });
  assert.equal(wav.length, 44 + pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
});

test("chunker closes naturally once enough speech is followed by a real pause", () => {
  const chunker = createPcmChunker({
    minChunkMs: 1000,
    maxChunkMs: 5000,
    silenceMs: 200,
    overlapMs: 100,
    silenceRmsThreshold: 0.05,
    minSpeechMsToKeep: 100,
  });

  assert.deepEqual(chunker.push(toneBuffer(500)), []);
  const ready = chunker.push(silenceBuffer(500));

  assert.equal(ready.length, 1);
  const chunk = ready[0];
  assert.equal(chunk.seq, 0);
  assert.equal(chunk.forced, false);
  assert.equal(chunk.hasSpeech, true);
  assert.equal(chunk.startMs, 0);
  assert.equal(chunk.endMs, 1000);
  assert.equal(chunk.durationMs, 1000);
  assert.equal(chunk.pcm.length, (SAMPLE_RATE / 1000) * 1000 * 2);
});

test("chunker force-splits continuous speech at the max duration and carries overlap", () => {
  const chunker = createPcmChunker({
    minChunkMs: 500,
    maxChunkMs: 2000,
    silenceMs: 300,
    overlapMs: 100,
    silenceRmsThreshold: 0.05,
    minSpeechMsToKeep: 100,
  });

  // Continuous speech, never pauses - only the max-duration cut can close it.
  const ready = chunker.push(toneBuffer(2000));
  assert.equal(ready.length, 1);
  const first = ready[0];
  assert.equal(first.forced, true);
  assert.equal(first.hasSpeech, true);
  assert.equal(first.startMs, 0);
  assert.equal(first.endMs, 2000);

  // The next chunk should start `overlapMs` before the previous one ended,
  // so no word is fully lost across the forced cut. Its own duration is
  // still exactly maxChunkMs worth of audio (the overlap is carried
  // forward, not added on top).
  const more = chunker.push(toneBuffer(2000));
  assert.equal(more.length, 1);
  const second = more[0];
  assert.equal(second.startMs, first.endMs - 100);
  assert.equal(second.durationMs, 2000);
  assert.equal(second.pcm.length, (2000 / 1000) * SAMPLE_RATE * 2);
});

test("chunker force-flushes pure silence too, so memory stays bounded", () => {
  const chunker = createPcmChunker({
    minChunkMs: 500,
    maxChunkMs: 1000,
    silenceMs: 300,
    overlapMs: 0,
    silenceRmsThreshold: 0.05,
    minSpeechMsToKeep: 100,
  });

  const ready = chunker.push(silenceBuffer(1000));
  assert.equal(ready.length, 1);
  assert.equal(ready[0].forced, true);
  assert.equal(ready[0].hasSpeech, false);
});

test("calibrateSilenceThreshold scales with the room, clamped on both ends", () => {
  assert.ok(Math.abs(calibrateSilenceThreshold(0.0049) - 0.01225) < 1e-9);
  assert.equal(calibrateSilenceThreshold(0), 0.008); // dead-quiet room: floor clamp
  assert.equal(calibrateSilenceThreshold(1), 0.03); // loud room: ceiling clamp
});

test("chunker learns a quiet room so faint speech counts as speech", () => {
  // Room floor RMS ~0.0049 -> calibrated threshold ~0.0122. Speech at RMS
  // ~0.0153 is BELOW the fixed 0.02 default (would be swallowed as silence)
  // but ABOVE the learned threshold (correctly kept as speech).
  const chunker = createPcmChunker({
    minChunkMs: 500,
    maxChunkMs: 20000,
    silenceMs: 200,
    overlapMs: 0,
    minSpeechMsToKeep: 100,
    calibrationMs: 200,
  });
  assert.equal(chunker.isCalibrated(), false);

  assert.deepEqual(chunker.push(toneBuffer(200, 160)), []); // room tone, no cuts yet
  assert.equal(chunker.isCalibrated(), true);
  assert.ok(Math.abs(chunker.getNoiseFloor() - 160 / 32768) < 1e-6);
  assert.ok(Math.abs(chunker.getSilenceThreshold() - (160 / 32768) * 2.5) < 1e-6);

  const ready = [...chunker.push(toneBuffer(600, 500)), ...chunker.push(silenceBuffer(400))];
  assert.equal(ready.length, 1);
  assert.equal(ready[0].forced, false);
  assert.equal(ready[0].hasSpeech, true);
});

test("explicit silenceRmsThreshold disables room calibration", () => {
  const chunker = createPcmChunker({ silenceRmsThreshold: 0.05, calibrationMs: 200 });
  assert.equal(chunker.isCalibrated(), true);
  assert.equal(chunker.getSilenceThreshold(), 0.05);
});

test("flush() emits the trailing partial chunk and reports empty when nothing pending", () => {
  const chunker = createPcmChunker({
    minChunkMs: 5000,
    maxChunkMs: 20000,
    silenceMs: 700,
    overlapMs: 400,
    silenceRmsThreshold: 0.05,
    minSpeechMsToKeep: 100,
  });

  assert.equal(chunker.flush(), null);

  chunker.push(toneBuffer(400));
  const final = chunker.flush();
  assert.ok(final);
  assert.equal(final.forced, false);
  assert.equal(final.durationMs, 400);
  assert.equal(final.hasSpeech, true);

  assert.equal(chunker.flush(), null);
});
