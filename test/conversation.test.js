import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_STOP_PHRASES,
  matchesStopPhrase,
  normalizePhrase,
  registerConversation,
} from "../lib/conversation.js";
import { __setProcessingToastFn } from "../lib/stt.js";

test("normalizes phrases for comparison", () => {
  assert.equal(normalizePhrase("  Stop... "), "stop");
  assert.equal(normalizePhrase("DỪNG LẠI!"), "dừng lại");
  assert.equal(normalizePhrase("Exit   Conversation "), "exit conversation");
});

test("matches exact stop phrases only", () => {
  assert.equal(matchesStopPhrase("stop"), true);
  assert.equal(matchesStopPhrase("Stop."), true);
  assert.equal(matchesStopPhrase("dừng lại"), true);
  assert.equal(matchesStopPhrase("KẾT THÚC"), true);
  assert.equal(matchesStopPhrase("goodbye!"), true);
});

test("matches stuttered and padded stop commands", () => {
  assert.equal(matchesStopPhrase("stop stop"), true);
  assert.equal(matchesStopPhrase("stop stop stopping"), true);
  assert.equal(matchesStopPhrase("please stop the conversation now"), true);
  assert.equal(matchesStopPhrase("dừng lại đi"), true);
  assert.equal(matchesStopPhrase("thôi"), true);
});

test("does not match speech containing stop words", () => {
  assert.equal(matchesStopPhrase("please stop the server"), false);
  assert.equal(matchesStopPhrase("do not stop"), false);
  assert.equal(matchesStopPhrase("stop the deployment right now please sir"), false);
  assert.equal(matchesStopPhrase(""), false);
  assert.equal(matchesStopPhrase(null), false);
});

test("supports custom phrase lists", () => {
  assert.equal(matchesStopPhrase("halt", ["halt"]), true);
  assert.equal(matchesStopPhrase("stop", ["halt"]), false);
});

