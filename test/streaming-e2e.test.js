import assert from "node:assert/strict";
import test from "node:test";

import { __setStreamingActive, isStreamingActive, registerSTT } from "../lib/stt.js";

// End-to-end dictation flows through the REAL registerSTT streaming paths:
// real createStreamingController + real streaming-editor adapter, with only
// the mic/server faked (scripted capture/transcriber via the
// deps.streamingControllerOpts seam) and a faked renderer/kv/api.
// No mic, no TUI, no processes, no ports, no LLM. Deterministic.
//
// What this covers live: start→partials→finalize→insert-exactly-once,
// submit-path safety (submit only via captured target.submit(), never the
// primary-chat appendPrompt/submitPrompt), cancel ownership (only
// plugin-owned text removed), mutual exclusion (live-notes, conversation,
// double-start, batch-record while streaming), warm reuse + model-change
// teardown across dictations, and fallback-audio surfacing on server
// failure. NOT covered live (no mic/TUI on this machine): real SoX audio,
// real whisper-server inference (measured separately in benchmarks.json),
// and the real renderer (which exposes only insertText/submit, i.e. the
// fallback path faked here as the default target).

function wavMarker(text) {
  return Buffer.from(`WAV:${text}`);
}

function createManualClock() {
  let nextId = 1;
  const pending = new Map();
  return {
    pending,
    setTimeout(fn) {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    fireNext() {
      const [id, fn] = pending.entries().next().value || [];
      if (id === undefined) return false;
      pending.delete(id);
      fn();
      return true;
    },
  };
}

async function flushAsync(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

function createFakeCapture({ finalWav = wavMarker("final hello world") } = {}) {
  return {
    started: 0,
    snapshots: 0,
    stopFinalCalls: 0,
    cancelled: 0,
    disposed: 0,
    start() {
      this.started += 1;
    },
    snapshot() {
      this.snapshots += 1;
      return { wav: wavMarker("snap"), durationMs: 1000 };
    },
    async stopFinal() {
      this.stopFinalCalls += 1;
      return { wav: finalWav, durationMs: 2000 };
    },
    async cancel() {
      this.cancelled += 1;
    },
    async dispose() {
      this.disposed += 1;
    },
  };
}

// Script entries: { text } | { error, code }. readyResult for ensureReady.
function createFakeTranscriber(
  script = [],
  { readyResult = { ready: true }, creations = null } = {},
) {
  const tx = {
    transcribeCalls: 0,
    disposeCalls: 0,
    async ensureReady() {
      await Promise.resolve();
      return readyResult;
    },
    transcribe() {
      this.transcribeCalls += 1;
      const entry = tx.scriptCursor < script.length ? script[tx.scriptCursor++] : script.at(-1);
      if (!entry) return Promise.resolve({ text: "" });
      if (entry.error) return Promise.resolve({ error: entry.error, code: entry.code });
      return Promise.resolve({ text: entry.text });
    },
    dispose() {
      this.disposeCalls += 1;
    },
    describe: () => ({ modelPath: "/m.bin", language: "en" }),
    scriptCursor: 0,
  };
  if (creations) creations.count += 1;
  return tx;
}

function createFakeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: (k, dflt) => (store.has(k) ? store.get(k) : dflt),
    set: (k, v) => store.set(k, v),
  };
}

// Mirrors the REAL renderer: only insertText (+ optional submit). No
// getText/setRange, so the session takes the fallback path (preview toasts
// + single insert at finalize) exactly as in production.
function createFallbackFocused({ withSubmit = false } = {}) {
  return {
    inserted: [],
    submitted: 0,
    insertText(text) {
      this.inserted.push(text);
    },
    ...(withSubmit
      ? {
          submit() {
            this.submitted += 1;
          },
        }
      : {}),
  };
}

// Range-capable target: proves the live setRange path + cancel ownership.
function createRangeTarget(initialText = "note: ") {
  return {
    text: initialText,
    setRangeCalls: [],
    submitted: 0,
    getText() {
      return this.text;
    },
    setRange(start, end, text) {
      this.setRangeCalls.push({ start, end, text });
      this.text = this.text.slice(0, start) + text + this.text.slice(end);
    },
    insertText(text) {
      this.text += text;
    },
  };
}

