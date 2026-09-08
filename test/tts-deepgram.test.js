import assert from "node:assert/strict";
import test from "node:test";

import {
  speakWithDeepgram,
  DEEPGRAM_DEFAULTS,
  ENCODING_BY_CONTAINER,
} from "../lib/tts-deepgram.js";

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetchOk(audioBytes) {
  globalThis.fetch = async (url, options) => {
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          if (name.toLowerCase() === "content-type") return "audio/mpeg";
          return null;
        },
      },
      async arrayBuffer() {
        return new Uint8Array(audioBytes).buffer;
      },
    };
  };
}

function mockFetchError(status, body) {
  globalThis.fetch = async () => ({
    ok: false,
    status,
    statusText: "Bad Request",
    async text() {
      return body;
    },
  });
}

function restoreFetch() {
  globalThis.fetch = ORIGINAL_FETCH;
}

test.afterEach(() => {
  restoreFetch();
});

test("ENCODING_BY_CONTAINER maps user-friendly names to Deepgram encodings", () => {
  assert.equal(ENCODING_BY_CONTAINER.wav, "linear16");
  assert.equal(ENCODING_BY_CONTAINER.mp3, "mp3");
  assert.equal(ENCODING_BY_CONTAINER.ogg, "opus");
});

test("DEEPGRAM_DEFAULTS uses aura-2-thalia-en + mp3 + DEEPGRAM_API_KEY", () => {
  assert.equal(DEEPGRAM_DEFAULTS.model, "aura-2-thalia-en");
  assert.equal(DEEPGRAM_DEFAULTS.container, "mp3");
  assert.equal(DEEPGRAM_DEFAULTS.apiKeyEnv, "DEEPGRAM_API_KEY");
});

test("speakWithDeepgram rejects empty text without hitting the API", async () => {
  const result = await speakWithDeepgram({ text: "", apiKey: "x" });
  assert.deepEqual(result, { ok: false, reason: "empty" });
});

test("speakWithDeepgram throws when API key is missing", async () => {
  await assert.rejects(
    () => speakWithDeepgram({ text: "hello", apiKey: null }),
    /Deepgram API key not configured/,
  );
});

test("speakWithDeepgram surfaces non-2xx as a descriptive error", async () => {
  mockFetchError(401, "Unauthorized");
  await assert.rejects(
    () =>
      speakWithDeepgram({
        text: "hello",
        apiKey: "fake",
        model: "aura-2-thalia-en",
        container: "mp3",
        // Skip playback so we don't need ffmpeg/sox installed in the test env.
        // (speak() invokes playPcmWithSox which would crash on missing sox.)
        // The synth layer fails first with our 401, so this is safe.
      }),
    /Deepgram 401/,
  );
});

test("speakWithDeepgram POSTs to the right URL with auth header", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      headers: {
        get: () => "audio/mpeg",
      },
      async arrayBuffer() {
        return new Uint8Array(8).buffer;
      },
    };
  };

  // Don't actually decode or play — just intercept at fetch so we never
  // shell out to ffmpeg/sox in the test env.
  // We patch synthRaw by reaching through the module would be too invasive;
  // instead we accept the throw from pcmStreamFromContainer when ffmpeg is
  // missing and just assert the request shape.
  try {
    await speakWithDeepgram({
      text: "hello",
      apiKey: "secret-key",
      model: "aura-2-thalia-en",
      container: "mp3",
    });
  } catch {
    // ffmpeg/sox likely missing in CI; we only care about the fetch call.
  }

  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.match(url, /https:\/\/api\.deepgram\.com\/v1\/speak/);
  assert.match(url, /model=aura-2-thalia-en/);
  assert.match(url, /encoding=mp3/);
  assert.equal(options.method, "POST");
  assert.equal(options.headers.Authorization, "Token secret-key");
  assert.equal(options.headers["Content-Type"], "application/json");
  const body = JSON.parse(options.body);
  assert.equal(body.text, "hello");
});