test("default list covers both languages", () => {
  assert.ok(DEFAULT_STOP_PHRASES.includes("stop"));
  assert.ok(DEFAULT_STOP_PHRASES.includes("dừng lại"));
});

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function makeHarness({ transcribe = { text: "hello" }, opts = {} } = {}) {
  const toasts = [];
  const handlers = {};
  const stateData = { messages: [], parts: {} };
  // The sticky status toast is what makes a phase legible on screen, so tests
  // watch it in the same list as the one-shot toasts.
  __setProcessingToastFn((input) => toasts.push(input?.message ?? input));
  const api = {
    ui: { toast: (input) => toasts.push(input?.message ?? input) },
    route: { current: { name: "session", params: { sessionID: "s1" } } },
    event: {
      on: (type, handler) => {
        (handlers[type] ??= []).push(handler);
        return () => {
          handlers[type] = (handlers[type] || []).filter((h) => h !== handler);
        };
      },
    },
    state: {
      session: { messages: () => stateData.messages },
      part: (messageID) => stateData.parts[messageID] || [],
    },
    lifecycle: {},
  };
  const calls = {
    sttStart: 0,
    ttsStop: 0,
    speakTurn: 0,
    speakFull: 0,
    speakCalls: [],
    submitted: [],
    stopHint: undefined,
    phases: [],
    actions: null,
    cancelStreaming: 0,
  };
  // The status line is the only thing the user sees after a key press, so the
  // phase and the button set it renders are part of the observable behavior.
  api.setConvPhase = (p) => calls.phases.push(p);
  api.setConvActions = (a) => {
    calls.actions = a;
  };
  let speakGate = null;
  let speakWordGate = null;
  const stt = {
    isRecording: () => false,
    isProcessing: () => false,
    start: () => {
      calls.sttStart += 1;
      return true;
    },
    startTurn: ({ streaming, autoEnd, onStreamFinalize, onSilenceFinalize, onBusy } = {}) => {
      if (streaming) {
        if (typeof stt.setConversationStreamingFinalize === "function") {
          stt.setConversationStreamingFinalize(autoEnd ? 2.5 : null, onStreamFinalize);
        }
        if (typeof stt.startStreaming === "function" && stt.startStreaming()) {
          return { ok: true, streaming: true };
        }
        if (typeof stt.setConversationStreamingFinalize === "function") {
          stt.setConversationStreamingFinalize(null, null);
        }
        if (autoEnd && typeof stt.setSilenceAutoFinalize === "function") {
          stt.setSilenceAutoFinalize(2.5, onSilenceFinalize);
        } else if (typeof stt.setSilenceAutoFinalize === "function") {
          stt.setSilenceAutoFinalize(null, null);
        }
        const ok = stt.start();
        if (!ok) {
          if (typeof onBusy === "function") onBusy();
          return { ok: false, streaming: false };
        }
        return { ok: true, streaming: false };
      }
      if (autoEnd && typeof stt.setSilenceAutoFinalize === "function") {
        stt.setSilenceAutoFinalize(2.5, onSilenceFinalize);
      } else if (typeof stt.setSilenceAutoFinalize === "function") {
        stt.setSilenceAutoFinalize(null, null);
      }
      const ok = stt.start();
      if (!ok) {
        if (typeof onBusy === "function") onBusy();
        return { ok: false, streaming: false };
      }
      return { ok: true, streaming: false };
    },
    setStopHint: (hint) => {
      calls.stopHint = hint;
    },
    cancel: () => {},
    cancelStreaming: () => {
      calls.cancelStreaming += 1;
    },
    discard: () => {},
    setAutoEnd: () => {},
    endTurn: () => {},
    cancelTurnCleanup: () => {},
    transcribeTurn: () =>
      transcribe && typeof transcribe.then === "function"
        ? transcribe
        : Promise.resolve({ ...transcribe }),
    submitTurnText: async (text) => {
      calls.submitted.push(text);
      return { text };
    },
  };
  const tts = {
    speak: async (text) => {
      if (speakWordGate) await speakWordGate;
      calls.speakCalls.push(text);
    },
    speakAssistantTurn: async () => {
      calls.speakTurn += 1;
      calls.speakFull += 1;
      if (speakGate) await speakGate;
      return { spoken: true };
    },
    stop: () => {
      calls.ttsStop += 1;
      return true;
    },
    isSpeaking: () => false,
    setConversationActive: () => {},
  };
  const { controller } = registerConversation(
    api,
    { conversationTimeoutMs: 60, conversationRestartDelayMs: 5, ...opts },
    null,
    { stt, tts },
  );
  return {
    api,
    toasts,
    handlers,
    calls,
    stateData,
    controller,
    stt,
    tts,
    setSpeakGate: (p) => {
      speakGate = p;
    },
    setSpeakWordGate: (p) => {
      speakWordGate = p;
    },
  };
}

function fireEvent(handlers, type, sessionID = "s1", data = {}) {
  for (const handler of handlers[type] || []) {
    handler({ properties: { sessionID, ...data } });
  }
}

// A finished assistant message is what makes the wait trustworthy: the loop
// only accepts a reply that arrived after submit, so every idle/execution
// event needs the message the host would have written by then.
function addReply(h, { id, finish = "stop" } = {}) {
  const messageID = id ?? `a${h.stateData.messages.length + 1}`;
  h.stateData.messages.push({
    id: messageID,
    role: "assistant",
    finish,
    time: { created: Date.now() },
  });
  h.stateData.parts[messageID] = [{ id: `${messageID}:0`, type: "text", text: "reply" }];
  return messageID;
}

function fireIdle(h) {
  addReply(h);
  fireEvent(h.handlers, "session.idle");
}

function fireExecution(h, type, data = {}) {
  fireEvent(h.handlers, `session.execution.${type}`, "s1", data);
}