function createHarness({
  opts = {},
  deps = {},
  script = [{ text: "hello" }, { text: "hello world" }],
  finalWav = wavMarker("final hello world"),
  readyResult = { ready: true },
  focused = null,
  creations = null,
} = {}) {
  const clock = createManualClock();
  const cap = createFakeCapture({ finalWav });
  const txHolder = { tx: null };
  const toasts = [];
  const disposeCallbacks = [];
  const api = {
    client: {
      tui: {
        appendPromptCalls: [],
        submitPromptCalls: 0,
        async appendPrompt(arg) {
          this.appendPromptCalls.push(arg);
          return {};
        },
        async submitPrompt() {
          this.submitPromptCalls += 1;
          return {};
        },
      },
    },
    renderer: { currentFocusedRenderable: focused },
    ui: {
      toast(input) {
        toasts.push(typeof input === "string" ? { message: input } : input);
      },
      dialog: { replace() {}, clear() {} },
    },
    lifecycle: {
      onDispose(fn) {
        disposeCallbacks.push(fn);
      },
    },
    route: { current: null },
  };
  const kv = createFakeKv();
  const reg = registerSTT(
    api,
    kv,
    async () => ({ text: "LLM MUST NOT RUN" }),
    null,
    {
      sttMode: "streaming",
      ...opts,
    },
    null,
    {
      // Neutralize the module-level live-notes/conversation hooks on every
      // registration: an earlier harness that simulated an active mode must
      // never leak its `() => true` guard into a later test.
      isLiveNotesActive: () => false,
      isConversationActive: () => false,
      onConversationKey: () => {},
      ...deps,
      streamingControllerOpts: {
        captureFactory: () => cap,
        transcriberFactory: () => {
          txHolder.tx = createFakeTranscriber(script, { readyResult, creations });
          return txHolder.tx;
        },
        clock,
        cadenceMs: 1000,
        stopDrainTimeoutMs: 20,
        ...deps.streamingControllerOpts,
      },
    },
  );
  return { clock, cap, txHolder, toasts, disposeCallbacks, api, kv, reg, creations };
}

async function startStreaming(h) {
  assert.equal(await h.reg.controller.startStreaming(), true);
  await flushAsync();
  assert.equal(isStreamingActive(), true);
}

async function cleanup(h) {
  try {
    if (isStreamingActive()) await h.reg.controller.cancelStreaming();
  } catch {}
  for (const fn of h.disposeCallbacks) {
    try {
      fn();
    } catch {}
  }
  __setStreamingActive(false);
  await flushAsync();
}

test("e2e: start→partials→finalize inserts exactly once, never via primary chat", async (t) => {
  const focused = createFallbackFocused();
  const h = createHarness({ focused });
  t.after(() => cleanup(h));
  await startStreaming(h);
  // Drive one scheduled tick so a partial preview is produced.
  h.clock.fireNext();
  await flushAsync();
  assert.ok(h.toasts.length >= 1, "expected at least a start/partial toast");
  const done = await h.reg.controller.finalizeStreaming({ submit: false });
  assert.ok((done.text || "").includes("hello"));
  assert.deepEqual(focused.inserted, [done.text]);
  assert.equal(h.api.client.tui.appendPromptCalls.length, 0);
  assert.equal(h.api.client.tui.submitPromptCalls, 0);
  assert.equal(isStreamingActive(), false);
  assert.ok(h.toasts.some((x) => /added/i.test(x.message || "")));
});

test("e2e: stt-record toggles finalize while streaming (command routing)", async (t) => {
  const focused = createFallbackFocused();
  const h = createHarness({ focused });
  t.after(() => cleanup(h));
  await startStreaming(h);
  const record = h.reg.commands.find((c) => c.value === "stt.record");
  assert.ok(record);
  record.onSelect(); // streaming + active → finalize
  await flushAsync(20);
  assert.equal(isStreamingActive(), false);
  assert.equal(focused.inserted.length, 1);
  assert.ok((focused.inserted[0] || "").includes("hello"));
  assert.equal(h.api.client.tui.appendPromptCalls.length, 0);
});

test("e2e: submit without target.submit() warns, keeps text, never touches primary chat", async (t) => {
  const focused = createFallbackFocused({ withSubmit: false });
  const h = createHarness({ focused });
  t.after(() => cleanup(h));
  await startStreaming(h);
  const done = await h.reg.controller.finalizeStreaming({ submit: true });
  assert.ok((done.text || "").includes("hello"));
  assert.deepEqual(focused.inserted, [done.text]);
  assert.equal(h.api.client.tui.appendPromptCalls.length, 0);
  assert.equal(h.api.client.tui.submitPromptCalls, 0);
  assert.ok(h.toasts.some((x) => /cannot submit/i.test(x.message || "")));
});

