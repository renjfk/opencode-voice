import { test } from "node:test";
import assert from "node:assert/strict";

import { createNormalizer } from "../lib/normalize.js";

function withFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function captureRequest() {
  const captured = { body: null, url: null };
  const handler = async (url, opts) => {
    captured.url = url;
    captured.body = JSON.parse(opts.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
    });
  };
  return { captured, handler };
}

test("normalize: disabled -> no llama al LLM y devuelve 'normalization disabled'", async () => {
  let called = 0;
  await withFetch(
    async () => {
      called++;
      return new Response("{}", { status: 200 });
    },
    async () => {
      const { complete, enabled } = createNormalizer({
        normalize: false,
        endpoint: "http://x/v1",
        model: "m",
      });
      assert.equal(enabled, false);
      const res = await complete({ prompt: "hola" });
      assert.equal(res.text, null);
      assert.equal(res.error, "normalization disabled");
      assert.equal(called, 0);
    },
  );
});

test("normalize: normalizeModel override se usa en el request", async () => {
  const { captured, handler } = captureRequest();
  await withFetch(handler, async () => {
    const { complete } = createNormalizer({
      endpoint: "http://x/v1",
      model: "base",
      normalizeModel: "norm-model",
    });
    const res = await complete({ prompt: "hola" });
    assert.equal(res.text, "ok");
    assert.equal(captured.body.model, "norm-model");
  });
});

test("normalize: default usa model si no hay normalizeModel", async () => {
  const { captured, handler } = captureRequest();
  await withFetch(handler, async () => {
    const { complete } = createNormalizer({ endpoint: "http://x/v1", model: "base" });
    await complete({ prompt: "hola" });
    assert.equal(captured.body.model, "base");
  });
});

test("normalize: normalizeEndpoint override apunta a otro endpoint", async () => {
  const { captured, handler } = captureRequest();
  await withFetch(handler, async () => {
    const { complete } = createNormalizer({
      endpoint: "http://main/v1",
      model: "base",
      normalizeEndpoint: "http://cheap/v1",
    });
    await complete({ prompt: "hola" });
    assert.equal(captured.url, "http://cheap/v1/chat/completions");
  });
});
