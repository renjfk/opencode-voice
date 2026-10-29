import assert from "node:assert/strict";
import test from "node:test";

import { getVoiceProviderSelection, resolveVoiceProviderModel } from "../lib/voice-model.js";

function makeKv(store = {}) {
  return {
    get: (key, fallback = null) => (key in store ? store[key] : fallback),
    set: (key, value) => {
      store[key] = value;
    },
  };
}

const api = {
  state: {
    provider: [
      {
        id: "p1",
        name: "Provider One",
        env: ["P1_KEY"],
        options: {},
        models: {
          m1: { id: "m1", name: "Model One", api: { url: "https://p1.test/v1" } },
        },
      },
    ],
  },
};

test("reads the voice provider selection from kv", () => {
  assert.deepEqual(getVoiceProviderSelection(makeKv({})), null);
  assert.deepEqual(
    getVoiceProviderSelection(makeKv({ "voice.providerID": "p1", "voice.modelID": "m1" })),
    { providerID: "p1", modelID: "m1" },
  );
});

test("resolves the selection against live providers", () => {
  const kv = makeKv({ "voice.providerID": "p1", "voice.modelID": "m1" });
  const resolved = resolveVoiceProviderModel(api, kv);
  assert.equal(resolved.provider.id, "p1");
  assert.equal(resolved.model.id, "m1");
});

test("returns null for stale selections", () => {
  assert.equal(
    resolveVoiceProviderModel(api, makeKv({ "voice.providerID": "nope", "voice.modelID": "m1" })),
    null,
  );
  assert.equal(
    resolveVoiceProviderModel(api, makeKv({ "voice.providerID": "p1", "voice.modelID": "nope" })),
    null,
  );
  assert.equal(resolveVoiceProviderModel(api, makeKv({})), null);
});