test("e2e: submit with target.submit() submits once via the captured target", async (t) => {
  const focused = createFallbackFocused({ withSubmit: true });
  const h = createHarness({ focused });
  t.after(() => cleanup(h));
  await startStreaming(h);
  const done = await h.reg.controller.finalizeStreaming({ submit: true });
  assert.ok((done.text || "").includes("hello"));
  assert.equal(focused.submitted, 1);
  assert.equal(h.api.client.tui.appendPromptCalls.length, 0);
  assert.equal(h.api.client.tui.submitPromptCalls, 0);
});

test("e2e: cancel on the live range path removes only dictated text", async (t) => {
  const target = createRangeTarget("note: ");
  const h = createHarness({
    focused: target,
    script: [{ text: "hello" }, { text: "hello world" }],
  });
  t.after(() => cleanup(h));
  await startStreaming(h);
  h.clock.fireNext();
  await flushAsync();
  assert.ok(target.setRangeCalls.length >= 1, "expected live setRange partials");
  assert.ok(target.text.startsWith("note: "));
  const ok = await h.reg.controller.cancelStreaming();
  assert.equal(ok, true);
  assert.equal(target.text, "note: ");
  assert.equal(isStreamingActive(), false);
  assert.ok(h.toasts.some((x) => /cancelled/i.test(x.message || "")));
});

test("e2e: mutual exclusion — live-notes, conversation, double-start, batch record", async (t) => {
  // Live-notes active refuses.
  {
    const h = createHarness({
      focused: createFallbackFocused(),
      deps: { isLiveNotesActive: () => true },
    });
    t.after(() => cleanup(h));
    assert.equal(await h.reg.controller.startStreaming(), false);
    assert.equal(isStreamingActive(), false);
    assert.ok(h.toasts.some((x) => /live notes/i.test(x.message || "")));
    await cleanup(h);
  }
  // Conversation active refuses.
  {
    const h = createHarness({
      focused: createFallbackFocused(),
      deps: { isConversationActive: () => true, onConversationKey: () => {} },
    });
    t.after(() => cleanup(h));
    assert.equal(await h.reg.controller.startStreaming(), false);
    assert.equal(isStreamingActive(), false);
    await cleanup(h);
  }
  // Double start + batch record while streaming.
  {
    const h = createHarness({ focused: createFallbackFocused() });
    t.after(() => cleanup(h));
    await startStreaming(h);
    assert.equal(await h.reg.controller.startStreaming(), false);
    assert.equal(h.reg.controller.start(), false);
    assert.equal(h.cap.started, 1);
    await h.reg.controller.cancelStreaming();
    assert.equal(isStreamingActive(), false);
  }
});

test("e2e: warm reuse across dictations, teardown on model change", async (t) => {
  const creations = { count: 0 };
  const h = createHarness({ focused: createFallbackFocused(), creations });
  t.after(() => cleanup(h));
  await startStreaming(h);
  assert.equal(creations.count, 1);
  const first = await h.reg.controller.finalizeStreaming({ submit: false });
  assert.ok((first.text || "").includes("hello"));
  // Same model: the parked warm lease is reused, no second server acquire.
  await startStreaming(h);
  assert.equal(creations.count, 1);
  await h.reg.controller.cancelStreaming();
  // Model change: next start tears down and reloads.
  h.kv.set("stt.model", "tiny");
  await startStreaming(h);
  assert.equal(creations.count, 2);
  await h.reg.controller.cancelStreaming();
});

test("e2e: server failure surfaces fallback audio, inserts nothing elsewhere", async (t) => {
  const focused = createFallbackFocused();
  const h = createHarness({
    focused,
    // Mid-stream transcribe failure (foreign server on the port): the
    // controller halts with an explicit error and keeps the t=0 audio.
    script: [{ error: "Port 8090 already answers", code: "PORT_IN_USE" }],
  });
  t.after(() => cleanup(h));
  await startStreaming(h);
  h.clock.fireNext();
  await flushAsync();
  // Session-level evidence of fallback audio: the error toast says the audio
  // was kept for a later batch run (controller-level getFallbackAudio buffer
  // is covered in test/streaming-stt.test.js).
  assert.ok(h.toasts.some((x) => /audio kept/i.test(x.message || "")));
  assert.ok(h.toasts.some((x) => /PORT_IN_USE|already answers/i.test(x.message || "")));
  const done = await h.reg.controller.finalizeStreaming({ submit: false });
  // Nothing tracked (no successful hypothesis) → explicit empty, never a
  // silent insert and never a redirect into primary chat.
  assert.equal(done?.text || "", "");
  assert.equal(focused.inserted.length, 0);
  assert.equal(h.api.client.tui.appendPromptCalls.length, 0);
  assert.equal(h.api.client.tui.submitPromptCalls, 0);
  assert.equal(isStreamingActive(), false);
});
