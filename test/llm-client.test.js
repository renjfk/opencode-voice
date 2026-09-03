import assert from "node:assert/strict";
import test from "node:test";

import { createClient } from "../lib/llm-client.js";

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

test("reports isConfigured only when endpoint and model are both set", () => {
  assert.equal(createClient().isConfigured, false);
  assert.equal(createClient({ endpoint: "https://example.test/v1" }).isConfigured, false);
  assert.equal(createClient({ model: "test-model" }).isConfigured, false);
  assert.equal(
    createClient({ endpoint: "https://example.test/v1", model: "test-model" }).isConfigured,
    true,
  );
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
