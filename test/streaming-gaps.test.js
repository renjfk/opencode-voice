import assert from "node:assert/strict";
import test from "node:test";

import {
  __clearStreamingToastState,
  __setStreamingToastFn,
  clearStreamingToast,
  isStreamingToastActive,
  noteStreamingPartial,
  showStreamingToast,
  updateStreamingToast,
} from "../lib/stt.js";
import { __setStreamingActive, isStreamingActive, registerSTT } from "../lib/stt.js";

// ---- Unit: sticky streaming status helpers (polling-toast pattern) ----

test("streaming sticky shows state + elapsed and clears", () => {
  const seen = [];
  __setStreamingToastFn((input) => seen.push(input));
  try {
    showStreamingToast("Loading speech model…");
    assert.equal(isStreamingToastActive(), true);
    assert.equal(seen.length, 1);
    assert.match(seen[0].message, /Loading speech model… · \d\d:\d\d/);
    // Privacy-safe: state words + elapsed only, never paths/secrets.
    assert.doesNotMatch(seen[0].message, /\.wav|\.bin|tmp|sk-/i);

    updateStreamingToast("● Streaming dictation — listening");
    assert.equal(isStreamingToastActive(), true);
    assert.match(seen.at(-1).message, /listening · \d\d:\d\d/);

    updateStreamingToast("Finalizing…");
    assert.match(seen.at(-1).message, /Finalizing… · \d\d:\d\d/);

    clearStreamingToast();
    assert.equal(isStreamingToastActive(), false);
  } finally {
    __clearStreamingToastState();
  }
});

test("streaming sticky slow-tick note appears only after ~2x cadence without partials", () => {
  const seen = [];
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  __setStreamingToastFn((input) => seen.push(input));
  try {
    showStreamingToast("● Streaming dictation — listening", { slowAfterMs: 2000 });
    assert.doesNotMatch(seen.at(-1).message, /listening…/);
    // A fresh partial resets the slow clock: still no note after 1s.
    noteStreamingPartial();
    now += 1000;
    updateStreamingToast("● Streaming dictation — listening");
    assert.doesNotMatch(seen.at(-1).message, /\(listening…\)/);
    // 2.5s without a partial: the slow-tick note appears.
    now += 1500;
    updateStreamingToast("● Streaming dictation — listening");
    assert.match(seen.at(-1).message, /\(listening…\)/);
  } finally {
    Date.now = realNow;
    __clearStreamingToastState();
  }
});

// ---- E2E: never-silent status across the real registerSTT streaming path ----

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
    async stopFinal() {
      return { wav: finalWav, durationMs: 2000 };
    },
    async cancel() {},
    async dispose() {},
    start() {
      this.started += 1;
    },
    snapshot() {
      return { wav: wavMarker("snap"), durationMs: 1000 };
    },
  };
}

function createFakeTranscriber(script = [], { readyResult = { ready: true } } = {}) {
  const tx = {
    scriptCursor: 0,
    async ensureReady() {
      await Promise.resolve();
      return readyResult;
    },
    transcribe() {
      const entry = tx.scriptCursor < script.length ? script[tx.scriptCursor++] : script.at(-1);
      if (!entry) return Promise.resolve({ text: "" });
      if (entry.error) return Promise.resolve({ error: entry.error, code: entry.code });
      return Promise.resolve({ text: entry.text });
    },
    dispose() {},
    describe: () => ({ modelPath: "/m.bin", language: "en" }),
  };
  return tx;
}

function createFakeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: (k, dflt) => (store.has(k) ? store.get(k) : dflt),
    set: (k, v) => store.set(k, v),
  };
}

function createFallbackFocused() {
  return {
    inserted: [],
    insertText(text) {
      this.inserted.push(text);
    },
  };
}