test("start leaves the mic closed until the key is pressed", () => {
  const h = makeHarness();
  h.controller.onKey();
  assert.equal(h.calls.sttStart, 0);
  assert.equal(h.calls.stopHint, "<leader>v");
  assert.ok(h.toasts.some((t) => t.includes("<leader>v") && t.includes("talk")));
  h.controller.onKey();
  assert.equal(h.calls.sttStart, 1);
  h.controller.stop("test");
  assert.equal(h.calls.stopHint, null);
});

test("streaming conversation keeps its finalize callback when auto-end is off", () => {
  const h = makeHarness();
  h.api.kv = {
    get: (key) =>
      key === "stt.mode" ? "streaming" : key === "stt.autoEndOfSpeech" ? false : undefined,
  };
  const finals = [];
  Object.assign(h.stt, {
    isStreaming: () => false,
    startStreaming: () => true,
    setConversationStreamingEnabled: () => {},
    setConversationStreamingFinalize: (sec, cb) => finals.push({ sec, cb }),
  });
  h.controller.onKey();
  h.controller.onKey();
  const last = finals.at(-1);
  assert.equal(last?.sec, null, "auto-end stays off");
  assert.equal(
    typeof last?.cb,
    "function",
    "stop callback stays registered so the STT timer can route to conversation",
  );
  h.controller.stop("test");
});

test("full turn speaks the reply, then reopens the mic hands-free", async () => {
  const h = makeHarness();
  h.controller.onKey();
  h.controller.onKey();
  assert.equal(h.calls.sttStart, 1);
  h.controller.onKey();
  await tick(30);
  assert.deepEqual(h.calls.submitted, ["hello"]);
  fireIdle(h);
  await tick(30);
  assert.equal(h.calls.speakTurn, 1);
  // Speaking first, mic still closed while the audio plays.
  assert.equal(h.calls.sttStart, 1);
  assert.ok(h.toasts.some((t) => t.includes("Speaking")));
  // Hands-free: once playback ends the next turn records without a keypress.
  await tick(700);
  assert.equal(h.calls.sttStart, 2);
  h.controller.stop("test");
});

test("speaking + key barges in: cuts audio and opens the mic in one press", async () => {
  const h = makeHarness();
  let release;
  h.setSpeakGate(new Promise((r) => (release = r)));
  h.controller.onKey();
  h.controller.onKey();
  h.controller.onKey();
  await tick(30);
  fireIdle(h);
  await tick(20);
  assert.equal(h.calls.speakTurn, 1);
  h.controller.onKey();
  assert.equal(h.calls.ttsStop, 1);
  assert.equal(h.calls.sttStart, 2);
  release();
  await tick(20);
  assert.equal(h.calls.sttStart, 2);
  h.controller.stop("test");
});

test("empty turn pauses instead of re-recording", async () => {
  const h = makeHarness({ transcribe: { text: null, empty: true } });
  h.controller.onKey();
  h.controller.onKey();
  h.controller.onKey();
  await tick(20);
  assert.equal(h.calls.sttStart, 1);
  assert.ok(h.toasts.some((t) => t.includes("No speech")));
  h.controller.onKey();
  assert.equal(h.calls.sttStart, 2);
  h.controller.stop("test");
});

test("toggle while waiting barges in and drops the late reply", async () => {
  const h = makeHarness();
  h.controller.onKey();
  h.controller.onKey();
  h.controller.onKey();
  await tick(30);
  assert.deepEqual(h.calls.submitted, ["hello"]);
  h.controller.onKey();
  // A press means "talk now", never "exit" - the mode stays on.
  assert.equal(h.controller.isActive(), true);
  assert.ok(!h.toasts.includes("Conversation off"));
  assert.equal(h.calls.sttStart, 2);
  fireIdle(h);
  await tick(30);
  assert.equal(h.calls.speakTurn, 0);
  assert.deepEqual(h.calls.speakCalls, []);
  h.controller.stop("test");
});

