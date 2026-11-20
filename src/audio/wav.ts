// WAV / PCM helpers. Raw PCM is always s16le mono (see src/types.ts).

export interface WavInfo {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bits: number;
  /** PCM payload. Clamped to the buffer when the header claims more. */
  readonly data: Buffer;
}

/** Wrap s16le mono PCM in a 44-byte PCM WAV header. */
export function wrapPcm(pcm: Buffer, sampleRate: number): Buffer {
  const channels = 1;
  const bits = 16;
  const blockAlign = channels * (bits / 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Walk RIFF chunks to find `fmt ` and `data`. Tolerates a data size larger
 * than the buffer (streamed WAVs write 0xFFFFFFFF or a stale size).
 */
export function parseWav(buf: Buffer): WavInfo | null {
  if (buf.length < 12) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let fmt: { sampleRate: number; channels: number; bits: number } | null = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > buf.length) return null;
      const channels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      if (channels === 0 || sampleRate === 0 || bits === 0) return null;
      fmt = { sampleRate, channels, bits };
    } else if (id === "data") {
      if (!fmt) return null;
      const end = Math.min(buf.length, body + size);
      return { ...fmt, data: buf.subarray(body, end) };
    }
    // Chunks are word-aligned: odd sizes carry one pad byte.
    offset = body + size + (size % 2);
  }
  return null;
}

/** Duration in seconds from the real data length, or null when unreadable. */
export function wavDurationSec(buf: Buffer): number | null {
  const info = parseWav(buf);
  if (!info) return null;
  const bytesPerSec = info.sampleRate * info.channels * (info.bits / 8);
  if (!(bytesPerSec > 0)) return null;
  return info.data.length / bytesPerSec;
}

/** RMS (0..1) of s16le samples. 0 for empty input; a trailing odd byte is ignored. */
export function pcmRms(pcm: Buffer): number {
  const usable = pcm.length - (pcm.length % 2);
  if (usable <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < usable; i += 2) {
    const n = pcm.readInt16LE(i) / 32768;
    sum += n * n;
  }
  return Math.sqrt(sum / (usable / 2));
}
