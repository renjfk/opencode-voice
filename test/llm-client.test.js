import assert from "node:assert/strict";
import test from "node:test";

import { createClient } from "../lib/llm-client.js";

function createKv(entries = {}) {
  return {
    get(key) {
      return entries[key];
    },
  };
}

function createJsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    },
  };
}

test("returns an error when the configured API key is missing", async () => {
  const previousKey = process.env.TEST_LLM_API_KEY;
  delete process.env.TEST_LLM_API_KEY;

  try {
    const client = createClient(createKv(), { apiKeyEnv: "TEST_LLM_API_KEY" });
    const result = await client.complete({ prompt: "Normalize this" });

    assert.deepEqual(result, {
      text: null,
      error: "TEST_LLM_API_KEY not set",
    });
  } finally {
    if (previousKey === undefined) {
      delete process.env.TEST_LLM_API_KEY;
    } else {
      process.env.TEST_LLM_API_KEY = previousKey;
    }
  }
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
    const client = createClient(createKv(), {
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
    const client = createClient(createKv(), {
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
