import assert from "node:assert/strict";
import test from "node:test";

import {
  chunkText,
  estimateDuration,
  recordBubble,
  getBubbles,
  clearBubbles,
  interBubblePauseMs,
  CONSTANTS,
} from "../lib/tts-chunker.js";

function makeKV(initial = {}) {
  const store = { ...initial };
  return {
    get(key, fallback) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : fallback;
    },
    set(key, value) {
      store[key] = value;
    },
    _store: store,
  };
}

test("chunkText returns empty array for empty input", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText(null), []);
  assert.deepEqual(chunkText(undefined), []);
});

test("chunkText returns single chunk for short text", () => {
  const chunks = chunkText("Hello world.");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], "Hello world.");
});

test("chunkText splits long text on sentence boundaries", () => {
  const text =
    "First sentence is short. Second sentence is also short. Third sentence wraps up the thought. Fourth sentence introduces a new idea.";
  const chunks = chunkText(text, 80);
  assert.ok(chunks.length >= 2, `expected at least 2 chunks, got ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.length <= CONSTANTS.MAX_TARGET_CHARS * 2, `chunk too long: ${c.length}`);
    assert.ok(c.trim().length > 0);
  }
});

test("chunkText respects paragraph breaks", () => {
  const text = "Paragraph one is here.\n\nParagraph two is also here.";
  const chunks = chunkText(text);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], "Paragraph one is here.");
  assert.equal(chunks[1], "Paragraph two is also here.");
});

test("chunkText keeps punctuation attached to its sentence", () => {
  const text = "Hello world. How are you? I am fine! Thanks for asking.";
  const chunks = chunkText(text, 80);
  assert.ok(chunks.length >= 1);
  for (const c of chunks) {
    assert.ok(/[.!?]$/.test(c.trim()), `chunk should end with terminal punctuation: ${c}`);
  }
});

test("chunkText splits on line breaks when no sentence is available", () => {
  const text =
    "alpha beta gamma delta\nepsilon zeta eta theta\niota kappa lambda mu\nnu xi omicron pi";
  const chunks = chunkText(text, 80);
  assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(!c.includes("\n"), `chunk should not contain raw newlines: ${c}`);
  }
});

test("chunkText clamps absurd target values to a sensible default", () => {
  const long = "a".repeat(1000);
  const chunksTiny = chunkText(long, 1);
  assert.ok(chunksTiny.length > 1, "tiny target is clamped up, still multiple chunks");

  const chunksHuge = chunkText(long, 100000);
  // 100000 is clamped down to MAX_TARGET_CHARS so 1000 chars -> ~5 chunks.
  assert.ok(
    chunksHuge.length >= 3 && chunksHuge.length <= 10,
    `huge target clamped to max, got ${chunksHuge.length} chunks`,
  );
  for (const c of chunksHuge) {
    assert.ok(c.length <= CONSTANTS.MAX_TARGET_CHARS * 2);
  }
});

test("estimateDuration is roughly chars / 14 seconds, min 1", () => {
  assert.equal(estimateDuration(""), 0);
  assert.equal(estimateDuration("hi"), 1); // 2/14 < 1 -> floor at 1
  assert.equal(estimateDuration("a".repeat(140)), 10);
  assert.equal(estimateDuration("a".repeat(280)), 20);
});

test("recordBubble persists in kv and respects the cap", () => {
  const kv = makeKV();
  for (let i = 0; i < CONSTANTS.MAX_BUBBLES + 5; i++) {
    recordBubble(kv, { text: `bubble ${i}`, sessionID: "s1" });
  }
  const stored = kv.get("tts.bubbles", []);
  assert.equal(stored.length, CONSTANTS.MAX_BUBBLES);
  assert.equal(stored[stored.length - 1].text, `bubble ${CONSTANTS.MAX_BUBBLES + 4}`);
  assert.equal(stored[0].text, `bubble 5`);
});

test("getBubbles returns reverse-chronological by default", () => {
  const kv = makeKV();
  recordBubble(kv, { text: "old" });
  recordBubble(kv, { text: "newer" });
  recordBubble(kv, { text: "newest" });
  const result = getBubbles(kv);
  assert.deepEqual(
    result.map((b) => b.text),
    ["newest", "newer", "old"],
  );
});

test("getBubbles honours limit and reverse=false", () => {
  const kv = makeKV();
  recordBubble(kv, { text: "a" });
  recordBubble(kv, { text: "b" });
  recordBubble(kv, { text: "c" });
  const recent = getBubbles(kv, { limit: 2 });
  assert.equal(recent.length, 2);
  assert.equal(recent[0].text, "c");

  const oldest = getBubbles(kv, { limit: 2, reverse: false });
  assert.equal(oldest[0].text, "a");
});

test("clearBubbles empties the history", () => {
  const kv = makeKV();
  recordBubble(kv, { text: "x" });
  assert.equal(getBubbles(kv).length, 1);
  clearBubbles(kv);
  assert.equal(getBubbles(kv).length, 0);
});

test("interBubblePauseMs returns a positive integer", () => {
  const ms = interBubblePauseMs();
  assert.ok(Number.isInteger(ms) && ms > 0 && ms < 5000);
});
