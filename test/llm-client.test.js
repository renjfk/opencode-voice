import assert from "node:assert/strict";
import test from "node:test";

import { createClient, resolveProviderConfig } from "../lib/llm-client.js";

function createJsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    },
  };
}

test("returns error when endpoint is not configured", async () => {
  const client = createClient({ model: "test-model" });
  const result = await client.complete({ prompt: "Test" });

  assert.deepEqual(result, {
    text: null,
    error: "LLM endpoint not configured",
  });
});

test("returns error when model is not configured", async () => {
  const client = createClient({ endpoint: "https://example.test/v1" });
  const result = await client.complete({ prompt: "Test" });

  assert.deepEqual(result, {
    text: null,
    error: "LLM model not configured",
  });
});

test("sends chat completions requests with reasoning_effort when configured", async () => {
  const previousKey = process.env.TEST_LLM_API_KEY;
  const previousFetch = globalThis.fetch;
  const requests = [];
  process.env.TEST_LLM_API_KEY = "secret";

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return createJsonResponse(200, {
      choices: [{ message: { content: "normalized text" } }],
    });
  };

  try {
    const client = createClient({
      endpoint: "https://example.test/v1/",
      model: "gpt-test",
      apiKeyEnv: "TEST_LLM_API_KEY",
      maxTokens: 321,
      reasoningEffort: "low",
      retries: 0,
    });

    const result = await client.complete({
      system: "System prompt",
      prompt: "User prompt",
    });

    assert.equal(result.text, "normalized text");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://example.test/v1/chat/completions");
    assert.equal(requests[0].options.method, "POST");
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      model: "gpt-test",
      max_tokens: 321,
      reasoning_effort: "low",
      messages: [
        { role: "system", content: "System prompt" },
        { role: "user", content: "User prompt" },
      ],
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) {
      delete process.env.TEST_LLM_API_KEY;
    } else {
      process.env.TEST_LLM_API_KEY = previousKey;
    }
  }
});

test("sends chat_template_kwargs when configured", async () => {
  const previousKey = process.env.TEST_LLM_API_KEY;
  const previousFetch = globalThis.fetch;
  const requests = [];
  process.env.TEST_LLM_API_KEY = "secret";

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return createJsonResponse(200, {
      choices: [{ message: { content: "text" } }],
    });
  };

  try {
    const client = createClient({
      endpoint: "https://example.test/v1",
      model: "qwen-test",
      apiKeyEnv: "TEST_LLM_API_KEY",
      chatTemplateKwargs: { enable_thinking: false },
      retries: 0,
    });

    const result = await client.complete({ prompt: "Test" });
    assert.equal(result.text, "text");
    const body = JSON.parse(requests[0].options.body);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.reasoning_effort, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) {
      delete process.env.TEST_LLM_API_KEY;
    } else {
      process.env.TEST_LLM_API_KEY = previousKey;
    }
  }
});

test("does not send chat_template_kwargs when not configured", async () => {
  const previousKey = process.env.TEST_LLM_API_KEY;
  const previousFetch = globalThis.fetch;
  const requests = [];
  process.env.TEST_LLM_API_KEY = "secret";

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return createJsonResponse(200, {
      choices: [{ message: { content: "text" } }],
    });
  };

  try {
    const client = createClient({
      endpoint: "https://example.test/v1",
      model: "test-model",
      apiKeyEnv: "TEST_LLM_API_KEY",
      retries: 0,
    });

    const result = await client.complete({ prompt: "Test" });
    assert.equal(result.text, "text");
    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.chat_template_kwargs, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) {
      delete process.env.TEST_LLM_API_KEY;
    } else {
      process.env.TEST_LLM_API_KEY = previousKey;
    }
  }
});

