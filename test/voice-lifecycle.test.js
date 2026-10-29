// Lifecycle regression: plugin re-registration must not leak event handlers.
// Repro for the TTS auto-handler leak: registerTTS subscribes to 4 session
// events and the dispose hook never unsubscribed them, so a second registration
// (resumed session / reload) doubled auto-TTS speech and fired stale handlers
// cross-session.
//
// Sweep (2026-10-11 audit): every register/dispose cycle must also leave no
// handlers behind when disposal lands mid-turn (conversation waiting on a
// reply holds 5 subscriptions: 1 reply-stream + 4 reply-wait), and repeated
// cycles must settle at a stable count. Event unsubs are the deterministic
// leak signal (no flaky RSS thresholds); timers/procs are covered by the same
// dispose hooks (stt toast clears, sox cancel, warm-lease release) and the
// module-scoped remainder is fixed-size (prevWaveLevels is WAVE_LEN) or
// refcounted (sharedServers deletes at refs 0).
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import plugin from "../index.js";
import { registerConversation } from "../lib/conversation.js";
import { registerTTS } from "../lib/tts.js";
import { __setProcessingToastFn } from "../lib/stt.js";

const CONFIGURED_OPTIONS = {
  endpoint: "https://opencode.ai/zen/v1",
  model: "space-bunny-free",
  apiKeyEnv: "OPENCODE_GO_KEY",
  useResponsesApi: true,
  sttAutoSubmit: true,
  sttMode: "streaming",
  ttsEngine: "chatterbox",
  ttsChatterboxPython: "/Users/duytrinh/.local/share/opencode-voice/chatterbox-venv/bin/python",
};

function makeHost() {
  const handlers = new Map();
  const disposes = [];
  const store = new Map();
  const api = {
    client: {},
    route: { current: { name: "session", params: { sessionID: "ses_A" } } },
    state: { session: { messages: () => [] }, path: { directory: "/tmp" } },
    event: {
      on: (name, fn) => {
        if (!handlers.has(name)) handlers.set(name, []);
        handlers.get(name).push(fn);
        return () => {
          const arr = handlers.get(name) || [];
          const i = arr.indexOf(fn);
          if (i >= 0) arr.splice(i, 1);
        };
      },
    },
    ui: { toast: () => {}, dialog: {} },
    lifecycle: { onDispose: (fn) => disposes.push(fn) },
    command: { register: () => {} },
  };
  const kv = {
    get: (k, fb) => (store.has(k) ? store.get(k) : fb),
    set: (k, v) => store.set(k, v),
  };
  api.kv = kv;
  const logger = { log: () => {} };
  const count = () => {
    let n = 0;
    for (const arr of handlers.values()) n += arr.length;
    return n;
  };
  return { api, kv, logger, handlers, disposes, count };
}

test("registerTTS removes its event handlers on dispose", async () => {
  const host = makeHost();
  const complete = async () => ({ text: null, error: "unavailable" });
  registerTTS(host.api, host.kv, complete, undefined, {}, host.logger);
  assert.ok(host.count() > 0, "expected TTS to subscribe to session events");
  for (const fn of host.disposes) await fn();
  assert.equal(host.count(), 0, "TTS handlers survive dispose");
});

test("full plugin re-registration leaves no stale handlers behind", async () => {
  const first = makeHost();
  await plugin.tui(first.api, CONFIGURED_OPTIONS);
  const initCount = first.count();
  assert.ok(initCount > 0, "expected plugin to subscribe to session events");
  for (const fn of first.disposes) await fn();
  assert.equal(first.count(), 0, "first registration handlers survive dispose");

  const second = makeHost();
  await plugin.tui(second.api, CONFIGURED_OPTIONS);
  assert.equal(second.count(), initCount, "re-registration changed handler count");
  for (const fn of second.disposes) await fn();
  assert.equal(second.count(), 0, "second registration handlers survive dispose");
});

test("repeated register/dispose cycles settle at a stable count", async () => {
  // Five back-to-back cycles: each dispose must return to zero and each
  // fresh registration must land on the same count (no monotonic growth
  // from module-scoped maps, listener lists, or late async completions).
  let initCount = -1;
  for (let i = 0; i < 5; i += 1) {
    const host = makeHost();
    await plugin.tui(host.api, CONFIGURED_OPTIONS);
    if (initCount < 0) initCount = host.count();
    assert.equal(host.count(), initCount, `cycle ${i} changed handler count`);
    for (const fn of host.disposes) await fn();
    assert.equal(host.count(), 0, `cycle ${i} handlers survive dispose`);
  }
});

