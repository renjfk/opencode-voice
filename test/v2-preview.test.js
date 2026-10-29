import test from "node:test";
import assert from "node:assert/strict";
import { createV2Preview } from "../lib/v2-preview.js";
import { adaptV2Context } from "../lib/v2-compat.js";
import { registerSTT } from "../lib/stt.js";

const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
};

function host() {
  const claims = [];
  const effects = [];
  const frames = [];
  const prompts = [];
  const disposes = [];
  const created = [];
  let route = { type: "home" };
  const ctx = {
    client: {
      session: {
        create: async () => ({ id: "new-live-session" }),
        prompt: async (input) => {
          prompts.push(input);
        },
      },
    },
    ui: {
      router: {
        current: () => route,
        navigate: (next) => {
          route = next;
        },
      },
      toast: { show() {} },
      dialog: { alert() {} },
      slot: (claim) => {
        claims.push(claim);
        return () => claims.splice(claims.indexOf(claim), 1);
      },
    },
    renderer: { currentFocusedRenderable: null },
    storage: { store: () => [{ values: {} }, () => {}] },
  };
  const runtime = {
    createSignal(initial) {
      let value = initial;
      return [
        () => value,
        (next) => {
          value = next;
          for (const effect of effects) effect();
        },
      ];
    },
    createElement: () => {
      const node = {};
      created.push(node);
      return node;
    },
    insertNode() {},
    insert(node, value) {
      node.content = value;
      frames.push(value);
      return value;
    },
    setProp(node, key, value) {
      node[key] = value;
      if (key === "content") frames.push(value);
    },
    createEffect(fn) {
      effects.push(fn);
      fn();
    },
  };
  const adapted = adaptV2Context(ctx);
  adapted.api.voicePreview = createV2Preview(ctx, async () => runtime);
  adapted.api.lifecycle.onDispose(() => adapted.api.voicePreview.clear());
  return { ctx, claims, created, frames, prompts, disposes, adapted };
}

test("v2 slot preview distinguishes stable/tentative, bounds display, clears claims", async () => {
  const h = host();
  const preview = h.adapted.api.voicePreview;
  await preview.begin();
  assert.deepEqual(
    h.claims.map((c) => c.after || c.before),
    ["session.composer.top", "home.footer"],
  );
  for (const c of h.claims) c.render();
  preview.applyPartial({ stableText: "confirmed words", tentativeText: "uncertain tail" });
  assert.ok(
    h.frames.some((f) => /confirmed words \[uncertain tail\]/.test(f)),
    "body segment shows the transcript",
  );
  preview.applyLevels([0, 1, 2, 3, 4, 5, 6, 7, 7, 6, 5, 4, 3, 2, 1, 0]);
  assert.ok(
    h.frames.some((f) => /^▁▂▃▄▅▆▇██▇▆▅▄▃▂▁  /.test(f)),
    "wave bars render",
  );
  assert.ok(
    h.frames.some((f) => /Voice live · confirmed words/.test(f)),
    "body segment shows the transcript",
  );
  preview.applyPartial({ stableText: "long ".repeat(800), tentativeText: "tail" });
  assert.ok(h.frames.at(-1).length <= 1600);
  assert.ok(preview.getTranscript().length > 1600, "full final text is never truncated");
  preview.cancel();
  assert.equal(h.claims.length, 0);
  const before = h.frames.length;
  preview.applyPartial({ stableText: "late" });
  preview.applyLevels([7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7]);
  assert.equal(h.frames.length, before);
  h.adapted.cleanup();
});

test("v2 preview wave timer redraws with levels and stops on clear", async () => {
  const h = host();
  const preview = h.adapted.api.voicePreview;
  await preview.begin();
  for (const c of h.claims) c.render();
  preview.startWave(() => [7, 6, 5, 4, 3, 2, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7], 20);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(
    h.frames.some((frame) => frame.startsWith("█▇▆▅▄▃▂▁▁▂▃▄▅▆▇█")),
    "wave bars render",
  );
  assert.ok(
    h.frames.some((frame) => frame.includes("Voice live")),
    "transcript renders",
  );
  preview.clear();
  const before = h.frames.length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(h.frames.length, before, "clear stops the wave timer");
  assert.equal(h.claims.length, 0);
  h.adapted.cleanup();
});

