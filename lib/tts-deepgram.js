// Deepgram Aura 2 text-to-speech backend.
//
// Drop-in replacement for the Piper/sox pipeline in tts.js. We hit
// https://api.deepgram.com/v1/speak with a JSON body, receive a single
// audio file (mp3 by default), decode it through ffmpeg into raw PCM at
// the same format Piper produces, then pipe it to `play` (sox).
//
// Why decode through ffmpeg instead of just `play` on the mp3? Two reasons:
//   1. ffmpeg is the one dep that is already a hard requirement for the
//      opencode-voice dependency graph in VegaCore / Visor / Makima, so we
//      don't introduce a new tool.
//   2. The existing Piper->play pipeline speaks raw PCM; reusing that
//      audio path keeps the user's volume / sink choice consistent.
//
// Configuration (passed through plugin options in tui.json):
//   "ttsEngine": "deepgram",
//   "deepgramApiKeyEnv": "DEEPGRAM_API_KEY",
//   "deepgramModel": "aura-2-thalia-en",        // or aura-2-celeste-es, etc.
//   "deepgramContainer": "mp3"                  // mp3 | wav | ogg
//
// We deliberately do NOT store the API key on disk. The plugin reads it
// from process.env at call time so it can be rotated without rebuilding
// the plugin.

import fs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const DEFAULT_MODEL = "aura-2-thalia-en";
const DEFAULT_CONTAINER = "mp3";
const DEFAULT_KEY_ENV = "DEEPGRAM_API_KEY";
const DEEPGRAM_SPEAK_URL = "https://api.deepgram.com/v1/speak";

const ENCODING_BY_CONTAINER = {
  wav: "linear16",
  mp3: "mp3",
  ogg: "opus",
  flac: "flac",
  aac: "aac",
};

// Same rate / bit depth / channels Piper uses, so the rest of the
// audio path doesn't have to know which backend produced the bytes.
const PCM_RATE = 22050;
const PCM_BITS = 16;
const PCM_CHANNELS = 1;

function which(bin) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, bin);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function ffmpegOnPath() {
  return Boolean(which("ffmpeg"));
}

/**
 * POST text to Deepgram's /v1/speak and return the response body as a
 * Buffer along with the content-type reported by the server. Throws with
 * a descriptive message on non-2xx so the caller can surface a toast.
 */
async function synthRaw({ text, model, container, apiKey, signal, logger }) {
  const url = new URL(DEEPGRAM_SPEAK_URL);
  url.searchParams.set("model", model);
  // Deepgram's encoding param is the only thing that controls the file
  // format when the response is a single audio file: linear16, mulaw,
  // alaw, mp3, opus, flac, aac. We map the user-friendly `container`
  // option onto the matching encoding and skip the `container` query
  // param (it only applies when streaming a chunked response).
  const encoding = ENCODING_BY_CONTAINER[container] || "mp3";
  url.searchParams.set("encoding", encoding);

  const body = JSON.stringify({ text });
  logger?.log?.("TTS-Deepgram", `POST ${url} model=${model} chars=${text.length}`, "debug");

  const accept =
    container === "wav" ? "audio/wav" : container === "ogg" ? "audio/ogg" : "audio/mpeg";

  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
      Accept: accept,
    },
    body,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Deepgram ${res.status}: ${errText.slice(0, 200).trim() || res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("Deepgram returned empty audio body");
  return { buffer: buf, contentType: res.headers.get("content-type") || "" };
}

/**
 * Decode an arbitrary container (mp3 / wav / ogg) into raw PCM using
 * ffmpeg, returning a Readable stream of raw PCM bytes at the Piper
 * rate / bit depth / channels. Resolves only when ffmpeg has flushed
 * the entire input.
 */
function pcmStreamFromContainer(buffer, container, ffmpegPath, logger) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let stderr = "";
    const proc = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-f",
        "s16le",
        "-ar",
        String(PCM_RATE),
        "-ac",
        String(PCM_CHANNELS),
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    proc.stdout.on("data", (chunk) => chunks.push(chunk));
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
    proc.on("close", (code) => {
      if (code !== 0) {
        logger?.log?.(
          "TTS-Deepgram",
          `ffmpeg exited code=${code} stderr=${stderr.trim()}`,
          "error",
        );
        reject(new Error(`ffmpeg exited code=${code}: ${stderr.trim().slice(0, 200)}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    proc.stdin.on("error", (err) => {
      if (err.code === "EPIPE") return;
      reject(err);
    });
    proc.stdin.end(buffer);
  });
}

function playPcmWithSox(buffer, logger) {
  return new Promise((resolve) => {
    let stderr = "";
    const proc = spawn(
      "play",
      [
        "-t",
        "raw",
        "-r",
        String(PCM_RATE),
        "-e",
        "signed",
        "-b",
        String(PCM_BITS),
        "-c",
        String(PCM_CHANNELS),
        "-q",
        "-",
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      logger?.log?.("TTS-Deepgram", `play spawn failed: ${err.message}`, "error");
      resolve();
    });
    proc.on("close", (code) => {
      if (code !== 0 && code !== null) {
        logger?.log?.("TTS-Deepgram", `play exited code=${code} stderr=${stderr.trim()}`, "error");
      } else {
        logger?.log?.("TTS-Deepgram", "playback finished", "debug");
      }
      resolve();
    });
    proc.stdin.on("error", (err) => {
      if (err.code === "EPIPE") return;
    });
    proc.stdin.end(buffer);
  });
}

/**
 * Speak `text` through Deepgram Aura 2 + ffmpeg + sox `play`.
 *
 * Resolves with an object describing the call (so the caller can log
 * timing and persist the bubble). Rejects on missing key, network error
 * or ffmpeg failure. The caller is expected to wrap in try/catch and
 * surface a toast on failure.
 */
export async function speakWithDeepgram({ text, apiKey, model, container, logger, signal }) {
  if (!text) {
    return { ok: false, reason: "empty" };
  }
  if (!apiKey) {
    throw new Error(
      'Deepgram API key not configured. Set ttsEngine: "deepgram" in plugin options and DEEPGRAM_API_KEY in the environment.',
    );
  }
  if (!ffmpegOnPath()) {
    throw new Error(
      'ffmpeg not found on PATH. Install it (apt: ffmpeg, brew: ffmpeg, nix: nix-shell -p ffmpeg) or switch ttsEngine back to "piper".',
    );
  }

  const startedAt = Date.now();
  const { buffer } = await synthRaw({
    text,
    apiKey,
    model: model || DEFAULT_MODEL,
    container: container || DEFAULT_CONTAINER,
    signal,
    logger,
  });
  const synthMs = Date.now() - startedAt;
  logger?.log?.("TTS-Deepgram", `Synthesized bytes=${buffer.length} synthMs=${synthMs}`, "debug");

  const ffmpegPath = which("ffmpeg");
  const pcm = await pcmStreamFromContainer(
    buffer,
    container || DEFAULT_CONTAINER,
    ffmpegPath,
    logger,
  );
  const decodeMs = Date.now() - startedAt - synthMs;
  logger?.log?.("TTS-Deepgram", `Decoded to PCM bytes=${pcm.length} decodeMs=${decodeMs}`, "debug");

  await playPcmWithSox(pcm, logger);
  return { ok: true, bytes: buffer.length, pcmBytes: pcm.length, synthMs, decodeMs };
}

export const DEEPGRAM_DEFAULTS = {
  model: DEFAULT_MODEL,
  container: DEFAULT_CONTAINER,
  apiKeyEnv: DEFAULT_KEY_ENV,
};

export { ENCODING_BY_CONTAINER };
