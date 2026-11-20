// Remote transcription over an OpenAI-compatible /audio/transcriptions
// endpoint. OpenRouter takes base64 JSON (input_audio) instead of multipart.

import type { Logger, Transcriber } from "../types.ts";
import { errorMessage } from "../types.ts";
import { cleanTranscript } from "./filter.ts";
import { abortError, wavDurationSec } from "./long.ts";

export interface ApiTranscriberDeps {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realDeps: ApiTranscriberDeps = {
  fetch: (url, init) => fetch(url, init),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface ApiTranscriberOptions {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly logger?: Logger;
  readonly deps?: Partial<ApiTranscriberDeps>;
}

export function isOpenRouterEndpoint(endpoint: string): boolean {
  return /(^https?:\/\/)?([^/]+\.)?openrouter\.ai(\/|$)/i.test(endpoint);
}

export interface ApiRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: FormData | string;
}

/** Build the HTTP request for one transcription. Pure. */
export function buildApiRequest(
  endpoint: string,
  model: string,
  apiKey: string | undefined,
  wav: Buffer,
  language: string,
  prompt: string | undefined,
): ApiRequest {
  const url = `${endpoint.replace(/\/+$/, "")}/audio/transcriptions`;
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const lang = language === "auto" ? undefined : language;
  if (isOpenRouterEndpoint(endpoint)) {
    headers["Content-Type"] = "application/json";
    const payload: Record<string, unknown> = {
      model,
      input_audio: { data: wav.toString("base64"), format: "wav" },
    };
    if (lang) payload["language"] = lang;
    if (prompt) payload["prompt"] = prompt;
    return { url, headers, body: JSON.stringify(payload) };
  }
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
  form.append("model", model);
  form.append("response_format", "json");
  if (lang) form.append("language", lang);
  if (prompt) form.append("prompt", prompt);
  return { url, headers, body: form };
}

function errorDetail(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const err = parsed.error;
      if (typeof err === "string") return err;
      if (typeof err === "object" && err !== null && "message" in err) {
        if (typeof err.message === "string") return err.message;
      }
    }
  } catch {
    // not JSON
  }
  return "";
}

export function createApiTranscriber(opts: ApiTranscriberOptions): Transcriber {
  const deps: ApiTranscriberDeps = { ...realDeps, ...opts.deps };
  const log = (msg: string, level: "debug" | "warn" = "debug"): void =>
    opts.logger?.log("STT", msg, level);

  return {
    async transcribe(wav, o) {
      if (!opts.endpoint || !opts.model) {
        throw new Error("STT API not configured — set the STT API endpoint and model");
      }
      if (o.signal?.aborted) throw abortError();
      const req = buildApiRequest(
        opts.endpoint,
        opts.model,
        opts.apiKey,
        wav,
        o.language,
        o.prompt,
      );
      const budget = Math.max(60_000, 20_000 + Math.ceil(2 * wavDurationSec(wav) * 1000));
      const ctl = new AbortController();
      let timedOut = false;
      const timer = deps.setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, budget);
      const onAbort = (): void => ctl.abort();
      o.signal?.addEventListener("abort", onAbort, { once: true });
      log(`STT API request model=${opts.model} bytes=${wav.length}`);
      try {
        let resp: Response;
        try {
          resp = await deps.fetch(req.url, {
            method: "POST",
            headers: req.headers,
            body: req.body,
            signal: ctl.signal,
          });
        } catch (err) {
          if (o.signal?.aborted) throw abortError();
          if (timedOut) {
            throw new Error(
              `STT API timed out after ${Math.round(budget / 1000)}s — retry or check the endpoint`,
            );
          }
          throw new Error(
            `STT API request failed: ${errorMessage(err)} — check the endpoint and network`,
          );
        }
        if (!resp.ok) {
          const detail = errorDetail(await resp.text().catch(() => ""));
          log(`STT API status=${resp.status}`, "warn");
          throw new Error(
            `STT API error ${resp.status}${detail ? `: ${detail}` : ""} — check the API key and model`,
          );
        }
        let data: unknown;
        try {
          data = await resp.json();
        } catch {
          throw new Error("STT API returned invalid JSON — check the endpoint URL");
        }
        const text =
          typeof data === "object" &&
          data !== null &&
          "text" in data &&
          typeof data.text === "string"
            ? data.text
            : "";
        log(`STT API ok chars=${text.length}`);
        return cleanTranscript(text);
      } finally {
        deps.clearTimeout(timer);
        o.signal?.removeEventListener("abort", onAbort);
      }
    },
    async warm() {},
    describe() {
      return `api ${opts.model}`;
    },
    async dispose() {},
  };
}