test("v2 preview cancelled during runtime import never mounts stale UI", async () => {
  const h = host();
  let loaded;
  const preview = createV2Preview(
    h.ctx,
    () =>
      new Promise((resolve) => {
        loaded = resolve;
      }),
  );
  const started = preview.begin();
  preview.clear();
  loaded({});
  assert.equal(await started, false);
  assert.equal(h.claims.length, 0);
  h.adapted.cleanup();
});

test("v2 real streaming controller previews partials and inserts final once, never prompts", async () => {
  const h = host();
  const inserted = [];
  const submitted = [];
  h.ctx.renderer.currentFocusedRenderable = {
    insertText: (text) => inserted.push(text),
    submit: () => submitted.push(1),
  };
  const scheduled = new Map();
  let id = 0;
  const clock = {
    setTimeout(fn) {
      scheduled.set(++id, fn);
      return id;
    },
    clearTimeout(key) {
      scheduled.delete(key);
    },
  };
  const capture = {
    start() {},
    snapshot: () => ({ wav: Buffer.from("snapshot"), durationMs: 1000 }),
    stopFinal: async () => ({ wav: Buffer.from("final"), durationMs: 1000 }),
    cancel: async () => {},
    dispose: async () => {},
  };
  const script = ["hello tentative", "hello stable next", "final complete text"];
  const transcriber = {
    ensureReady: async () => ({ ready: true }),
    transcribe: async () => ({ text: script.shift() || "late cancelled words" }),
    dispose() {},
    describe: () => ({ modelPath: "fake", language: "en" }),
  };
  const stt = registerSTT(
    h.adapted.api,
    h.adapted.api.kv,
    async () => {
      throw new Error("No LLM in streaming");
    },
    {},
    {},
    { log() {} },
    {
      streamingControllerOpts: {
        captureFactory: () => capture,
        transcriberFactory: () => transcriber,
        clock,
      },
    },
  );
  assert.equal(await stt.controller.startStreaming(), true);
  await flush();
  for (const c of h.claims) c.render();
  const tick = async () => {
    const [key, fn] = scheduled.entries().next().value;
    scheduled.delete(key);
    fn();
    await flush();
  };
  await tick();
  assert.match(h.frames.at(-1), /hello tentative/);
  await tick();
  assert.match(h.frames.at(-1), /hello/);
  assert.equal(h.prompts.length, 0, "partials never submit");
  const first = stt.controller.finalizeStreaming();
  const second = stt.controller.finalizeStreaming();
  await Promise.all([first, second]);
  assert.equal(h.prompts.length, 0, "dictation never sends a prompt");
  assert.equal(inserted.length, 1, "final text inserted exactly once");
  assert.match(inserted[0], /final complete text/);
  assert.equal(submitted.length, 0, "plain dictation never submits");
  assert.equal(h.claims.length, 0);
  assert.equal(await stt.controller.startStreaming(), true);
  await flush();
  await tick();
  await stt.controller.cancelStreaming();
  assert.equal(h.claims.length, 0);
  assert.equal(h.prompts.length, 0);
  assert.equal(inserted.length, 1, "cancel inserts nothing");
  h.adapted.cleanup();
  await flush();
  assert.equal(scheduled.size, 0);
});

for (const dispose of [false, true]) {
  test(`v2 streaming ${dispose ? "dispose" : "cancel"} while stop-tail awaits never inserts or submits`, async () => {
    const h = host();
    let resolvePending;
    let released = 0;
    let creates = 0;
    const inserted = [];
    h.ctx.renderer.currentFocusedRenderable = {
      insertText: (text) => inserted.push(text),
      submit: () => {},
    };
    h.ctx.client.session.create = () => {
      creates += 1;
      return new Promise((resolve) => {
        resolvePending = resolve;
      });
    };
    const capture = {
      start() {},
      snapshot: () => null,
      stopFinal: async () => ({ wav: Buffer.from("final"), durationMs: 1000 }),
      cancel: async () => {},
      dispose: async () => {},
    };
    const transcriber = {
      ensureReady: async () => ({ ready: true }),
      transcribe: () =>
        new Promise((resolve) => {
          resolvePending = resolve;
        }),
      dispose() {
        released += 1;
      },
      describe: () => ({ modelPath: "fake", language: "en" }),
    };
    const stt = registerSTT(
      h.adapted.api,
      h.adapted.api.kv,
      async () => ({}),
      {},
      {},
      { log() {} },
      {
        streamingControllerOpts: {
          captureFactory: () => capture,
          transcriberFactory: () => transcriber,
        },
      },
    );
    assert.equal(await stt.controller.startStreaming(), true);
    await flush();
    const final = stt.controller.finalizeStreaming();
    await flush();
    assert.equal(typeof resolvePending, "function");
    if (dispose) h.adapted.cleanup();
    else await stt.controller.cancelStreaming();
    resolvePending({ text: "late final text" });
    await final;
    await flush();
    assert.equal(h.prompts.length, 0);
    assert.equal(creates, 0, "streaming never creates a home session");
    assert.equal(inserted.length, 0, "cancelled/disposed dictation inserts nothing");
    assert.equal(h.claims.length, 0);
    assert.equal(stt.controller.isProcessing(), false);
    assert.ok(released > 0, "stale controller lease released");
    h.adapted.cleanup();
  });
}

