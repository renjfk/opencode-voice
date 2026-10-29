import assert from "node:assert/strict";
import test from "node:test";

import {
  canLiveReplace,
  createStreamingEditorAdapter,
  resolveStreamingSubmit,
} from "../lib/streaming-editor.js";

// Fake live target with range APIs.
function createLiveTarget({ text = "", selection = null, alive = true } = {}) {
  let current = text;
  const calls = [];
  return {
    calls,
    getText: () => current,
    setRange: (start, end, insert) => {
      calls.push(["setRange", start, end, insert]);
      current = current.slice(0, start) + insert + current.slice(end);
    },
    getSelection: selection ? () => ({ ...selection }) : undefined,
    isAlive: () => alive,
    submit: () => calls.push(["submit"]),
    insertText: (t) => {
      calls.push(["insert", t]);
      current += t;
    },
    text: () => current,
    kill() {
      alive = false;
    },
  };
}

function createInsertOnlyTarget() {
  const calls = [];
  return {
    calls,
    insertText: (t) => calls.push(["insert", t]),
    submit: () => calls.push(["submit"]),
  };
}

test("live target replaces only the dictated range, preserving surroundings", () => {
  const target = createLiveTarget({ text: "before  after" });
  // Cursor between "before " and " after": selection start=end=7.
  target.getSelection = () => ({ start: 7, end: 7 });
  const adapter = createStreamingEditorAdapter({});
  assert.deepEqual(adapter.begin(target), { ok: true, fallback: false });
  let r = adapter.applyPartial({ stableText: "", tentativeText: "hello" });
  assert.equal(r.status, "applied");
  assert.equal(target.text(), "before hello after");
  r = adapter.applyPartial({ stableText: "hello", tentativeText: "world" });
  assert.equal(r.status, "applied");
  assert.equal(target.text(), "before hello world after");
  // Only setRange calls, never a full rewrite claim beyond the owned range.
  for (const [kind, start, end] of target.calls) {
    assert.equal(kind, "setRange");
    assert.ok(start === 7 && end >= 7);
  }
  const fin = adapter.finalize("hello world coda");
  assert.equal(fin.inserted, true);
  assert.equal(target.text(), "before hello world coda after");
});

test("append-mode anchoring treats pre-existing text as prefix without selection API", () => {
  const target = createLiveTarget({ text: "existing" });
  delete target.getSelection;
  const adapter = createStreamingEditorAdapter({});
  assert.deepEqual(adapter.begin(target), { ok: true, fallback: false });
  adapter.applyPartial({ stableText: "", tentativeText: "dictated" });
  assert.equal(target.text(), "existingdictated");
});

test("focus move stops mutations, retains transcript, never redirects", () => {
  const a = createLiveTarget({ text: "" });
  const b = createLiveTarget({ text: "" });
  let focused = a;
  const adapter = createStreamingEditorAdapter({ getFocused: () => focused });
  adapter.begin(a);
  adapter.applyPartial({ stableText: "", tentativeText: "hello" });
  assert.equal(a.text(), "hello");
  focused = b; // user moved to another field
  const r = adapter.applyPartial({ stableText: "hello", tentativeText: "world" });
  assert.equal(r.status, "detached");
  assert.equal(r.reason, "focus-moved");
  assert.equal(a.text(), "hello"); // frozen, not extended
  assert.equal(b.text(), ""); // never redirected into the new field
  assert.equal(adapter.getTranscript(), "hello world");
  assert.equal(adapter.getState().detached, true);
});

test("closed target stops mutations and retains transcript", () => {
  const target = createLiveTarget({ text: "" });
  const adapter = createStreamingEditorAdapter({ getFocused: () => null });
  adapter.begin(target);
  adapter.applyPartial({ stableText: "", tentativeText: "hello" });
  const r = adapter.applyPartial({ stableText: "hello", tentativeText: "world" });
  assert.equal(r.status, "detached");
  assert.equal(adapter.getTranscript(), "hello world");
});

test("user edit inside the dictated range freezes live mutations", () => {
  const target = createLiveTarget({ text: "" });
  const adapter = createStreamingEditorAdapter({ getFocused: () => target });
  adapter.begin(target);
  adapter.applyPartial({ stableText: "", tentativeText: "hello world" });
  assert.equal(target.text(), "hello world");
  // User types inside the owned range (bypassing the adapter).
  target.calls.length = 0;
  const hacked = target.text().replace("world", "WORLD!!!");
  // Simulate by direct state change: rewrite via a raw setRange the adapter did not do.
  target.setRange(0, target.text().length, hacked);
  target.calls.length = 0;
  const r = adapter.applyPartial({ stableText: "hello world", tentativeText: "hello worldplus" });
  assert.equal(r.status, "detached");
  assert.equal(r.reason, "user-edit");
  assert.equal(target.calls.length, 0); // no further writes after detection
});

test("fallback path previews without writing; cancel removes nothing", () => {
  const seen = [];
  const target = createInsertOnlyTarget();
  const adapter = createStreamingEditorAdapter({
    toast: (msg) => seen.push(msg),
    getFocused: () => target,
  });
  const begun = adapter.begin(target);
  assert.equal(begun.ok, true);
  assert.equal(begun.fallback, true);
  const r = adapter.applyPartial({ stableText: "hello", tentativeText: "world" });
  assert.equal(r.status, "preview");
  assert.equal(target.calls.length, 0); // nothing written until finalize
  assert.ok(seen.length >= 1);
  const cancelled = adapter.cancel();
  assert.equal(cancelled.removedChars, 0);
  assert.equal(cancelled.fallback, true);
});

test("cancel removes only plugin-owned text, never user text", () => {
  const target = createLiveTarget({ text: "pre  post" });
  target.getSelection = () => ({ start: 4, end: 4 });
  const adapter = createStreamingEditorAdapter({ getFocused: () => target });
  adapter.begin(target);
  adapter.applyPartial({ stableText: "", tentativeText: "dictated words" });
  assert.equal(target.text(), "pre dictated words post");
  const out = adapter.cancel();
  assert.equal(out.removedChars, "dictated words".length);
  assert.equal(target.text(), "pre  post"); // surroundings restored exactly
});

test("submit resolves only via the captured target, never primary chat", () => {
  assert.deepEqual(resolveStreamingSubmit({ submit: () => {} }), {
    ok: true,
    via: "focused-submit",
  });
  assert.deepEqual(resolveStreamingSubmit({ insertText: () => {} }).ok, false);
  assert.deepEqual(resolveStreamingSubmit(null).ok, false);
});

test("targets without range APIs are never live-replaced", () => {
  assert.equal(canLiveReplace({ insertText: () => {} }), false);
  assert.equal(canLiveReplace(null), false);
  assert.equal(canLiveReplace({ getText: () => "", setRange: () => {} }), true);
});
