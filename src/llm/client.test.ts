import { describe, expect, test } from "bun:test";
import { isAbortError } from "../types.ts";
import { createLlm, requestUrl, stripThink, type FetchFn } from "./client.ts";
import type { LlmConfig } from "./config.ts";

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const chat = (content: unknown) => json(200, { choices: [{ message: { content } }] });

function mockFetch(responses: Array<Response | Error | "hang">) {
  const calls: Call[] = [];
  const fetch: FetchFn = (url, init) => {
    calls.push({
      url,
      init,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      headers: init.headers as Record<string, string>,
    });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected fetch");
    if (next === "hang") {
      return new Promise((_, reject) => {
        const signal = init.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  };
  return { fetch, calls };
}

const base: LlmConfig = {
  endpoint: "https://llm.test/v1",
  model: "m1",
  apiKey: "secret",
  sendSessionHeader: false,
  label: "llm.test/m1",
};

const noSleep = () => Promise.resolve();
const req = { system: "SYS", user: "hello" };

describe("request shape", () => {
  test("chat completions body, auth header, trimmed text", async () => {
    const { fetch, calls } = mockFetch([chat("  Hi there.  ")]);
    const llm = createLlm(() => base, { fetch });
    expect(await llm.complete({ ...req, maxTokens: 100 })).toBe("Hi there.");
    expect(calls[0]?.url).toBe("https://llm.test/v1/chat/completions");
    expect(calls[0]?.body).toEqual({
      model: "m1",
      max_tokens: 100,
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "hello" },
      ],
    });
    expect(calls[0]?.headers.Authorization).toBe("Bearer secret");
  });

  test("no Authorization header without a key", async () => {
    const { fetch, calls } = mockFetch([chat("ok")]);
    const { apiKey: _drop, ...noKey } = base;
    await createLlm(() => noKey, { fetch }).complete(req);
    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });

  test("responses API shape and output parsing", async () => {
    const { fetch, calls } = mockFetch([
      json(200, {
        output: [
          { type: "reasoning", content: [{ type: "text", text: "thinking" }] },
          { type: "message", content: [{ type: "output_text", text: "Answer." }] },
        ],
      }),
    ]);
    const llm = createLlm(() => ({ ...base, useResponsesApi: true }), { fetch });
    expect(await llm.complete({ ...req, maxTokens: 64 })).toBe("Answer.");
    expect(calls[0]?.url).toBe("https://llm.test/v1/responses");
    expect(calls[0]?.body).toEqual({
      model: "m1",
      instructions: "SYS",
      input: "hello",
      max_output_tokens: 64,
    });
  });

  test("responses output_text shortcut", async () => {
    const { fetch } = mockFetch([json(200, { output_text: "Short." })]);
    const llm = createLlm(() => ({ ...base, endpoint: "https://llm.test/v1/responses" }), {
      fetch,
    });
    expect(await llm.complete(req)).toBe("Short.");
  });

  test("chat content as parts array", async () => {
    const { fetch } = mockFetch([
      chat([
        { type: "text", text: "A" },
        { type: "text", text: "B" },
      ]),
    ]);
    expect(await createLlm(() => base, { fetch }).complete(req)).toBe("AB");
  });

  test("requestUrl keeps full paths", () => {
    expect(requestUrl({ endpoint: "https://x/v1/" })).toBe("https://x/v1/chat/completions");
    expect(requestUrl({ endpoint: "https://x/v1/chat/completions" })).toBe(
      "https://x/v1/chat/completions",
    );
    expect(requestUrl({ endpoint: "https://x/v1/responses" })).toBe("https://x/v1/responses");
    expect(requestUrl({ endpoint: "https://x/v1", useResponsesApi: true })).toBe(
      "https://x/v1/responses",
    );
  });
});

describe("session header", () => {
  test("sent when config allows it (opencode.ai)", async () => {
    const { fetch, calls } = mockFetch([chat("ok")]);
    const llm = createLlm(() => ({ ...base, sendSessionHeader: true }), { fetch });
    await llm.complete({ ...req, sessionID: "ses_1" });
    expect(calls[0]?.headers["x-opencode-session"]).toBe("ses_1");
  });

  test("never sent to other endpoints", async () => {
    const { fetch, calls } = mockFetch([chat("ok")]);
    await createLlm(() => base, { fetch }).complete({ ...req, sessionID: "ses_1" });
    expect(calls[0]?.headers["x-opencode-session"]).toBeUndefined();
  });
});

describe("think stripping", () => {
  test("strips think blocks from the answer", async () => {
    const { fetch } = mockFetch([chat("<think>step 1\nstep 2</think>\nFinal.")]);
    expect(await createLlm(() => base, { fetch }).complete(req)).toBe("Final.");
  });

  test("stripThink variants", () => {
    expect(stripThink("a <THINK>x</THINK> b")).toBe("a  b");
    expect(stripThink("reasoning without open</think>Answer")).toBe("Answer");
    expect(stripThink("Answer<think>truncated reasoning")).toBe("Answer");
    expect(stripThink("<think>only reasoning")).toBe("");
  });

  test("reply that is only reasoning counts as empty", async () => {
    const { fetch, calls } = mockFetch([chat("<think>hmm</think>")]);
    await expect(createLlm(() => base, { fetch }).complete(req)).rejects.toThrow(/empty reply/);
    expect(calls.length).toBe(1);
  });
});

describe("retries and errors", () => {
  test("no retry on empty response", async () => {
    const { fetch, calls } = mockFetch([chat(""), chat("late")]);
    await expect(createLlm(() => base, { fetch, sleep: noSleep }).complete(req)).rejects.toThrow(
      /empty reply/,
    );
    expect(calls.length).toBe(1);
  });

  test("one retry on 503 then success", async () => {
    const { fetch, calls } = mockFetch([json(503, { error: "busy" }), chat("ok")]);
    expect(await createLlm(() => base, { fetch, sleep: noSleep }).complete(req)).toBe("ok");
    expect(calls.length).toBe(2);
  });

  test("only one retry: second 503 fails", async () => {
    const { fetch, calls } = mockFetch([json(503, {}), json(502, { error: "down" }), chat("x")]);
    await expect(createLlm(() => base, { fetch, sleep: noSleep }).complete(req)).rejects.toThrow(
      /\(502\)/,
    );
    expect(calls.length).toBe(2);
  });

  test("one retry on network error", async () => {
    const { fetch, calls } = mockFetch([new TypeError("fetch failed"), chat("ok")]);
    expect(await createLlm(() => base, { fetch, sleep: noSleep }).complete(req)).toBe("ok");
    expect(calls.length).toBe(2);
  });

  test("two network errors fail with a one-line message", async () => {
    const { fetch } = mockFetch([new TypeError("fetch failed"), new TypeError("fetch failed")]);
    await expect(createLlm(() => base, { fetch, sleep: noSleep }).complete(req)).rejects.toThrow(
      /request failed: fetch failed; check the endpoint/,
    );
  });

  test("4xx fails immediately with server detail", async () => {
    const { fetch, calls } = mockFetch([json(400, { error: "bad model" }), chat("x")]);
    await expect(createLlm(() => base, { fetch, sleep: noSleep }).complete(req)).rejects.toThrow(
      /\(400\): \{"error":"bad model"\}/,
    );
    expect(calls.length).toBe(1);
  });

  test("429 is not retried", async () => {
    const { fetch, calls } = mockFetch([json(429, {}), chat("x")]);
    await expect(createLlm(() => base, { fetch, sleep: noSleep }).complete(req)).rejects.toThrow(
      /\(429\)/,
    );
    expect(calls.length).toBe(1);
  });

  test("invalid JSON body", async () => {
    const { fetch } = mockFetch([new Response("not json", { status: 200 })]);
    await expect(createLlm(() => base, { fetch }).complete(req)).rejects.toThrow(/invalid JSON/);
  });

  test("unconfigured throws and describes itself", async () => {
    const llm = createLlm(() => null, { fetch: mockFetch([]).fetch });
    expect(llm.configured).toBe(false);
    expect(llm.describe()).toBe("unconfigured");
    await expect(llm.complete(req)).rejects.toThrow(/not configured.*\/voice-model/);
  });

  test("config is read per call", async () => {
    let cfg: LlmConfig | null = null;
    const { fetch, calls } = mockFetch([chat("a"), chat("b")]);
    const llm = createLlm(() => cfg, { fetch });
    expect(llm.configured).toBe(false);
    cfg = base;
    expect(llm.configured).toBe(true);
    expect(llm.describe()).toBe("llm.test/m1");
    await llm.complete(req);
    cfg = { ...base, model: "m2", endpoint: "https://other.test/v1" };
    await llm.complete(req);
    expect(calls[1]?.url).toBe("https://other.test/v1/chat/completions");
    expect(calls[1]?.body.model).toBe("m2");
  });
});

describe("timeout and abort", () => {
  test("times out with a TimeoutError", async () => {
    const { fetch } = mockFetch(["hang"]);
    const err: unknown = await createLlm(() => base, { fetch, timeoutMs: 20 })
      .complete(req)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("TimeoutError");
    expect((err as Error).message).toMatch(/timed out/);
    expect(isAbortError(err)).toBe(true);
  });

  test("caller abort rejects with the caller's reason, no retry", async () => {
    const { fetch, calls } = mockFetch(["hang", chat("x")]);
    const ctrl = new AbortController();
    const p = createLlm(() => base, { fetch, sleep: noSleep }).complete({
      ...req,
      signal: ctrl.signal,
    });
    ctrl.abort();
    const err: unknown = await p.catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
    expect((err as Error).name).toBe("AbortError");
    expect(calls.length).toBe(1);
  });

  test("already-aborted signal never fetches", async () => {
    const { fetch, calls } = mockFetch([chat("x")]);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      createLlm(() => base, { fetch }).complete({ ...req, signal: ctrl.signal }),
    ).rejects.toThrow();
    expect(calls.length).toBe(0);
  });

  test("passes a combined signal to fetch", async () => {
    const { fetch, calls } = mockFetch([chat("ok")]);
    const ctrl = new AbortController();
    await createLlm(() => base, { fetch }).complete({ ...req, signal: ctrl.signal });
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.init.signal).not.toBe(ctrl.signal);
  });
});
