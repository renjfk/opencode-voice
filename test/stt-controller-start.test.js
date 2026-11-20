import { test } from "node:test";
import assert from "node:assert/strict";
import { createControllerMethods } from "../lib/stt/controller.js";

function ctxWith(startResult, { loopOk = true } = {}) {
  const calls = { loop: 0, busy: 0 };
  const ctx = {
    setConversationStreamingEnabled: () => {},
    setConversationStreamingFinalize: () => {},
    setSilenceAutoFinalize: () => {},
    startStreamingDictation: () => startResult,
    startLoopRecording: () => {
      calls.loop += 1;
      return loopOk;
    },
  };
  return { ctx, calls };
}

test("a refused async streaming start falls back to batch recording", async () => {
  const { ctx, calls } = ctxWith(Promise.resolve(false));
  const m = createControllerMethods(ctx);
  const r = m.startTurn({ streaming: true, source: "conversation" });
  assert.equal(r.ok, true);
  await new Promise((res) => setImmediate(res));
  assert.equal(calls.loop, 1, "mic must open via batch when streaming refused");
});

test("an accepted async streaming start does not also record batch", async () => {
  const { ctx, calls } = ctxWith(Promise.resolve(true));
  const m = createControllerMethods(ctx);
  m.startTurn({ streaming: true, source: "conversation" });
  await new Promise((res) => setImmediate(res));
  assert.equal(calls.loop, 0);
});

test("refused streaming plus busy batch reports busy", async () => {
  const { ctx } = ctxWith(Promise.resolve(false), { loopOk: false });
  let busy = 0;
  const m = createControllerMethods(ctx);
  m.startTurn({ streaming: true, onBusy: () => (busy += 1) });
  await new Promise((res) => setImmediate(res));
  assert.equal(busy, 1);
});
