import assert from "node:assert/strict";
import test from "node:test";

import { getRecentConversationContext } from "../lib/session.js";

function makeApi(messages, partsByMessage) {
  return {
    route: { current: { name: "session", params: { sessionID: "s1" } } },
    state: {
      session: { messages: () => messages },
      part: (messageID) => partsByMessage[messageID] || [],
    },
  };
}

const client = { session: { list: async () => ({ data: [] }) } };

test("formats recent turns newest-last with roles", async () => {
  const api = makeApi(
    [
      { id: "m1", role: "user" },
      { id: "m2", role: "assistant" },
    ],
    {
      m1: [{ type: "text", text: "Cristina is a guy" }],
      m2: [{ type: "text", text: "Got it, what about him?" }],
    },
  );
  const ctx = await getRecentConversationContext(client, api);
  assert.equal(ctx, "user: Cristina is a guy\nassistant: Got it, what about him?");
});

test("caps message count and total chars keeping the tail", async () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, role: "user" }));
  const parts = {};
  messages.forEach((m, i) => {
    parts[m.id] = [{ type: "text", text: `turn${i} ${"x".repeat(50)}` }];
  });
  const api = makeApi(messages, parts);
  const ctx = await getRecentConversationContext(client, api, { maxMessages: 3, maxChars: 100 });
  assert.ok(ctx.length <= 100);
  assert.match(ctx, /turn9/);
  assert.doesNotMatch(ctx, /turn0/);
});

test("falls back to message summaries when parts are empty", async () => {
  const api = makeApi([{ id: "m1", role: "user", summary: { title: "Auth work" } }], {});
  const ctx = await getRecentConversationContext(client, api);
  assert.equal(ctx, "user: Auth work");
});

test("returns empty string when context is unavailable", async () => {
  const empty = makeApi([], {});
  assert.equal(await getRecentConversationContext(client, empty), "");
  const broken = {
    route: { current: { name: "session", params: { sessionID: "s1" } } },
    state: {
      session: {
        messages: () => {
          throw new Error("boom");
        },
      },
    },
  };
  assert.equal(await getRecentConversationContext(client, broken), "");
  assert.equal(await getRecentConversationContext(client, null), "");
});
