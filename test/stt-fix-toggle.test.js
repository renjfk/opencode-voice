import test from "node:test";
import assert from "node:assert/strict";
import { createCommands } from "../lib/stt/commands.js";
import {
  __setLastInsertedTextForTests,
  beginCorrection,
  isCorrecting,
  clearCorrection,
  runCorrectionMerge,
} from "../lib/stt.js";
import { quickActionSegments } from "../lib/shared/quick-actions-status.js";

function fixCtx(overrides = {}) {
  const toasts = [];
  const calls = [];
  return {
    toasts,
    calls,
    ctx: {
      kb: () => null,
      sttApiEndpoint: null,
      autoSubmit: false,
      currentSttMode: () => "batch",
      conversationActive: () => false,
      conversationHooks: {},
      getStreamingActive: () => false,
      streamController: () => null,
      liveNotesActive: () => false,
      recording: () => false,
      processing: () => false,
      isCorrecting: () => isCorrecting(),
      clearCorrection: (r) => clearCorrection(r),
      beginCorrection: (extra) => beginCorrection(extra),
      startLoopRecording: () => {
        calls.push("start");
        return true;
      },
      doTranscribePipeline: () => void calls.push("finish"),
      clearRecordingToast: () => {},
      kv: { get: () => null, set: () => {} },
      complete: async () => ({}),
      client: {},
      api: { ui: { dialog: {}, toast: () => {} } },
      toast: (m) => toasts.push(typeof m === "string" ? m : (m?.message ?? String(m))),
      systemPrompt: "",
      logger: null,
      renderer: null,
      ...overrides,
    },
  };
}

test("first Fix click arms correction and starts recording", () => {
  __setLastInsertedTextForTests("hello world");
  const { ctx, calls } = fixCtx({
    renderer: { currentFocusedRenderable: { getText: () => "hello world" } },
  });
  createCommands(ctx)
    .find((c) => c.value === "stt.correct")
    .onSelect();
  assert.deepEqual(calls, ["start"]);
  assert.equal(isCorrecting(), true);
  clearCorrection("test");
  __setLastInsertedTextForTests(null);
});

test("second Fix click finishes the same recording, no busy warning", () => {
  __setLastInsertedTextForTests("hello world");
  let rec = false;
  const { ctx, calls, toasts } = fixCtx({
    recording: () => rec,
    renderer: { currentFocusedRenderable: { getText: () => "hello world" } },
  });
  const cmd = createCommands(ctx).find((c) => c.value === "stt.correct");
  cmd.onSelect();
  assert.deepEqual(calls, ["start"]);
  rec = true;
  calls.length = 0;
  cmd.onSelect();
  assert.deepEqual(calls, ["finish"]);
  assert.ok(!toasts.some((t) => /busy|finish the current/i.test(t)));
  clearCorrection("test");
  __setLastInsertedTextForTests(null);
});

test("plain recording keeps the finish-first warning", () => {
  const { ctx, toasts } = fixCtx({ recording: () => true });
  __setLastInsertedTextForTests(null);
  createCommands(ctx)
    .find((c) => c.value === "stt.correct")
    .onSelect();
  assert.ok(toasts.some((t) => /finish the current turn/i.test(t)));
});

test("clearCorrection releases ownership", () => {
  __setLastInsertedTextForTests("hello world");
  const r = beginCorrection({
    toast: () => {},
    renderer: { currentFocusedRenderable: { getText: () => "hello world" } },
  });
  assert.equal(r.ok, true);
  assert.equal(isCorrecting(), true);
  clearCorrection("test");
  assert.equal(isCorrecting(), false);
  __setLastInsertedTextForTests(null);
});

test("failed merge keeps original once, no retry loop", async () => {
  __setLastInsertedTextForTests("hello world");
  beginCorrection({
    toast: () => {},
    renderer: { currentFocusedRenderable: { getText: () => "hello world" } },
  });
  const res = await runCorrectionMerge({
    kv: { get: () => null, set: () => {} },
    complete: async () => ({ text: null, error: "nope" }),
    client: {},
    api: {},
    toast: () => {},
    systemPrompt: "",
    logger: null,
    renderer: { currentFocusedRenderable: { getText: () => "hello world" } },
    text: "mumble",
  });
  assert.equal(res.kept, true);
  assert.equal(res.retry, undefined);
  assert.equal(isCorrecting(), false);
  __setLastInsertedTextForTests(null);
});

test("composer identity change blocks the replace", async () => {
  __setLastInsertedTextForTests("hello world");
  const focusedA = { getText: () => "hello world" };
  beginCorrection({
    toast: () => {},
    renderer: { currentFocusedRenderable: focusedA },
  });
  const res = await runCorrectionMerge({
    kv: { get: () => null, set: () => {} },
    complete: async () => ({ text: "hello world fixed" }),
    client: {},
    api: {},
    toast: () => {},
    systemPrompt: "",
    logger: null,
    renderer: { currentFocusedRenderable: { getText: () => "something else" } },
    text: "fix it",
  });
  assert.equal(res.kept, true);
  assert.equal(isCorrecting(), false);
  __setLastInsertedTextForTests(null);
});

test("same composer identity replaces in place", async () => {
  __setLastInsertedTextForTests("hello world");
  let current = "hello world";
  const focused = {
    getText: () => current,
    setText: (t) => void (current = t),
  };
  beginCorrection({ toast: () => {}, renderer: { currentFocusedRenderable: focused } });
  const res = await runCorrectionMerge({
    kv: { get: () => null, set: () => {} },
    complete: async () => ({ text: "hello world fixed" }),
    client: {},
    api: {},
    toast: () => {},
    systemPrompt: "",
    logger: null,
    renderer: { currentFocusedRenderable: focused },
    text: "fix it",
  });
  assert.equal(res.replaced, true);
  assert.equal(current, "hello world fixed");
  assert.equal(isCorrecting(), false);
  __setLastInsertedTextForTests(null);
});

test("Fix button shows Stop while correction records", () => {
  const idle = quickActionSegments({}).find((s) => s.key === "correct");
  assert.equal(idle.text, "[ ✎  Fix  ]");
  const active = quickActionSegments({ correcting: true }).find((s) => s.key === "correct");
  assert.equal(active.text, "[ ■  Stop  ]");
  assert.equal(active.fg, "#f87171");
});

test("Fix self-heals a correction left armed by a failed mic start", () => {
  __setLastInsertedTextForTests("hello world");
  const renderer = { currentFocusedRenderable: { getText: () => "hello world" } };
  let ok = false;
  const { ctx, calls, toasts } = fixCtx({
    renderer,
    startLoopRecording: () => {
      calls.push("start");
      return ok;
    },
  });
  const fix = createCommands(ctx).find((c) => c.value === "stt.correct");
  fix.onSelect(); // mic fails
  assert.equal(isCorrecting(), false, "failed start must not leave correction armed");
  assert.ok(toasts.some((t) => /Could not start the mic/.test(t)));
  ok = true;
  fix.onSelect();
  assert.deepEqual(calls, ["start", "start"]);
  assert.equal(isCorrecting(), true);
  clearCorrection("test");
  __setLastInsertedTextForTests(null);
});
