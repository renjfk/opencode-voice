// V2 port smoke tests.
//
// They validate the plugin definition, command registration, storage wiring,
// and the TTS idle path against a fake plugin context. The definition itself
// has no host import, so these run anywhere. One extra test verifies the
// module export consumed by OpenCode; it needs "@opencode/plugin/tui" (or a
// stub) under node_modules and is skipped otherwise.

import assert from "node:assert/strict";
import test from "node:test";

import { createPluginDefinition } from "../lib/plugin.js";

let moduleExport = null;
try {
  moduleExport = (await import("../index.js")).default;
} catch {
  // The OpenCode runtime provides "@opencode/plugin/tui"; plain Node needs a stub.
}

function createFakeContext(options = {}) {
  const store = {};
  const registered = [];
  const eventTypes = [];
  const unsubscribeCalls = [];
  const toasts = [];

  const context = {
    options,
    location: undefined,
    app: { version: "0.0.0", channel: "test" },
    client: {
      session: {
        create: async () => ({ id: "ses_test" }),
        prompt: async () => ({}),
        message: { get: async () => ({ content: [] }) },
      },
    },
    data: {
      on: (type, handler) => {
        assert.equal(typeof handler, "function");
        eventTypes.push(type);
        return () => unsubscribeCalls.push(type);
      },
      session: {
        list: () => [],
        get: () => undefined,
        message: { list: () => [] },
      },
      location: { default: () => ({ directory: process.cwd() }) },
    },
    keymap: {
      layer(factory) {
        const layer = factory();
        registered.push(...(layer.commands ?? []));
      },
    },
    storage: {
      store: () => [
        store,
        (mutation) => {
          mutation(store);
          return Promise.resolve();
        },
      ],
    },
    ui: {
      toast: { show: (toast) => toasts.push(toast) },
      dialog: {
        select: async () => undefined,
        prompt: async () => undefined,
        clear: () => {},
      },
      router: {
        current: () => ({ type: "session", sessionID: "ses_test" }),
        navigate: () => {},
      },
    },
    attention: { notify: async () => ({ ok: true }) },
    renderer: {},
    theme: {},
    themeMode: "dark",
    markdown: { registerCodeBlockRenderer: () => () => {} },
  };

  return { context, store, registered, eventTypes, unsubscribeCalls, toasts };
}

test(
  "index.js exports a V2 plugin definition",
  { skip: moduleExport ? false : "host module not resolvable" },
  () => {
    assert.equal(moduleExport.id, "opencode-voice");
    assert.equal(typeof moduleExport.setup, "function");
  },
);

test("definition registers every command and subscribes to TTS events", async () => {
  const { context, registered, eventTypes, unsubscribeCalls } = createFakeContext();
  const plugin = createPluginDefinition();
  const cleanup = await plugin.setup(context);

  const ids = registered.map((command) => command.id).sort();
  assert.deepEqual(ids, [
    "opencode-voice.cancel",
    "opencode-voice.language",
    "opencode-voice.mic",
    "opencode-voice.model",
    "opencode-voice.record",
    "opencode-voice.speak",
    "opencode-voice.submit",
    "opencode-voice.tts-stop",
    "opencode-voice.tts-toggle",
    "opencode-voice.tts-voice",
  ]);

  for (const command of registered) {
    assert.equal(typeof command.run, "function", `${command.id} has a run function`);
    assert.ok(command.slash?.name, `${command.id} keeps its slash command`);
    assert.ok(
      command.bind === undefined || command.bind === false || typeof command.bind === "string",
    );
  }

  assert.deepEqual(eventTypes.sort(), [
    "form.created",
    "permission.asked",
    "session.idle",
    "session.status",
  ]);

  assert.equal(typeof cleanup, "function");
  await cleanup();
  assert.equal(unsubscribeCalls.length, eventTypes.length);
});

test("selecting a model persists the choice through storage", async () => {
  const { context, store, registered } = createFakeContext();
  const plugin = createPluginDefinition();
  await plugin.setup(context);

  // The record keybind is the configured default.
  const record = registered.find((command) => command.id === "opencode-voice.record");
  assert.equal(record.bind, "ctrl+r");

  context.ui.dialog.select = async () => "tiny.en";
  const model = registered.find((command) => command.id === "opencode-voice.model");
  await model.run();
  assert.equal(store["stt.model"], "tiny.en");
});

test("auto TTS reacts to idle with the last assistant turn", async () => {
  const { context, store, toasts } = createFakeContext();
  const handlers = new Map();
  context.data.on = (type, handler) => {
    handlers.set(type, handler);
    return () => {};
  };
  context.data.session.message = {
    list: () => [
      { type: "user", id: "msg_user", text: "hello", time: { created: 1 } },
      {
        type: "assistant",
        id: "msg_assistant",
        content: [{ type: "text", text: "hello from the assistant" }],
        time: { created: 2 },
      },
    ],
  };

  const plugin = createPluginDefinition();
  await plugin.setup(context);
  store["tts.mode"] = "on";

  handlers.get("session.status")({ type: "session.status", data: { status: { type: "busy" } } });
  await handlers.get("session.idle")({ type: "session.idle", data: { sessionID: "ses_test" } });

  // Without an LLM endpoint the normalization fails; the handler must report
  // it instead of silently speaking.
  assert.ok(
    toasts.some((toast) => String(toast.message).includes("TTS normalization failed")),
    "idle handler reports normalization failure",
  );
});