test("sends requests without Authorization header when no apiKeyEnv", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return createJsonResponse(200, {
      choices: [{ message: { content: "text" } }],
    });
  };

  try {
    const client = createClient({
      endpoint: "https://example.test/v1",
      model: "test-model",
      retries: 0,
    });

    const result = await client.complete({ prompt: "Test" });
    assert.equal(result.text, "text");
    assert.equal(requests[0].options.headers.Authorization, undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("returns error when LLM fails after retries", async () => {
  const previousKey = process.env.TEST_LLM_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  process.env.TEST_LLM_API_KEY = "secret";

  globalThis.fetch = async () => {
    return createJsonResponse(500, { error: "internal error" });
  };

  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };

  try {
    const client = createClient({
      endpoint: "https://example.test/v1",
      model: "test-model",
      apiKeyEnv: "TEST_LLM_API_KEY",
      retries: 1,
    });

    const result = await client.complete({ prompt: "Test" });

    assert.equal(result.text, null);
    assert.match(result.error, /LLM request failed/);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
    if (previousKey === undefined) {
      delete process.env.TEST_LLM_API_KEY;
    } else {
      process.env.TEST_LLM_API_KEY = previousKey;
    }
  }
});

test("retries transient failures and eventually returns the response text", async () => {
  const previousKey = process.env.TEST_LLM_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  let attempts = 0;
  process.env.TEST_LLM_API_KEY = "secret";

  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts < 3) {
      return createJsonResponse(429, { error: { message: "rate limited" } });
    }
    return createJsonResponse(200, {
      choices: [{ message: { content: "recovered text" } }],
    });
  };

  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };

  try {
    const client = createClient({
      endpoint: "https://example.test/v1",
      model: "test-model",
      apiKeyEnv: "TEST_LLM_API_KEY",
      retries: 2,
    });

    const result = await client.complete({ prompt: "Retry this" });

    assert.deepEqual(result, { text: "recovered text" });
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
    if (previousKey === undefined) {
      delete process.env.TEST_LLM_API_KEY;
    } else {
      process.env.TEST_LLM_API_KEY = previousKey;
    }
  }
});

