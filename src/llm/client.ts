// OpenAI-compatible completion client (chat completions, or the Responses
// API when configured). Config is read per call so a /voice-model change or a
// session model switch applies to the next request.

import type { CompleteRequest, Llm, Logger } from "../types.ts";
import { errorMessage } from "../types.ts";
import type { LlmConfig } from "./config.ts";

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface LlmDeps {
  fetch?: FetchFn;
  logger?: Logger;
  /** Total budget per complete() call, retries included. */
  timeoutMs?: number;
  /** Delay before the single retry; resolves early when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_TOKENS = 2048;
const RETRY_DELAY_MS = 300;

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export function requestUrl(cfg: Pick<LlmConfig, "endpoint" | "useResponsesApi">): string {
  const base = cfg.endpoint.replace(/\/+$/, "");
  if (base.endsWith("/chat/completions") || base.endsWith("/responses")) return base;
  return `${base}/${cfg.useResponsesApi ? "responses" : "chat/completions"}`;
}

/** Drops reasoning blocks some models emit inline in the answer. */
export function stripThink(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // Template without an opening tag: "reasoning...</think>answer".
  const close = out.toLowerCase().lastIndexOf("</think>");
  if (close !== -1) out = out.slice(close + "</think>".length);
  // Unclosed (truncated) reasoning: nothing after it is the answer.
  const open = out.toLowerCase().indexOf("<think>");
  if (open !== -1) out = out.slice(0, open);
  return out.trim();
}

function partsText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean);
  return texts.length > 0 ? texts.join("") : undefined;
}

function chatText(data: unknown): string | undefined {
  if (!isRecord(data) || !Array.isArray(data.choices)) return undefined;
  const first: unknown = data.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return undefined;
  return partsText(first.message.content);
}

function responsesText(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text;
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (!isRecord(item) || item.type === "reasoning") continue;
      const text = partsText(item.content);
      if (text?.trim()) return text;
    }
  }
  // Some gateways answer /responses in chat shape.
  return chatText(data);
}

function timeoutError(ms: number): Error {
  const err = new Error(
    `Voice LLM timed out after ${Math.round(ms / 1000)}s; try again or pick a faster model with /voice-model`,
  );
  err.name = "TimeoutError";
  return err;
}

export function createLlm(getConfig: () => LlmConfig | null, deps: LlmDeps = {}): Llm {
  const doFetch: FetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const log = (message: string, level: "debug" | "warn" | "error" = "debug") =>
    deps.logger?.log("LLM", message, level);

  async function complete(req: CompleteRequest): Promise<string> {
    const cfg = getConfig();
    if (!cfg) {
      throw new Error(
        "Voice LLM is not configured; pick a model with /voice-model or set endpoint and model options",
      );
    }
    req.signal?.throwIfAborted();

    const url = requestUrl(cfg);
    const responses = url.endsWith("/responses");
    const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
    const body = responses
      ? {
          model: cfg.model,
          instructions: req.system,
          input: req.user,
          max_output_tokens: maxTokens,
        }
      : {
          model: cfg.model,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
        };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    // Session id goes only to the opencode.ai gateway, never to third parties.
    if (cfg.sendSessionHeader && req.sessionID) headers["x-opencode-session"] = req.sessionID;

    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const init: RequestInit = { method: "POST", headers, body: JSON.stringify(body), signal };
    const aborted = (): unknown => {
      if (req.signal?.aborted) return req.signal.reason;
      return timeoutError(timeoutMs);
    };

    log(
      `request model=${cfg.label} mode=${responses ? "responses" : "chat"} userChars=${req.user.length}`,
    );
    const started = Date.now();
    let data: unknown;
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) throw aborted();
      let res: Response;
      try {
        res = await doFetch(url, init);
      } catch (err) {
        if (signal.aborted) throw aborted();
        if (attempt === 1) {
          log(`network error, retrying once: ${errorMessage(err)}`, "warn");
          await sleep(RETRY_DELAY_MS, signal);
          continue;
        }
        throw new Error(
          `Voice LLM request failed: ${errorMessage(err)}; check the endpoint and your network`,
        );
      }
      if (res.status >= 500 && attempt === 1) {
        log(`status=${res.status}, retrying once`, "warn");
        await res.body?.cancel().catch(() => {});
        await sleep(RETRY_DELAY_MS, signal);
        continue;
      }
      if (!res.ok) {
        let detail = "";
        try {
          detail = (await res.text()).trim().replace(/\s+/g, " ").slice(0, 160);
        } catch {
          // body unreadable: status alone
        }
        log(`status=${res.status} bodyChars=${detail.length}`, "error");
        throw new Error(
          `Voice LLM request failed (${res.status})${detail ? `: ${detail}` : ""}; check the model and key`,
        );
      }
      try {
        data = await res.json();
      } catch (err) {
        if (signal.aborted) throw aborted();
        throw new Error(
          `Voice LLM returned invalid JSON (${errorMessage(err)}); check the endpoint`,
        );
      }
      break;
    }

    const raw = (responses ? responsesText(data) : chatText(data)) ?? "";
    const text = stripThink(raw);
    log(`done ms=${Date.now() - started} chars=${text.length} rawChars=${raw.length}`);
    if (!text) {
      // No retry: an empty answer is usually reasoning eating the token budget.
      throw new Error(
        "Voice LLM returned an empty reply; try again or pick another model with /voice-model",
      );
    }
    return text;
  }

  return {
    complete,
    describe: () => getConfig()?.label ?? "unconfigured",
    get configured() {
      return getConfig() !== null;
    },
  };
}
