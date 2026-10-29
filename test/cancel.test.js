import assert from "node:assert/strict";
import test from "node:test";

import { registerVoiceCancel } from "../lib/cancel.js";

function makeApi(toasts) {
  return {
    ui: { toast: (input) => toasts.push(input?.message ?? input) },
  };
}

function makeControllers() {
  const calls = {
    ttsStop: 0,
    sttCancel: 0,
    sttCancelStreaming: 0,
    conversationStop: 0,
    liveNotesCancel: 0,
  };
  const stt = {
    streaming: false,
    recording: false,
    processing: false,
    isStreaming: () => stt.streaming,
    isRecording: () => stt.recording,
    isProcessing: () => stt.processing,
    cancel: () => {
      calls.sttCancel += 1;
    },
    cancelStreaming: async () => {
      calls.sttCancelStreaming += 1;
    },
  };
  const tts = {
    speaking: false,
    isSpeaking: () => tts.speaking,
    stop: () => {
      calls.ttsStop += 1;
    },
  };
  const conversation = {
    active: false,
    isActive: () => conversation.active,
    stop: () => {
      calls.conversationStop += 1;
    },
  };
  const liveNotes = {
    active: false,
    isActive: () => liveNotes.active,
    cancel: () => {
      calls.liveNotesCancel += 1;
    },
  };
  return { calls, stt, tts, conversation, liveNotes };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test("cancels every active controller and summarizes", async () => {
  const toasts = [];
  const { calls, stt, tts, conversation, liveNotes } = makeControllers();
  tts.speaking = true;
  stt.recording = true;
  conversation.active = true;
  liveNotes.active = true;
  const { commands } = registerVoiceCancel(makeApi(toasts), {}, null, {
    stt,
    tts,
    conversation,
    liveNotes,
  });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].value, "voice.cancel");
  assert.equal(commands[0].slash.name, "voice-cancel");
  commands[0].onSelect();
  await tick();
  assert.equal(calls.ttsStop, 1);
  assert.equal(calls.sttCancel, 1);
  assert.equal(calls.conversationStop, 1);
  assert.equal(calls.liveNotesCancel, 1);
  assert.match(toasts.at(-1), /Cancelled: .*TTS.*recording.*conversation.*live notes/s);
});

test("cancels streaming dictation instead of batch recording", async () => {
  const toasts = [];
  const { calls, stt, tts, conversation, liveNotes } = makeControllers();
  stt.streaming = true;
  stt.recording = true;
  const { commands } = registerVoiceCancel(makeApi(toasts), {}, null, {
    stt,
    tts,
    conversation,
    liveNotes,
  });
  commands[0].onSelect();
  await tick();
  assert.equal(calls.sttCancelStreaming, 1);
  assert.equal(calls.sttCancel, 0);
  assert.match(toasts.at(-1), /streaming/);
});

test("idle cancels nothing and never throws", async () => {
  const toasts = [];
  const { calls, stt, tts, conversation, liveNotes } = makeControllers();
  const { commands } = registerVoiceCancel(makeApi(toasts), {}, null, {
    stt,
    tts,
    conversation,
    liveNotes,
  });
  commands[0].onSelect();
  await tick();
  assert.equal(calls.ttsStop, 0);
  assert.equal(calls.sttCancel, 0);
  assert.equal(calls.sttCancelStreaming, 0);
  assert.equal(calls.conversationStop, 0);
  assert.equal(calls.liveNotesCancel, 0);
  assert.equal(toasts.at(-1), "Nothing to cancel");
});

test("tolerates throwing controllers without throwing", async () => {
  const toasts = [];
  const bad = () => {
    throw new Error("boom");
  };
  const { commands } = registerVoiceCancel(makeApi(toasts), {}, null, {
    stt: { isStreaming: bad, isRecording: bad, isProcessing: bad, cancel: bad },
    tts: { isSpeaking: bad, stop: bad },
    conversation: { isActive: bad, stop: bad },
    liveNotes: { isActive: bad, cancel: bad },
  });
  commands[0].onSelect();
  await tick();
  assert.equal(toasts.at(-1), "Nothing to cancel");
});

test("keybind defaults to <leader>. and respects overrides", () => {
  const toasts = [];
  const deps = makeControllers();
  const fallback = registerVoiceCancel(makeApi(toasts), {}, null, deps);
  assert.equal(fallback.commands[0].keybind, "<leader>.");

  const none = registerVoiceCancel(
    makeApi(toasts),
    { keybinds: { "voice.cancel": "none" } },
    null,
    deps,
  );
  assert.ok(!("keybind" in none.commands[0]));

  const custom = registerVoiceCancel(
    makeApi(toasts),
    { keybinds: { "voice.cancel": "ctrl+x" } },
    null,
    deps,
  );
  assert.equal(custom.commands[0].keybind, "ctrl+x");
});