test("sends x-opencode-session header from session resolver", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return createJsonResponse(200, { output_text: "normalized text" });
  };

  try {
    const client = createClient(
      {
        endpoint: "https://example.test/v1",
        model: "test-model",
        useResponsesApi: true,
        retries: 0,
      },
      undefined,
      () => "ses_test123",
    );

    const result = await client.complete({ prompt: "User prompt" });

    assert.equal(result.text, "normalized text");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://example.test/v1/responses");
    assert.equal(requests[0].options.headers["x-opencode-session"], "ses_test123");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("resolves voice-selected provider to endpoint config", () => {
  const provider = {
    id: "openrouter",
    name: "OpenRouter",
    env: ["OPENROUTER_API_KEY"],
    options: { baseURL: "https://openrouter.ai/api/v1" },
  };
  const model = { id: "openai/gpt-4o-mini", api: { url: "https://openrouter.ai/api/v1" } };
  assert.deepEqual(resolveProviderConfig(provider, model), {
    endpoint: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    apiKeyEnv: "OPENROUTER_API_KEY",
  });
  assert.equal(resolveProviderConfig(null, model), null);
});

test("prefers the upstream modelID when a v2 model carries both ids", () => {
  const provider = {
    id: "p1",
    env: ["P1_API_KEY"],
    // The v2 adapter maps ProviderInfo.settings into the v1 `options` shape.
    options: { baseURL: "https://p1.test/v1" },
  };
  const model = { id: "alias-id", modelID: "upstream-id", providerID: "p1" };
  assert.deepEqual(resolveProviderConfig(provider, model), {
    endpoint: "https://p1.test/v1",
    model: "upstream-id",
    apiKeyEnv: "P1_API_KEY",
  });
});

test("falls back to model api url when provider has no baseURL", () => {
  const provider = { id: "custom", env: [], options: {} };
  const model = { id: "m1", api: { url: "https://llm.test/v1" } };
  const resolved = resolveProviderConfig(provider, model);
  assert.equal(resolved.endpoint, "https://llm.test/v1");
  assert.equal(resolved.apiKeyEnv, null);
});

test("selects the exported env candidate instead of always envVars[0]", () => {
  const prevA = process.env.VOICE_TEST_KEY_A;
  const prevB = process.env.VOICE_TEST_KEY_B;
  delete process.env.VOICE_TEST_KEY_A;
  process.env.VOICE_TEST_KEY_B = "second-secret";
  try {
    const provider = {
      id: "p1",
      env: ["VOICE_TEST_KEY_A", "VOICE_TEST_KEY_B"],
      options: { baseURL: "https://llm.test/v1" },
    };
    const model = { id: "m1", api: { url: "https://llm.test/v1" } };
    // Only the second alt key is exported: requests must use it, otherwise
    // they go out unauthenticated.
    assert.equal(resolveProviderConfig(provider, model).apiKeyEnv, "VOICE_TEST_KEY_B");
    // First exported key still wins when present.
    process.env.VOICE_TEST_KEY_A = "first-secret";
    assert.equal(resolveProviderConfig(provider, model).apiKeyEnv, "VOICE_TEST_KEY_A");
    // Nothing exported: keep the first name for diagnostics.
    delete process.env.VOICE_TEST_KEY_A;
    delete process.env.VOICE_TEST_KEY_B;
    assert.equal(resolveProviderConfig(provider, model).apiKeyEnv, "VOICE_TEST_KEY_A");
  } finally {
    if (prevA === undefined) delete process.env.VOICE_TEST_KEY_A;
    else process.env.VOICE_TEST_KEY_A = prevA;
    if (prevB === undefined) delete process.env.VOICE_TEST_KEY_B;
    else process.env.VOICE_TEST_KEY_B = prevB;
  }
});

test("uses voice-selected provider when explicit options are missing", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.VOICE_TEST_KEY;
  const requests = [];
  process.env.VOICE_TEST_KEY = "secret";
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return createJsonResponse(200, {
      choices: [{ message: { content: "ok" } }],
    });
  };

  try {
    const provider = {
      id: "p1",
      env: ["VOICE_TEST_KEY"],
      options: { baseURL: "https://llm.test/v1" },
    };
    const model = { id: "fast-one", api: { url: "https://llm.test/v1" } };
    const client = createClient({}, null, null, () => ({ provider, model }));
    const result = await client.complete({ prompt: "hi" });
    assert.equal(result.text, "ok");
    assert.equal(requests[0].url, "https://llm.test/v1/chat/completions");
    assert.equal(JSON.parse(requests[0].options.body).model, "fast-one");
    assert.equal(requests[0].options.headers["Authorization"], "Bearer secret");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.VOICE_TEST_KEY;
    else process.env.VOICE_TEST_KEY = previousKey;
  }
});

test("explicit endpoint options win over voice-selected provider", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return createJsonResponse(200, {
      choices: [{ message: { content: "ok" } }],
    });
  };

  try {
    const provider = {
      id: "p1",
      env: [],
      options: { baseURL: "https://provider.test/v1" },
    };
    const model = { id: "provider-model", api: { url: "https://provider.test/v1" } };
    const client = createClient(
      { endpoint: "https://explicit.test/v1", model: "explicit-model", retries: 0 },
      null,
      null,
      () => ({ provider, model }),
    );
    const result = await client.complete({ prompt: "hi" });
    assert.equal(result.text, "ok");
    assert.equal(requests[0].url, "https://explicit.test/v1/chat/completions");
    assert.equal(JSON.parse(requests[0].options.body).model, "explicit-model");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("omits x-opencode-session header without session", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return createJsonResponse(200, {
      choices: [{ message: { content: "text" } }],
    });
  };

  try {
    const client = createClient({
      endpoint: "https://example.test/v1",
      model: "test-model",
      retries: 0,
    });

    const result = await client.complete({ prompt: "User prompt" });

    assert.equal(result.text, "text");
    assert.equal(requests.length, 1);
    assert.ok(!("x-opencode-session" in requests[0].options.headers));
  } finally {
    globalThis.fetch = previousFetch;
  }
});
