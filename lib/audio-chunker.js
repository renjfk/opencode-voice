// Continuous-capture audio chunker for live voice notes.
//
// Consumes a continuous stream of raw PCM16LE mono samples (as produced by
// `sox ... -t raw -`) and splits it into self-contained chunks the
// transcription lane can process independently, without ever pausing
// capture. Two triggers close a chunk:
//
//   - natural: enough speech has accumulated and a silence gap follows (a
//     real pause in the conversation - the ideal cut point)
//   - forced: the chunk hit its max duration regardless of silence (bounds
//     worst-case processing latency during continuous speech)
//
// Forced cuts carry a short audio overlap into the next chunk so a word is
// never fully lost mid-cut; the caller (notes-writer) dedupes the
// overlapping words from the transcribed text.

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE / 1000) * FRAME_MS * BYTES_PER_SAMPLE; // 640

export const CHUNKER_FRAME_MS = FRAME_MS;
export const CHUNKER_FRAME_BYTES = FRAME_BYTES;

const DEFAULTS = {
  sampleRate: SAMPLE_RATE,
  minChunkMs: 3000,
  maxChunkMs: 20000,
  silenceMs: 700,
  overlapMs: 400,
  silenceRmsThreshold: 0.02,
  minSpeechMsToKeep: 300,
  // Auto-learn the room noise floor from the first `calibrationMs` of audio
  // (usually mic hiss / HVAC before anyone speaks) instead of assuming the
  // fixed threshold fits every room. 0 disables. An explicit
  // silenceRmsThreshold always wins and skips calibration.
  calibrationMs: 0,
};

// Threshold = 2.5x the room floor, clamped so a very quiet room never drops
// into the mic's own noise and a loud room never eats quiet speech.
export const CALIBRATION_MULTIPLIER = 2.5;
export const CALIBRATION_MIN_THRESHOLD = 0.008;
export const CALIBRATION_MAX_THRESHOLD = 0.03;

export function calibrateSilenceThreshold(noiseFloorRms) {
  const t = (noiseFloorRms || 0) * CALIBRATION_MULTIPLIER;
  return Math.min(CALIBRATION_MAX_THRESHOLD, Math.max(CALIBRATION_MIN_THRESHOLD, t));
}

/**
 * RMS (0..1) of a buffer of PCM16LE mono samples. Returns 0 for an empty or
 * odd-length buffer.
 */
export function pcm16Rms(buffer) {
  const usable = buffer.length - (buffer.length % 2);
  if (usable <= 0) return 0;
  let sum = 0;
  const samples = usable / 2;
  for (let i = 0; i < usable; i += 2) {
    const n = buffer.readInt16LE(i) / 32768;
    sum += n * n;
  }
  return Math.sqrt(sum / samples);
}

/**
 * Build a standard 44-byte PCM WAV header for the given data length.
 */
export function buildWavHeader(dataLength, options = {}) {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const channels = options.channels ?? 1;
  const bitsPerSample = options.bitsPerSample ?? 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataLength, 40);
  return header;
}

/**
 * Wrap raw PCM16LE mono samples into a self-contained WAV buffer.
 */
export function wrapPcmAsWav(pcmBuffer, options = {}) {
  return Buffer.concat([buildWavHeader(pcmBuffer.length, options), pcmBuffer]);
}

/**
 * Create a stateful chunker. Feed it raw PCM16LE mono bytes via `push()` as
 * they arrive from the capture process; it returns any chunks that became
 * ready to transcribe. Call `flush()` once when capture stops to get the
 * final partial chunk.
 *
 * Chunk shape: { seq, pcm, startMs, endMs, durationMs, forced, hasSpeech }
 */
export function createPcmChunker(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const frameBytes = ((cfg.sampleRate / 1000) * FRAME_MS * BYTES_PER_SAMPLE) | 0;
  const overlapFrameCount = Math.max(0, Math.round(cfg.overlapMs / FRAME_MS));
  // Explicit threshold wins; otherwise learn the room for calibrationMs.
  const autoCalibrate = !(options.silenceRmsThreshold > 0) && cfg.calibrationMs > 0;

  let frames = [];
  let leftover = Buffer.alloc(0);
  let accMs = 0;
  let speechMs = 0;
  let silenceRun = 0;
  let startMs = 0;
  let totalElapsedMs = 0;
  let seq = 0;
  let calibrated = !autoCalibrate;
  let calibrationRms = [];
  let noiseFloorRms = null;

  function finalizeChunk(forced) {
    const pcm = Buffer.concat(frames);
    const endMs = totalElapsedMs;
    const chunk = {
      seq: seq++,
      pcm,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      forced,
      hasSpeech: speechMs >= cfg.minSpeechMsToKeep,
    };

    const keepFrames = forced ? frames.slice(-overlapFrameCount) : [];
    frames = keepFrames.map((f) => Buffer.from(f));
    accMs = frames.length * FRAME_MS;
    speechMs = 0;
    silenceRun = 0;
    startMs = endMs - accMs;

    return chunk;
  }

  function push(buffer) {
    const ready = [];
    let combined = leftover.length > 0 ? Buffer.concat([leftover, buffer]) : buffer;
    const frameCount = Math.floor(combined.length / frameBytes);
    leftover = combined.subarray(frameCount * frameBytes);

    for (let i = 0; i < frameCount; i++) {
      const frame = combined.subarray(i * frameBytes, (i + 1) * frameBytes);
      const frameRms = pcm16Rms(frame);

      // While calibrating, collect room-tone levels but don't cut on them -
      // the fixed default threshold is meaningless before we know the room.
      if (!calibrated) {
        calibrationRms.push(frameRms);
        frames.push(frame);
        accMs += FRAME_MS;
        totalElapsedMs += FRAME_MS;
        if (totalElapsedMs >= cfg.calibrationMs) {
          const sorted = [...calibrationRms].sort((a, b) => a - b);
          noiseFloorRms = sorted[Math.floor(sorted.length / 2)] ?? 0;
          cfg.silenceRmsThreshold = calibrateSilenceThreshold(noiseFloorRms);
          calibrationRms = [];
          calibrated = true;
        }
        continue;
      }

      const isSilence = frameRms < cfg.silenceRmsThreshold;

      frames.push(frame);
      accMs += FRAME_MS;
      totalElapsedMs += FRAME_MS;
      if (isSilence) silenceRun += FRAME_MS;
      else {
        silenceRun = 0;
        speechMs += FRAME_MS;
      }

      const forcedReady = accMs >= cfg.maxChunkMs;
      const naturalReady =
        !forcedReady &&
        accMs >= cfg.minChunkMs &&
        speechMs >= cfg.minSpeechMsToKeep &&
        silenceRun >= cfg.silenceMs;

      if (forcedReady || naturalReady) {
        ready.push(finalizeChunk(forcedReady));
      }
    }

    return ready;
  }

  function flush() {
    if (accMs <= 0) return null;
    return finalizeChunk(false);
  }

  function reset() {
    frames = [];
    leftover = Buffer.alloc(0);
    accMs = 0;
    speechMs = 0;
    silenceRun = 0;
    startMs = 0;
    totalElapsedMs = 0;
    seq = 0;
    calibrated = !autoCalibrate;
    calibrationRms = [];
    noiseFloorRms = null;
  }

  return {
    push,
    flush,
    reset,
    getSilenceThreshold: () => cfg.silenceRmsThreshold,
    getNoiseFloor: () => noiseFloorRms,
    isCalibrated: () => calibrated,
  };
}
