import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  STREAMING_MODE_DEFAULTS,
  isStreamingActive,
  resolveSttAutoSubmit,
  resolveSttMode,
  resolveStreamTimings,
} from "../lib/stt.js";
import { acquireSharedWhisperServer } from "../lib/whisper-server.js";

function memKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    set: (key, value) => store.set(key, value),
  };
}

test("streaming mode defaults to batch, preserving current behavior", () => {
  assert.equal(resolveSttMode(undefined), "batch");
  assert.equal(resolveSttMode({}), "batch");
  assert.equal(resolveSttMode({ sttMode: "batch" }), "batch");
  assert.equal(resolveSttMode({ sttMode: "streaming" }), "streaming");
  assert.equal(resolveSttMode({ sttMode: "anything-else" }), "batch");
});

test("persisted kv mode wins over plugin options", () => {
  assert.equal(resolveSttMode({ sttMode: "streaming" }, memKv({ "stt.mode": "batch" })), "batch");
  assert.equal(resolveSttMode({}, memKv({ "stt.mode": "streaming" })), "streaming");
  assert.equal(resolveSttMode(undefined, memKv({ "stt.mode": "streaming" })), "streaming");
  assert.equal(resolveSttMode({}, memKv({ "stt.mode": "garbage" })), "batch");
  assert.equal(resolveSttMode({ sttMode: "streaming" }, memKv()), "streaming");
});

test("auto-submit resolves from kv first, options second, off by default", () => {
  assert.equal(resolveSttAutoSubmit(undefined), false);
  assert.equal(resolveSttAutoSubmit({}), false);
  assert.equal(resolveSttAutoSubmit({ sttAutoSubmit: true }), true);
  assert.equal(
    resolveSttAutoSubmit({ sttAutoSubmit: true }, memKv({ "stt.autoSubmit": false })),
    false,
  );
  assert.equal(resolveSttAutoSubmit({}, memKv({ "stt.autoSubmit": true })), true);
});

test("stream timing tunables have sane defaults and ignore garbage", () => {
  assert.deepEqual(resolveStreamTimings({}), STREAMING_MODE_DEFAULTS);
  assert.deepEqual(resolveStreamTimings(undefined), STREAMING_MODE_DEFAULTS);
  assert.deepEqual(resolveStreamTimings({ sttStreamWindowMs: 8000, sttStreamStepMs: 500 }), {
    windowMs: 8000,
    cadenceMs: 500,
  });
  assert.deepEqual(
    resolveStreamTimings({ sttStreamWindowMs: 0, sttStreamStepMs: -3 }),
    STREAMING_MODE_DEFAULTS,
  );
  assert.deepEqual(
    resolveStreamTimings({ sttStreamWindowMs: "nope", sttStreamStepMs: null }),
    STREAMING_MODE_DEFAULTS,
  );
});

test("no streaming session is active in a bare import (batch default)", () => {
  assert.equal(isStreamingActive(), false);
});

test("shared rendezvous unifies streaming and live-notes on one lease", () => {
  // Both consumers call acquireSharedWhisperServer with the same key scheme
  // (modelPath/language/host/port); identical specs MUST share one client so
  // they never double-spawn or collide on the port.
  const spec = { modelPath: "/m.bin", language: "en", port: 8090 };
  const a = acquireSharedWhisperServer(spec);
  const b = acquireSharedWhisperServer(spec);
  try {
    assert.equal(a.client, b.client);
    const other = acquireSharedWhisperServer({ ...spec, port: 8091 });
    try {
      assert.notEqual(a.client, other.client);
    } finally {
      other.release();
    }
  } finally {
    a.release();
    b.release();
  }
});

test("live-notes uses the shared rendezvous (no private client)", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "lib", "live-notes.js"),
    "utf-8",
  );
  assert.match(src, /acquireSharedWhisperServer/);
  assert.doesNotMatch(src, /createWhisperServerClient/);
  assert.match(src, /isStreamingActive/);
});

test("streaming finalize never falls through to primary-chat append", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "stt.js"), "utf-8");
  const finalizeIdx = src.indexOf("async function finalizeStreamingDictation");
  assert.ok(finalizeIdx >= 0);
  const finalizeSrc = src.slice(finalizeIdx, finalizeIdx + 12000);
  assert.match(finalizeSrc, /insertIntoFocusedInput/);
  assert.doesNotMatch(finalizeSrc, /appendPrompt/);
  assert.doesNotMatch(finalizeSrc, /submitPrompt/);
  // Submission only via the captured target's own submit().
  assert.match(finalizeSrc, /target\.submit/);
});

test("streaming finalize honors the owned range and targets the captured field", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "stt.js"), "utf-8");
  const finalizeIdx = src.indexOf("async function finalizeStreamingDictation");
  assert.ok(finalizeIdx >= 0);
  const finalizeSrc = src.slice(finalizeIdx, finalizeIdx + 12000);
  // editor.finalize already writes live-capable targets: its result decides
  // whether the single insert runs, otherwise every live dictation inserts
  // twice.
  assert.match(finalizeSrc, /editor\?\.finalize/);
  assert.match(finalizeSrc, /fin\?\.inserted/);
  // Fallback insert routes through the captured target, never the live focus.
  assert.match(finalizeSrc, /target\.insertText/);
  assert.doesNotMatch(finalizeSrc, /currentFocusedRenderable/);
});

test("streaming path performs no LLM normalization", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "stt.js"), "utf-8");
  const startIdx = src.indexOf("startStreamingDictation");
  assert.ok(startIdx >= 0);
  const block = src.slice(startIdx, startIdx + 12000);
  assert.doesNotMatch(block, /normalizeTranscription/);
  assert.doesNotMatch(block, /complete\(/);
});