test("toggle during processing reports busy instead of exiting", async () => {
  let resolveTranscribe;
  const pending = new Promise((r) => (resolveTranscribe = r));
  const h = makeHarness({ transcribe: pending });
  h.controller.onKey();
  h.controller.onKey();
  h.controller.onKey();
  await tick(10);
  h.controller.onKey();
  assert.ok(h.toasts.some((t) => t.includes("busy")));
  assert.ok(!h.toasts.includes("Conversation off"));
  resolveTranscribe({ text: "late hello" });
  await tick(20);
  assert.deepEqual(h.calls.submitted, ["late hello"]);
  h.controller.stop("test");
});

test("question gate keeps the mic shut and speaks the post-answer reply", async () => {
  const h = makeHarness();
  h.controller.onKey();
  h.controller.onKey();
  h.controller.onKey();
  await tick(30);
  assert.deepEqual(h.calls.submitted, ["hello"]);
  fireEvent(h.handlers, "question.asked");
  await tick(30);
  // Notice spoken, mic NOT opened: the user answers on screen.
  assert.ok(h.calls.speakCalls.includes("A question needs your answer. Please check your screen."));
  assert.equal(h.calls.sttStart, 1);
  assert.ok(h.toasts.some((t) => t.includes("Answer on screen")));
  // The agent resumes: its answer must be spoken (this used to be silent).
  addReply(h, { id: "a1" });
  fireExecution(h, "succeeded", { executionID: "e1" });
  await tick(40);
  assert.equal(h.calls.speakFull, 1);
  assert.equal(h.calls.sttStart, 1);
  h.controller.stop("test");
});

test("permission gate + press barges in: pending answer dropped, mic opens", async () => {
  const h = makeHarness();
  h.controller.onKey();
  h.controller.onKey();
  h.controller.onKey();
  await tick(30);
  fireEvent(h.handlers, "permission.asked");
  await tick(30);
  assert.ok(h.calls.speakCalls.includes("Permission requested. Please check your screen."));
  assert.equal(h.calls.sttStart, 1);
  const stopsBefore = h.calls.ttsStop;
  h.controller.onKey();
  assert.ok(h.calls.ttsStop > stopsBefore);
  assert.equal(h.calls.sttStart, 2);
  // A late idle must not resurrect the answer that was abandoned.
  fireIdle(h);
  await tick(30);
  assert.equal(h.calls.speakFull, 0);
  assert.deepEqual(h.calls.submitted, ["hello"]);
  assert.equal(h.controller.isActive(), true);
  h.controller.stop("test");
});

test("phase toasts name the configured key", async () => {
  const h = makeHarness({ opts: { keybinds: { "voice.conversation": "ctrl+b" } } });
  h.controller.onKey();
  assert.ok(h.toasts.some((t) => t.includes("ctrl+b") && t.includes("talk")));
  h.controller.onKey();
  assert.ok(h.toasts.some((t) => t.includes("ctrl+b") && t.includes("send")));
  let release;
  h.setSpeakGate(new Promise((r) => (release = r)));
  h.controller.onKey();
  await tick(30);
  assert.ok(h.toasts.some((t) => t.includes("Working - press ctrl+b to talk")));
  fireIdle(h);
  await tick(20);
  assert.ok(h.toasts.some((t) => t.includes("Speaking - press ctrl+b to interrupt")));
  h.controller.stop("test");
  release();
});

test("mid-turn deltas stay unspoken; the finished reply is voiced once", async () => {
  const h = makeHarness();
  h.controller.onKey();
  h.controller.onKey();
  h.controller.onKey();
  await tick(30);
  addReply(h, { id: "a1", finish: "tool-calls" });
  const delta = (partID, text) => ({
    properties: { sessionID: "s1", messageID: "a1", partID, field: "text", delta: text },
  });
  for (const handler of h.handlers["message.part.delta"] || []) {
    handler(delta("p1", "Hello world. How are "));
    handler(delta("p2", "secret thinking"));
    handler(delta("p1", "you?"));
  }
  await tick(20);
  assert.deepEqual(h.calls.speakCalls, [], "live deltas are commentary, not the answer");
  assert.equal(h.calls.speakFull, 0, "the turn is still running");
  addReply(h, { id: "a2" });
  fireExecution(h, "succeeded", { executionID: "e1" });
  await tick(40);
  assert.equal(h.calls.speakFull, 1);
  assert.deepEqual(h.calls.speakCalls, []);
  assert.equal(h.calls.sttStart, 1);
  h.controller.stop("test");
});

