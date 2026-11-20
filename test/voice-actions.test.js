import test from "node:test";
import assert from "node:assert/strict";

test("auto-submit uses configured fallback, then honors explicit false", () => {
  const values = new Map();
  const kv = { get: (key) => values.get(key), set: (key, value) => values.set(key, value) };
  const actions = createVoiceActions({ kv, options: { sttAutoSubmit: true } });
  assert.equal(actions.isAutoSubmit(), true);
  assert.equal(actions.toggleAutoSubmit(), false);
  assert.equal(actions.isAutoSubmit(), false);
  assert.equal(actions.toggleAutoSubmit(), true);
});
import { createVoiceActions } from "../lib/voice/voice-actions.js";

function makeCtx() {
  const toasts = [];
  const api = { ui: { toast: (t) => toasts.push(t) } };
  const kv = { get: () => undefined, set: () => {} };
  return { api, kv, toasts };
}

function makeStt() {
  const calls = [];
  return {
    isRecording: () => false,
    isProcessing: () => false,
    isStreaming: () => false,
    cancel: () => calls.push("cancel"),
    cancelStreaming: async () => calls.push("cancelStreaming"),
    _calls: calls,
  };
}

function makeTts() {
  const calls = [];
  return {
    isSpeaking: () => false,
    stop: () => calls.push("stop"),
    pause: () => true,
    resume: () => true,
    getState: () => ({ status: "idle" }),
    _calls: calls,
  };
}

test("mode() reports conversation when active", () => {
  const { api, kv, toasts } = makeCtx();
  const conv = {
    isActive: () => true,
    getPhase: () => "paused",
    onKey: () => {},
    onTtsStop: () => false,
    stop: () => {},
  };
  const actions = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: conv,
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: {},
  });
  assert.equal(actions.mode(), "conversation");
});

test("mode() reports notes when live notes active", () => {
  const { api, kv } = makeCtx();
  const conv = { isActive: () => false };
  const notes = { isActive: () => true };
  const actions = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: conv,
    liveNotes: notes,
    kv,
    api,
    cmds: {},
  });
  assert.equal(actions.mode(), "notes");
});

test("mode() reports idle otherwise", () => {
  const { api, kv } = makeCtx();
  const actions = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: { isActive: () => false },
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: {},
  });
  assert.equal(actions.mode(), "idle");
});

test("toggleSpeak in idle calls recordCmd", () => {
  const { api, kv } = makeCtx();
  const calls = [];
  const actions = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: { isActive: () => false },
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: { recordCmd: () => calls.push("record") },
  });
  actions.toggleSpeak();
  assert.deepEqual(calls, ["record"]);
});

test("toggleSpeak in conversation delegates to onKey(record)", () => {
  const { api, kv } = makeCtx();
  const calls = [];
  const conv = { isActive: () => true, onKey: (s) => calls.push(s) };
  const actions = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: conv,
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: {},
  });
  actions.toggleSpeak();
  assert.deepEqual(calls, ["record"]);
});

test("toggleSpeak in notes toasts stop-notes", () => {
  const { api, kv, toasts } = makeCtx();
  const actions = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: { isActive: () => false },
    liveNotes: { isActive: () => true },
    kv,
    api,
    cmds: {},
  });
  actions.toggleSpeak();
  assert.ok(toasts.some((t) => /stop live notes/i.test(t.message)));
});

test("speakReply in conversation paused calls speakLastCmd", () => {
  const { api, kv } = makeCtx();
  const calls = [];
  const conv = { isActive: () => true, getPhase: () => "paused" };
  const actions = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: conv,
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: { speakLastCmd: () => calls.push("speakLast") },
  });
  actions.speakReply();
  assert.deepEqual(calls, ["speakLast"]);
});

test("speakReply in conversation speaking toasts agent-holds-floor", () => {
  const { api, kv, toasts } = makeCtx();
  const conv = { isActive: () => true, getPhase: () => "speaking" };
  const actions = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: conv,
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: {},
  });
  actions.speakReply();
  assert.ok(toasts.some((t) => /agent holds the floor/i.test(t.message)));
});

test("speakReply in conversation recording toasts mic-is-yours", () => {
  const { api, kv, toasts } = makeCtx();
  const conv = { isActive: () => true, getPhase: () => "recording" };
  const actions = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: conv,
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: {},
  });
  actions.speakReply();
  assert.ok(toasts.some((t) => /mic is yours/i.test(t.message)));
});

