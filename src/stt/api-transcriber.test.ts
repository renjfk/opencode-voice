import { describe, expect, test } from "bun:test";
import { isAbortError } from "../types.ts";
import {
  type ApiTranscriberDeps,
  buildApiRequest,
  createApiTranscriber,
  isOpenRouterEndpoint,
} from "./api-transcriber.ts";
import { pcmToWav } from "./long.ts";

const wav = pcmToWav(Buffer.alloc(16000 * 2), 16000);

function deps(respond: (url: string, init: RequestInit | undefined) => Promise<Response>): {
  d: Partial<ApiTranscriberDeps>;
  calls: Array<{ url: string; init?: RequestInit }>;
  timers: Array<() => void>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const timers: Array<() => void> = [];
  return {
    calls,
    timers,
    d: {
      fetch: (url, init) => {
        calls.push(init ? { url, init } : { url });
        return respond(url, init);
      },
      setTimeout: (cb) => {
        timers.push(cb);
        return timers.length;
      },
      clearTimeout: () => {},
    },
  };
}

describe("isOpenRouterEndpoint", () => {
  test("detects openrouter hosts only", () => {
    expect(isOpenRouterEndpoint("https://openrouter.ai/api/v1")).toBe(true);
    expect(isOpenRouterEndpoint("https://api.openai.com/v1")).toBe(false);
    expect(isOpenRouterEndpoint("http://localhost:8000/v1")).toBe(false);
  });
});

describe("buildApiRequest", () => {
  test("OpenAI-compatible multipart", () => {
    const r = buildApiRequest("https://api.openai.com/v1/", "whisper-1", "sk-x", wav, "vi", "hint");
    expect(r.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(r.headers).toEqual({ Authorization: "Bearer sk-x" });
    if (!(r.body instanceof FormData)) throw new Error("expected form");
    expect(r.body.get("model")).toBe("whisper-1");
    expect(r.body.get("response_format")).toBe("json");
    expect(r.body.get("language")).toBe("vi");
    expect(r.body.get("prompt")).toBe("hint");
    expect(r.body.get("file")).toBeInstanceOf(Blob);
  });

  test("auto language and no key omit those fields", () => {
    const r = buildApiRequest("http://localhost:8000/v1", "m", undefined, wav, "auto", undefined);
    expect(r.headers).toEqual({});
    if (!(r.body instanceof FormData)) throw new Error("expected form");
    expect(r.body.get("language")).toBeNull();
    expect(r.body.get("prompt")).toBeNull();
  });

  test("OpenRouter base64 JSON", () => {
    const r = buildApiRequest(
      "https://openrouter.ai/api/v1",
      "openai/whisper-1",
      "k",
      wav,
      "en",
      undefined,
    );
    expect(r.url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(r.headers).toEqual({ Authorization: "Bearer k", "Content-Type": "application/json" });
    expect(typeof r.body).toBe("string");
    expect(JSON.parse(String(r.body))).toEqual({
      model: "openai/whisper-1",
      input_audio: { data: wav.toString("base64"), format: "wav" },
      language: "en",
    });
  });
});

describe("createApiTranscriber", () => {
  test("posts and returns cleaned text", async () => {
    const h = deps(async () => Response.json({ text: " hello [BLANK_AUDIO] " }));
    const t = createApiTranscriber({
      endpoint: "https://x/v1",
      model: "m",
      apiKey: "k",
      deps: h.d,
    });
    expect(await t.transcribe(wav, { language: "en" })).toBe("hello");
    expect(h.calls[0]?.url).toBe("https://x/v1/audio/transcriptions");
    expect(h.calls[0]?.init?.method).toBe("POST");
    expect(t.describe()).toBe("api m");
    await t.warm();
    await t.dispose();
  });

  test("not configured", async () => {
    const h = deps(async () => Response.json({}));
    const t = createApiTranscriber({ endpoint: "", model: "", deps: h.d });
    await expect(t.transcribe(wav, { language: "en" })).rejects.toThrow("STT API not configured");
    expect(h.calls).toHaveLength(0);
  });

  test("HTTP error surfaces provider message", async () => {
    const h = deps(async () => Response.json({ error: { message: "bad key" } }, { status: 401 }));
    const t = createApiTranscriber({ endpoint: "https://x/v1", model: "m", deps: h.d });
    await expect(t.transcribe(wav, { language: "en" })).rejects.toThrow(
      "STT API error 401: bad key — check the API key and model",
    );
  });

  test("HTTP error without JSON body", async () => {
    const h = deps(async () => new Response("gateway down", { status: 502 }));
    const t = createApiTranscriber({ endpoint: "https://x/v1", model: "m", deps: h.d });
    await expect(t.transcribe(wav, { language: "en" })).rejects.toThrow("STT API error 502 —");
  });

  test("invalid JSON", async () => {
    const h = deps(async () => new Response("<html>", { status: 200 }));
    const t = createApiTranscriber({ endpoint: "https://x/v1", model: "m", deps: h.d });
    await expect(t.transcribe(wav, { language: "en" })).rejects.toThrow("invalid JSON");
  });

  test("network failure", async () => {
    const h = deps(async () => {
      throw new Error("ENOTFOUND");
    });
    const t = createApiTranscriber({ endpoint: "https://x/v1", model: "m", deps: h.d });
    await expect(t.transcribe(wav, { language: "en" })).rejects.toThrow(
      "STT API request failed: ENOTFOUND",
    );
  });

  test("abort", async () => {
    const h = deps(
      (_u, init) =>
        new Promise((_r, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const t = createApiTranscriber({ endpoint: "https://x/v1", model: "m", deps: h.d });
    const ctl = new AbortController();
    const p = t.transcribe(wav, { language: "en", signal: ctl.signal });
    ctl.abort();
    expect(isAbortError(await p.catch((e: unknown) => e))).toBe(true);
  });

  test("timeout", async () => {
    const h = deps(
      (_u, init) =>
        new Promise((_r, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const t = createApiTranscriber({ endpoint: "https://x/v1", model: "m", deps: h.d });
    const p = t.transcribe(wav, { language: "en" });
    h.timers.at(-1)?.();
    await expect(p).rejects.toThrow("STT API timed out after 60s");
  });
});
