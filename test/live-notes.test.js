import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { registerLiveNotes } from "../lib/live-notes.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function makeKv() {
  const store = new Map();
  return {
    get: (k, d) => (store.has(k) ? store.get(k) : d),
    set: (k, v) => store.set(k, v),
  };
}

// Deterministic SoX stand-in: never emits audio, exits cleanly on kill, and
// lets the test fire process events on demand. No mic, no ports.
function makeSox() {
  const handlers = {};
  const proc = {
    pid: 424242,
    killSig: null,
    stdout: { on() {} },
    stderr: { on() {} },
    on: (ev, fn) => {
      (handlers[ev] ??= []).push(fn);
    },
    kill: (sig) => {
      proc.killSig = sig;
      for (const fn of handlers.exit || []) fn(0);
    },
  };
  return {
    proc,
    fire: (ev, ...args) => {
      for (const fn of handlers[ev] || []) fn(...args);
    },
  };
}

function makeHarness(spawnFake) {
  const toasts = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-live-notes-test-"));
  const api = {
    state: { path: { directory: dir } },
    ui: {
      toast: (input) => toasts.push(input?.message ?? input),
    },
    lifecycle: {},
  };
  const deps = {
    tts: { setLiveNotesActive() {}, stop() {} },
    spawn: () => spawnFake.proc,
  };
  const opts = {
    notesDir: "voice-notes",
    notesNormalize: false,
    notesEnhance: false,
    notesUseWhisperServer: false,
  };
  const { commands, controller } = registerLiveNotes(
    api,
    makeKv(),
    async () => ({ text: null }),
    opts,
    null,
    deps,
  );
  const byValue = Object.fromEntries(commands.map((c) => [c.value, c]));
  return { dir, toasts, controller, byValue };
}

test("stop claims the drain before the first await; a concurrent start is refused", async () => {
  const sox = makeSox();
  const h = makeHarness(sox);
  try {
    h.byValue["voice.notes.start"].onSelect();
    await tick(20);
    assert.equal(h.controller.isActive(), true);
    // The stop drain begins (async, not awaited); a start racing it must see
    // `finishing` and back off instead of replacing the writer mid-drain.
    h.byValue["voice.notes.stop"].onSelect();
    h.byValue["voice.notes.start"].onSelect();
    await tick(500);
    assert.equal(
      h.toasts.filter((t) => t.includes("Live notes started")).length,
      1,
      `toasts=${JSON.stringify(h.toasts)}`,
    );
    assert.ok(h.toasts.some((t) => t.includes("still saving")));
    const mdFiles = fs
      .readdirSync(path.join(h.dir, "voice-notes"))
      .filter((f) => f.endsWith(".md"));
    assert.equal(mdFiles.length, 1);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("async sox spawn error ends in a saved session, not a phantom recording", async () => {
  const sox = makeSox();
  const h = makeHarness(sox);
  try {
    h.byValue["voice.notes.start"].onSelect();
    await tick(20);
    assert.equal(h.controller.isActive(), true);
    sox.fire("error", new Error("spawn sox ENOENT"));
    await tick(500);
    // Same stop/save path as an unexpected exit: inactive + file saved.
    assert.equal(h.controller.isActive(), false);
    assert.ok(h.toasts.some((t) => t.includes("microphone failed")));
    const mdFiles = fs
      .readdirSync(path.join(h.dir, "voice-notes"))
      .filter((f) => f.endsWith(".md"));
    assert.equal(mdFiles.length, 1);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});