test("speakReply in idle calls speakLastCmd", () => {
  const { api, kv } = makeCtx();
  const calls = [];
  const actions = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: { isActive: () => false },
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: { speakLastCmd: () => calls.push("speakLast") },
  });
  actions.speakReply();
  assert.deepEqual(calls, ["speakLast"]);
});

test("stopAll cancels TTS and conversation when active", async () => {
  const { api, kv, toasts } = makeCtx();
  const tts = makeTts();
  tts.isSpeaking = () => true;
  const conv = { isActive: () => true, stop: () => {} };
  const actions = createVoiceActions({
    stt: makeStt(),
    tts,
    conversation: conv,
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: {},
  });
  const cancelled = await actions.stopAll();
  assert.ok(cancelled.includes("TTS"));
  assert.ok(cancelled.includes("conversation"));
  assert.ok(toasts.some((t) => /Cancelled/.test(t.message)));
});

test("getPhase is exposed on conversation controller", () => {
  // Smoke: the controller shape check is covered by conversation tests;
  // here we just assert the dispatcher reads it.
  const { api, kv } = makeCtx();
  const conv = { isActive: () => true, getPhase: () => "paused" };
  const actions = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: conv,
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: {},
  });
  // speakReply paused path requires getPhase
  const calls = [];
  const a2 = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: conv,
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: { speakLastCmd: () => calls.push("x") },
  });
  a2.speakReply();
  assert.deepEqual(calls, ["x"]);
});

test("toggleAutoSubmit flips the stt.autoSubmit kv the reader checks", async () => {
  const store = new Map();
  const toasts = [];
  const api = { ui: { toast: (t) => toasts.push(t) } };
  const kv = {
    get: (k, fb) => (store.has(k) ? store.get(k) : fb),
    set: (k, v) => void store.set(k, v),
  };
  const { toggleAutoSubmit, isAutoSubmit } = createVoiceActions({ kv, api });
  assert.equal(isAutoSubmit(), false);
  toggleAutoSubmit();
  assert.equal(store.get("stt.autoSubmit"), true);
  // Writer and reader must agree on the key (a past bug wrote stt.ctx.autoSubmit).
  const { resolveSttAutoSubmit } = await import("../lib/stt.js");
  assert.equal(resolveSttAutoSubmit({}, kv), true);
  toggleAutoSubmit();
  assert.equal(isAutoSubmit(), false);
});

test("toggleAutoSubmit warns it does not apply in conversation mode", () => {
  const store = new Map();
  const toasts = [];
  const api = { ui: { toast: (t) => toasts.push(typeof t === "string" ? t : t?.message) } };
  const kv = {
    get: (k, fb) => (store.has(k) ? store.get(k) : fb),
    set: (k, v) => void store.set(k, v),
  };
  const conv = { isActive: () => true, getPhase: () => "paused" };
  const { toggleAutoSubmit } = createVoiceActions({ kv, api, conversation: conv });
  toggleAutoSubmit();
  assert.equal(store.get("stt.autoSubmit"), true, "stored value still flips for later");
  assert.ok(
    toasts.some((t) => /conversation/i.test(t)),
    "warned it only affects dictation",
  );
});

test("correct routes to the command in idle, refuses in conversation", () => {
  const store = new Map();
  const toasts = [];
  const api = { ui: { toast: (t) => toasts.push(typeof t === "string" ? t : t?.message) } };
  const kv = {
    get: (k, fb) => (store.has(k) ? store.get(k) : fb),
    set: (k, v) => void store.set(k, v),
  };
  let corrected = 0;
  const idle = createVoiceActions({ kv, api, cmds: { correctCmd: () => void corrected++ } });
  idle.correct();
  assert.equal(corrected, 1);
  const conv = createVoiceActions({
    kv,
    api,
    conversation: { isActive: () => true, getPhase: () => "paused" },
    cmds: { correctCmd: () => void corrected++ },
  });
  conv.correct();
  assert.equal(corrected, 1, "conversation mode must not trigger correction");
  assert.ok(toasts.some((t) => /dictation/i.test(t)));
});