test("plugin init is sub-second (startup cost lives outside the plugin)", async () => {
  // The ~5s fresh-startup report was never reproduced at plugin level.
  // This pins the measured scope: init does no I/O beyond mkdir chats dir,
  // so any multi-second startup is core session hydration, not this plugin.
  // Isolate per CONTRIBUTING: `node -e "await import('opencode-voice')"`
  // timing vs `opencode --version` timing with the plugin disabled.
  const host = makeHost();
  const t0 = performance.now();
  await plugin.tui(host.api, CONFIGURED_OPTIONS);
  const initMs = performance.now() - t0;
  assert.ok(initMs < 1000, `plugin init took ${initMs.toFixed(1)}ms`);
  for (const fn of host.disposes) await fn();
});

test("fresh-process import of the plugin is milliseconds", async () => {
  // Fresh `node` process importing index.js cold: the import-time share of
  // startup. Bound is generous (slow CI disks); the recorded value below is
  // what the audit actually measured.
  const indexPath = fileURLToPath(new URL("../index.js", import.meta.url));
  const out = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const t0 = performance.now(); await import(${JSON.stringify(indexPath)}); console.log(Math.round(performance.now() - t0));`,
      ],
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)),
    );
  });
  const importMs = Number((out.match(/\d+/) || [])[0]);
  assert.ok(Number.isFinite(importMs), `unparseable import timing: ${out}`);
  assert.ok(importMs < 5000, `plugin import took ${importMs}ms`);
});

function makeConversationHarness() {
  // registerConversation with injected stt/tts fakes: no mic, no audio, no
  // LLM. The dispose hook is captured so unload can land mid-wait.
  __setProcessingToastFn(() => {});
  const handlers = new Map();
  const disposes = [];
  const toasts = [];
  const api = {
    ui: { toast: (input) => toasts.push(input?.message ?? input) },
    route: { current: { name: "session", params: { sessionID: "s1" } } },
    event: {
      on: (name, fn) => {
        if (!handlers.has(name)) handlers.set(name, []);
        handlers.get(name).push(fn);
        return () => {
          const arr = handlers.get(name) || [];
          const i = arr.indexOf(fn);
          if (i >= 0) arr.splice(i, 1);
        };
      },
    },
    state: { session: { messages: () => [] }, part: () => [] },
    lifecycle: { onDispose: (fn) => disposes.push(fn) },
  };
  const calls = { speakTurn: 0, submitted: [] };
  const stt = {
    isRecording: () => false,
    isProcessing: () => false,
    start: () => true,
    setStopHint: () => {},
    cancel: () => {},
    discard: () => {},
    transcribeTurn: async () => ({ text: "hello" }),
    submitTurnText: async (text) => {
      calls.submitted.push(text);
      return { text };
    },
  };
  const tts = {
    speak: async () => null,
    speakAssistantTurn: async () => {
      calls.speakTurn += 1;
      return { spoken: true };
    },
    stop: () => true,
    isSpeaking: () => false,
    setConversationActive: () => {},
  };
  const { controller } = registerConversation(
    api,
    { conversationTimeoutMs: 60000, conversationRestartDelayMs: 5 },
    { log: () => {} },
    { stt, tts },
  );
  const count = () => {
    let n = 0;
    for (const arr of handlers.values()) n += arr.length;
    return n;
  };
  return { api, handlers, disposes, calls, controller, count };
}

test("conversation dispose mid-wait removes reply-stream and reply-wait handlers", async () => {
  // Drive to "waiting": start (paused) -> key (recording) -> key (finish,
  // transcribe, submit, wait). The wait holds 1 message.part.delta +
  // session.idle/session.status/permission.asked/question.asked. Dispose
  // must settle the wait (no later speak) and remove all 5.
  const h = makeConversationHarness();
  h.controller.onKey(); // start -> paused
  h.controller.onKey(); // beginTurn -> recording
  h.controller.onKey(); // finishTurnFlow -> transcribe -> submit -> waiting
  const deadline = Date.now() + 2000;
  while ((h.handlers.get("session.idle") || []).length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(
    (h.handlers.get("session.idle") || []).length > 0,
    "conversation never reached waiting",
  );
  assert.equal(h.count(), 5, `waiting should hold 5 subscriptions, holds ${h.count()}`);
  for (const fn of h.disposes) await fn();
  assert.equal(h.count(), 0, "conversation wait/stream handlers survive dispose");
  // The settled wait resolves as "stopped": no reply is spoken after unload.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.speakTurn, 0, "reply spoken after dispose");
  assert.deepEqual(h.calls.submitted, ["hello"]);
});
