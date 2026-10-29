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
    setStopHint: (hint) => {
      calls.stopHint = hint;
    },
    cancel: () => {},
    discard: () => {},
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
    setSpeakGate: (p) => {
      speakGate = p;
    },
    setSpeakWordGate: (p) => {
      speakWordGate = p;
    },
  };
}

function fireEvent(handlers, type, sessionID = "s1") {
  for (const handler of handlers[type] || []) {
    handler({ properties: { sessionID } });
  }
}

function fireIdle(h) {
  fireEvent(h, "session.idle");
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

test("full turn rests paused after speaking, next key starts turn 2", async () => {
  const h = makeHarness();
  h.controller.onKey();
  h.controller.onKey();
  assert.equal(h.calls.sttStart, 1);
  h.controller.onKey();
  await tick(30);
  assert.deepEqual(h.calls.submitted, ["hello"]);
  fireIdle(h.handlers);
  await tick(30);
  assert.equal(h.calls.speakTurn, 1);
  // Push-to-talk: the loop must never reopen the mic by itself.
  assert.equal(h.calls.sttStart, 1);
  assert.ok(h.toasts.some((t) => t.includes("Press <leader>v to talk")));
  h.controller.onKey();
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
  fireIdle(h.handlers);
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
  fireIdle(h.handlers);
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
  h.stateData.messages.push({ id: "a1", role: "assistant", time: { created: Date.now() } });
  h.stateData.parts["a1"] = [{ id: "p1", type: "text", text: "" }];
  for (const handler of h.handlers["message.part.delta"] || []) {
    handler({
      properties: {
        sessionID: "s1",
        messageID: "a1",
        partID: "p1",
        field: "text",
        delta: "The answer is 42.",
      },
    });
  }
  await tick(20);
  assert.ok(h.calls.speakCalls.includes("The answer is 42."));
  fireIdle(h.handlers);
  await tick(30);
  assert.equal(h.calls.speakFull, 0);
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
  fireIdle(h.handlers);
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
  fireIdle(h.handlers);
  await tick(20);
  assert.ok(h.toasts.some((t) => t.includes("Speaking - press ctrl+b to interrupt")));
  h.controller.stop("test");
  release();
});

test("streams reply deltas while waiting, skips full speak", async () => {
  const h = makeHarness();
  h.controller.onKey();
  h.controller.onKey();
  h.controller.onKey();
  await tick(30);
  h.stateData.messages.push({ id: "a1", role: "assistant", time: { created: Date.now() } });
  h.stateData.parts["a1"] = [
    { id: "p1", type: "text", text: "" },
    { id: "p2", type: "reasoning", text: "" },
  ];
  const delta = (partID, text) => ({
    properties: { sessionID: "s1", messageID: "a1", partID, field: "text", delta: text },
  });
  for (const handler of h.handlers["message.part.delta"] || []) {
    handler(delta("p1", "Hello world. How are "));
    handler(delta("p2", "secret thinking"));
    handler(delta("p1", "you?"));
  }
  await tick(20);
  assert.deepEqual(h.calls.speakCalls, ["Hello world.", "How are you?"]);
  fireIdle(h.handlers);
  await tick(30);
  assert.equal(h.calls.speakFull, 0);
  assert.equal(h.calls.sttStart, 1);
  h.controller.stop("test");
});

test("falls back to full speak when nothing streamable arrives", async () => {
  const h = makeHarness();
  h.controller.onKey();
  h.controller.onKey();
  h.controller.onKey();
  await tick(30);
  fireIdle(h.handlers);
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
  fireIdle(h.handlers);
  await tick(20);
  assert.equal(h.controller.onTtsStop(), true);
  assert.equal(h.calls.ttsStop, 1);
  release();
  await tick(20);
  assert.equal(h.calls.sttStart, 1);
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

test("queued sentences still drain after the turn flips to speaking", async () => {
  const h = makeHarness();
  let releaseSpeak;
  h.setSpeakWordGate(new Promise((r) => (releaseSpeak = r)));
  h.controller.onKey();
  h.controller.onKey();
  h.controller.onKey();
  await tick(30);
  h.stateData.messages.push({ id: "a1", role: "assistant", time: { created: Date.now() } });
  h.stateData.parts["a1"] = [{ id: "p1", type: "text", text: "" }];
  for (const handler of h.handlers["message.part.delta"] || []) {
    handler({
      properties: {
        sessionID: "s1",
        messageID: "a1",
        partID: "p1",
        field: "text",
        delta: "Hello world. ",
      },
    });
  }
  await tick(20);
  // Real TTS latency: the first sentence is still speaking when the turn
  // finishes and flips to speaking before the tail flush.
  fireIdle(h.handlers);
  await tick(20);
  releaseSpeak();
  await tick(30);
  assert.ok(h.calls.speakCalls.includes("Hello world."));
  h.controller.stop("test");
});