function createHarness({
  script = [{ text: "hello" }, { text: "hello world" }],
  finalWav = wavMarker("final hello world"),
  readyResult = { ready: true },
  focused = createFallbackFocused(),
} = {}) {
  const clock = createManualClock();
  const cap = createFakeCapture({ finalWav });
  const txHolder = { tx: null };
  const toasts = [];
  const disposeCallbacks = [];
  const api = {
    client: {
      tui: {
        async appendPrompt() {
          return {};
        },
        async submitPrompt() {},
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
  const reg = registerSTT(
    api,
    createFakeKv(),
    async () => ({ text: "LLM MUST NOT RUN" }),
    null,
    {
      sttMode: "streaming",
    },
    null,
    {
      isLiveNotesActive: () => false,
      isConversationActive: () => false,
      onConversationKey: () => {},
      streamingControllerOpts: {
        captureFactory: () => cap,
        transcriberFactory: () => {
          txHolder.tx = createFakeTranscriber(script, { readyResult });
          return txHolder.tx;
        },
        clock,
        cadenceMs: 1000,
        stopDrainTimeoutMs: 20,
      },
    },
  );
  return { clock, cap, toasts, disposeCallbacks, reg, focused };
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
  __clearStreamingToastState();
  await flushAsync();
}

const messages = (h) => h.toasts.map((x) => x.message || "");

test("sticky status covers loading → live → finalizing → cleared on finalize", async (t) => {
  const h = createHarness({});
  t.after(() => cleanup(h));
  assert.equal(await h.reg.controller.startStreaming(), true);
  await flushAsync();
  assert.equal(isStreamingActive(), true);
  // Cold-load state is visible immediately (never a silent gap).
  assert.ok(
    messages(h).some((m) => /Loading speech model/.test(m)),
    "loading toast",
  );
  // Live capture state once the server is ready, with elapsed timer.
  assert.ok(
    messages(h).some((m) => /listening · \d\d:\d\d/.test(m)),
    "live toast",
  );
  assert.equal(isStreamingToastActive(), true);
  // A partial preview still arrives alongside (not instead of) the sticky.
  h.clock.fireNext();
  await flushAsync();
  assert.ok(
    messages(h).some((m) => m.startsWith("🎙")),
    "partial preview toast",
  );
  assert.equal(isStreamingToastActive(), true);
  // Finalize: the wait for the stop-tail shows Finalizing…, then clears.
  const p = h.reg.controller.finalizeStreaming({ submit: false });
  assert.ok(
    messages(h).some((m) => /Finalizing…/.test(m)),
    "finalizing toast",
  );
  assert.equal(isStreamingToastActive(), true);
  const done = await p;
  assert.ok((done.text || "").includes("hello"));
  assert.deepEqual(h.focused.inserted, [done.text]);
  assert.equal(isStreamingToastActive(), false);
  assert.ok(messages(h).some((m) => /added/i.test(m)));
});

test("sticky status clears on cancel", async (t) => {
  const h = createHarness({});
  t.after(() => cleanup(h));
  assert.equal(await h.reg.controller.startStreaming(), true);
  await flushAsync();
  assert.equal(isStreamingToastActive(), true);
  assert.equal(await h.reg.controller.cancelStreaming(), true);
  assert.equal(isStreamingToastActive(), false);
  assert.ok(messages(h).some((m) => /cancelled/i.test(m)));
});

test("sticky status clears on error, error names the cause", async (t) => {
  const h = createHarness({
    readyResult: { ready: false, error: { code: "PORT_IN_USE", message: "owned by another" } },
  });
  t.after(() => cleanup(h));
  assert.equal(await h.reg.controller.startStreaming(), true);
  await flushAsync();
  // Loading was visible even though startup failed; the sticky is cleared
  // and the terminal error names the cause with the audio-kept note.
  assert.ok(
    messages(h).some((m) => /Loading speech model/.test(m)),
    "loading toast",
  );
  assert.equal(isStreamingToastActive(), false);
  assert.ok(
    messages(h).some((m) => /audio kept/i.test(m)),
    "audio-kept error toast",
  );
  assert.ok(
    messages(h).some((m) => /PORT_IN_USE|owned by another/i.test(m)),
    "cause toast",
  );
});