test("speaks the finished reply once, then rests with the mic closed", async () => {
  const h = makeHarness();
  h.controller.onKey();
  h.controller.onKey();
  h.controller.onKey();
  await tick(30);
  fireIdle(h);
  await tick(30);
  assert.equal(h.calls.speakFull, 1);
  assert.equal(h.calls.sttStart, 1);
  h.controller.stop("test");
});

test("tts stop key pauses speaking, ignored when inactive", async () => {
  const h = makeHarness();
  assert.equal(h.controller.onTtsStop(), false);
  let release;
  h.setSpeakGate(new Promise((r) => (release = r)));
  h.controller.onKey();
  h.controller.onKey();
  h.controller.onKey();
  await tick(30);
  fireIdle(h);
  await tick(20);
  assert.equal(h.controller.onTtsStop(), true);
  assert.equal(h.calls.ttsStop, 1);
  // Pausing speech must move the status line off "Speaking", or its buttons
  // keep offering stop/barge/pauseTts while the audio is already dead.
  assert.equal(h.calls.phases.at(-1), "paused");
  assert.deepEqual(Object.keys(h.calls.actions).sort(), ["end", "talk"]);
  release();
  await tick(20);
  assert.equal(h.calls.sttStart, 1);
  h.controller.stop("test");
});

test("cancel key ends the live recording and holds the mode paused", async () => {
  const h = makeHarness();
  h.controller.onKey();
  h.controller.onKey();
  await tick(10);
  assert.equal(h.calls.phases.at(-1), "recording");
  h.controller.onKey("cancel");
  assert.equal(h.calls.cancelStreaming, 1, "the streaming capture must be cancelled");
  assert.equal(h.calls.phases.at(-1), "paused");
  assert.deepEqual(Object.keys(h.calls.actions).sort(), ["end", "talk"]);
  assert.deepEqual(h.calls.submitted, [], "cancel never submits");
  h.controller.stop("test");
});

test("explicit default list would kill the lenient vocabulary", () => {
  // Documents WHY registerConversation must keep undefined for defaults:
  // passing DEFAULT_STOP_PHRASES explicitly selects exact-only matching.
  assert.equal(matchesStopPhrase("stop stop", undefined), true);
  assert.equal(matchesStopPhrase("dừng lại đi", undefined), true);
  assert.equal(matchesStopPhrase("stop stop", DEFAULT_STOP_PHRASES), false);
  assert.equal(matchesStopPhrase("dừng lại đi", DEFAULT_STOP_PHRASES), false);
});

test("default registration exits on stuttered stop instead of submitting", async () => {
  const h = makeHarness({ transcribe: { text: "stop stop" } });
  h.controller.onKey();
  h.controller.onKey();
  h.controller.onKey();
  await tick(30);
  assert.deepEqual(h.calls.submitted, []);
  assert.ok(h.toasts.includes("Conversation off"));
  h.controller.stop("test");
});

test("custom stop phrases take full control with exact matching", async () => {
  const h = makeHarness({
    transcribe: { text: "stop stop" },
    opts: { conversationStopPhrases: ["halt"] },
  });
  h.controller.onKey();
  h.controller.onKey();
  h.controller.onKey();
  await tick(30);
  // "stop stop" is not the custom list: submitted, not exited.
  assert.deepEqual(h.calls.submitted, ["stop stop"]);
  h.controller.stop("test");
});

test("a tool-call finish does not end the turn or speak early", async () => {
  // These turns outlive the harness default reply timeout on purpose.
  const h = makeHarness({ opts: { conversationTimeoutMs: 5000 } });
  h.controller.onKey();
  h.controller.onKey();
  h.controller.onKey();
  await tick(30);
  addReply(h, { id: "a1", finish: "tool-calls" });
  fireEvent(h.handlers, "session.idle");
  await tick(40);
  assert.equal(h.calls.speakFull, 0, "an idle between tool calls is not the end");
  addReply(h, { id: "a2" });
  fireExecution(h, "succeeded", { executionID: "e1" });
  await tick(40);
  assert.equal(h.calls.speakFull, 1);
  h.controller.stop("test");
});