test("v2 preview toggle button dispatches the wired action and reflects pause", async () => {
  const h = host();
  const preview = h.adapted.api.voicePreview;
  let toggles = 0;
  preview.setToggleAction(() => {
    toggles += 1;
  });
  await preview.begin();
  for (const c of h.claims) c.render();
  preview.applyPartial({ stableText: "hello" });
  preview.setPaused(false);
  const toggleNode = h.created.find((n) => n.content === "[⏸]");
  assert.ok(toggleNode, "toggle node renders pause glyph while live");
  assert.equal(typeof toggleNode.onMouseUp, "function", "toggle is clickable");
  toggleNode.onMouseUp();
  assert.equal(toggles, 1, "click dispatches the wired toggle action");
  preview.setPaused(true);
  assert.ok(
    h.created.some((n) => n.content === "[▶]"),
    "toggle flips to resume glyph when paused",
  );
  assert.ok(
    h.frames.some((f) => /hello/.test(f)),
    "transcript body survives the pause flip",
  );
  preview.setPaused(false);
  assert.ok(
    h.created.some((n) => n.content === "[⏸]"),
    "toggle flips back on resume",
  );
  h.adapted.cleanup();
});

test("v2 record key resumes a paused session instead of finalizing", async () => {
  const h = host();
  h.ctx.renderer.currentFocusedRenderable = {
    insertText: () => {},
    submit: () => {},
  };
  const inserted = [];
  h.ctx.renderer.currentFocusedRenderable.insertText = (text) => inserted.push(text);
  const scheduled = new Map();
  let id = 0;
  const clock = {
    setTimeout(fn) {
      scheduled.set(++id, fn);
      return id;
    },
    clearTimeout(key) {
      scheduled.delete(key);
    },
  };
  const capture = {
    start() {},
    snapshot: () => ({ wav: Buffer.from("snapshot"), durationMs: 1000 }),
    stopFinal: async () => ({ wav: Buffer.from("final"), durationMs: 1000 }),
    cancel: async () => {},
    dispose: async () => {},
  };
  const transcriber = {
    ensureReady: async () => ({ ready: true }),
    transcribe: async () => ({ text: "spoken words here" }),
    dispose() {},
    describe: () => ({ modelPath: "fake", language: "en" }),
  };
  const stt = registerSTT(
    h.adapted.api,
    h.adapted.api.kv,
    async () => {
      throw new Error("No LLM in streaming");
    },
    {},
    { sttMode: "streaming" },
    { log() {} },
    {
      streamingControllerOpts: {
        captureFactory: () => capture,
        transcriberFactory: () => transcriber,
        clock,
      },
    },
  );
  const record = stt.commands.find((c) => c.value === "stt.record");
  const pauseCmd = stt.commands.find((c) => c.value === "stt.pause");
  assert.ok(record && pauseCmd, "record and pause commands registered");
  await stt.controller.startStreaming();
  await flush();
  for (const c of h.claims) c.render();
  pauseCmd.onSelect();
  await flush();
  assert.ok(
    h.created.some((n) => n.content === "[▶]"),
    "pause flips the preview toggle to resume",
  );
  // Record key while paused resumes instead of finalizing (no insert yet).
  record.onSelect();
  await flush();
  assert.deepEqual(inserted, [], "resume does not finalize or insert");
  await stt.controller.finalizeStreaming();
  await flush();
  assert.ok(inserted.length > 0, "explicit finalize still inserts after resume");
  h.adapted.cleanup();
  await flush();
});