test("auto-submit stays consistent across two kv facades over shared storage", () => {
  const store = new Map();
  const facade = () => ({
    get: (k, fb) => (store.has(k) ? store.get(k) : fb),
    set: (k, v) => void store.set(k, v),
  });
  const opts = { sttAutoSubmit: true };
  const a = createVoiceActions({ kv: facade(), options: opts, api: { ui: { toast: () => {} } } });
  const b = createVoiceActions({ kv: facade(), options: opts, api: { ui: { toast: () => {} } } });
  assert.equal(a.isAutoSubmit(), true, "option fallback before any toggle");
  assert.equal(a.toggleAutoSubmit(), false, "on->off");
  assert.equal(b.isAutoSubmit(), false, "second facade reads the toggle live");
  assert.equal(b.toggleAutoSubmit(), true, "off->on from the other facade");
  assert.equal(a.isAutoSubmit(), true, "first facade reads it back");
  store.set("stt.autoSubmit", false);
  assert.equal(a.isAutoSubmit(), false, "explicit kv false overrides true option");
  assert.equal(b.isAutoSubmit(), false, "override visible on both facades");
});

test("toggle-mid-record then Stop transcribes and honors the latest flag", async () => {
  const { createCommands } = await import("../lib/stt/commands.js");
  const store = new Map();
  const kv = {
    get: (k, fb) => (store.has(k) ? store.get(k) : fb),
    set: (k, v) => void store.set(k, v),
  };
  const calls = { pipeline: [], started: 0 };
  let recording = true;
  const ctx = {
    opts: {},
    kv,
    kb: () => null,
    sttApiEndpoint: null,
    autoSubmit: false,
    // Intentionally omit autoSubmitNow: stale wiring must not lose the toggle.
    autoSubmitNow: undefined,
    sttLog: () => {},
    conversationActive: () => false,
    currentSttMode: () => "batch",
    getStreamingActive: () => false,
    liveNotesActive: () => false,
    processing: () => false,
    recording: () => recording,
    clearRecordingToast: () => {},
    toast: () => {},
    complete: async () => ({ text: "x" }),
    client: {},
    api: { ui: { toast: () => {}, dialog: {}, DialogSelect: (p) => p } },
    systemPrompt: "",
    logger: null,
    renderer: null,
    startLoopRecording: () => void calls.started++,
    doTranscribePipeline: (...args) => void calls.pipeline.push(args),
  };
  const commands = createCommands(ctx);
  const auto = commands.find((c) => c.value === "stt.autosubmit");
  const record = commands.find((c) => c.value === "stt.record");
  assert.ok(auto && record, "both commands exist");
  // Mid-record toggle ON via the real command path.
  auto.onSelect();
  assert.equal(store.get("stt.autoSubmit"), true, "toggle persisted kv-only, no restart");
  assert.equal(calls.started, 0, "toggle must never restart capture");
  assert.equal(recording, true, "still in-flight after toggle");
  // Stop via the real record path.
  record.onSelect();
  assert.equal(calls.pipeline.length, 1, "Stop transcribes instead of stalling");
  const submitArg = calls.pipeline[0][6];
  const effective =
    submitArg === true || (typeof submitArg === "function" ? submitArg() === true : false);
  assert.equal(effective, true, "delivery uses the latest flag (mid-record toggle wins)");
});

test("replay button stops TTS while speaking instead of replaying", () => {
  const toasts = [];
  let stopped = 0;
  const api = { ui: { toast: (t) => toasts.push(typeof t === "string" ? t : t?.message) } };
  const kv = { get: () => null, set: () => {} };
  const actions = createVoiceActions({
    kv,
    api,
    tts: {
      isSpeaking: () => true,
      stop: () => {
        stopped += 1;
      },
    },
    cmds: { speakLastCmd: () => toasts.push("played again") },
  });
  actions.speakReply();
  assert.equal(stopped, 1);
  assert.ok(!toasts.includes("played again"), "must not restart playback");
});

test("stopAll during streaming finalize cancels the stream, not the batch path", async () => {
  const { api, kv } = makeCtx();
  const stt = makeStt();
  stt.isFinalizing = () => true;
  const actions = createVoiceActions({
    stt,
    tts: makeTts(),
    conversation: { isActive: () => false },
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: {},
  });
  const cancelled = await actions.stopAll();
  assert.deepEqual(stt._calls, ["cancelStreaming"]);
  assert.ok(cancelled.includes("streaming"));
});