test("a reply left over from the previous turn cannot satisfy the wait", async () => {
  // These turns outlive the harness default reply timeout on purpose.
  const h = makeHarness({ opts: { conversationTimeoutMs: 5000 } });
  // Turn 1 already produced an assistant message; it must never be mistaken
  // for turn 2's answer (this is what spoke an empty reply ~800ms early).
  h.stateData.messages.push(
    { id: "u1", role: "user", time: { created: Date.now() } },
    { id: "a1", role: "assistant", finish: "stop", time: { created: Date.now() } },
  );
  h.controller.onKey();
  h.controller.onKey();
  h.controller.onKey();
  await tick(30);
  fireEvent(h.handlers, "session.idle");
  await tick(40);
  assert.equal(h.calls.speakFull, 0, "stale assistant message must not end the wait");
  addReply(h, { id: "a2" });
  fireExecution(h, "succeeded", { executionID: "e2" });
  await tick(40);
  assert.equal(h.calls.speakFull, 1);
  h.controller.stop("test");
});

test("execution events from another session are ignored", async () => {
  // These turns outlive the harness default reply timeout on purpose.
  const h = makeHarness({ opts: { conversationTimeoutMs: 5000 } });
  h.controller.onKey();
  h.controller.onKey();
  h.controller.onKey();
  await tick(30);
  addReply(h, { id: "a1" });
  fireEvent(h.handlers, "session.execution.succeeded", "other", { executionID: "e9" });
  await tick(40);
  assert.equal(h.calls.speakFull, 0);
  fireExecution(h, "succeeded", { executionID: "e1" });
  await tick(40);
  assert.equal(h.calls.speakFull, 1);
  h.controller.stop("test");
});

test("a stale execution id cannot end the current turn", async () => {
  // These turns outlive the harness default reply timeout on purpose.
  const h = makeHarness({ opts: { conversationTimeoutMs: 5000 } });
  h.controller.onKey();
  h.controller.onKey();
  h.controller.onKey();
  await tick(30);
  fireExecution(h, "started", { executionID: "e2" });
  addReply(h, { id: "a1" });
  fireExecution(h, "succeeded", { executionID: "e1" });
  await tick(40);
  assert.equal(h.calls.speakFull, 0, "an older execution must not close this turn");
  fireExecution(h, "succeeded", { executionID: "e2" });
  await tick(40);
  assert.equal(h.calls.speakFull, 1);
  h.controller.stop("test");
});

test("a reply that lands after the execution event is still spoken", async () => {
  // These turns outlive the harness default reply timeout on purpose.
  const h = makeHarness({ opts: { conversationTimeoutMs: 5000 } });
  h.controller.onKey();
  h.controller.onKey();
  h.controller.onKey();
  await tick(30);
  // The execution ends a beat before the message cache catches up.
  fireExecution(h, "started");
  await tick(5);
  fireExecution(h, "succeeded");
  await tick(10);
  addReply(h, { id: "a1" });
  await tick(150);
  assert.equal(h.calls.speakFull, 1);
  h.controller.stop("test");
});

test("a too-short turn releases the STT processing flag and shows paused actions", async () => {
  const h = makeHarness({ transcribe: { text: "ok" } });
  let discards = 0;
  h.stt.discard = () => {
    discards += 1;
  };
  h.controller.onKey();
  h.controller.onKey();
  h.controller.onKey();
  await tick(20);
  assert.equal(discards, 1, "short text must be discarded or STT stays busy");
  assert.equal(h.calls.phases.at(-1), "paused");
  assert.equal(typeof h.calls.actions?.talk, "function");
  h.controller.stop("test");
});
