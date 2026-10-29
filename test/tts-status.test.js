import test from "node:test";
import assert from "node:assert/strict";
import {
  createTtsStatus,
  formatTtsStatus,
  fmtClock,
  nextRate,
  progressBar,
  statusSegments,
} from "../lib/tts-status.js";

function host(stateHolder, actions = {}) {
  const claims = [];
  const frames = [];
  const nodes = [];
  const ctx = {
    ui: {
      toast: { show() {} },
      slot: (claim) => {
        claims.push(claim);
        return () => claims.splice(claims.indexOf(claim), 1);
      },
    },
  };
  const runtime = {
    createElement: () => {
      const node = {};
      nodes.push(node);
      return node;
    },
    insertNode() {},
    setProp(node, key, value) {
      node[key] = value;
      if (key === "content") frames.push(value);
    },
  };
  const status = createTtsStatus(
    ctx,
    () => stateHolder.state,
    actions,
    async () => runtime,
  );
  const byContent = (text) => nodes.find((n) => n.content === text);
  return { ctx, claims, frames, nodes, byContent, status };
}

test("clock formats m:ss", () => {
  assert.equal(fmtClock(0), "0:00");
  assert.equal(fmtClock(65), "1:05");
  assert.equal(fmtClock(600), "10:00");
});

test("progress bar fills proportionally", () => {
  assert.equal(progressBar(0, 10, 4), "░░░░");
  assert.equal(progressBar(10, 10, 4), "████");
  assert.equal(progressBar(5, 10, 4), "████".slice(0, 2) + "░░");
  assert.equal(progressBar(0, 0, 4), "░░░░");
});

test("rate cycles 0.75x to 2x then wraps", () => {
  assert.equal(nextRate(1), 1.25);
  assert.equal(nextRate(2), 0.75);
  assert.equal(nextRate(0.5), 0.75);
});

test("status line shows buttons, clocks, bar, and always the speed", () => {
  const segs = statusSegments({ status: "playing", cursorSec: 7, totalSec: 42, rate: 1 });
  assert.deepEqual(
    segs.map((s) => [s.key, s.action]),
    [
      ["toggle", "toggle"],
      ["main", null],
      ["rw", "rewind"],
      ["ff", "forward"],
      ["rate", "rate"],
    ],
  );
  const line = formatTtsStatus({ status: "playing", cursorSec: 7, totalSec: 42, rate: 1 });
  assert.ok(line.startsWith("[⏸] 0:07 / 0:42 "), line);
  assert.ok(line.includes("[1x]"), "speed always visible for the cycle button");
  assert.ok(line.includes("[-5s]") && line.includes("[+5s]"));
  const paused = formatTtsStatus({ status: "paused", cursorSec: 7, totalSec: 42, rate: 1.5 });
  assert.ok(paused.startsWith("[▶]"), paused);
  assert.ok(paused.endsWith("[1.5x]"));
  assert.equal(formatTtsStatus(null), "");
});

test("loading state renders a single non-clickable line", () => {
  const segs = statusSegments({ status: "loading" });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].action, null);
  assert.match(formatTtsStatus({ status: "loading" }), /Loading voice/);
});

test("slot renders the line, updates on tick, clears on stop", async () => {
  const holder = { state: { status: "playing", cursorSec: 1, totalSec: 10, rate: 1 } };
  const pressed = [];
  const h = host(holder, {
    toggle: () => pressed.push("toggle"),
    rewind: () => pressed.push("rewind"),
    forward: () => pressed.push("forward"),
    rate: () => pressed.push("rate"),
  });
  await h.status.begin();
  assert.equal(h.claims.length, 2);
  for (const c of h.claims) c.render();
  assert.equal(h.status.nodes(), 5, "one text node per segment");
  assert.match(h.frames.at(-1), /\[1x\]$/);
  assert.ok(h.frames.some((f) => f.startsWith("[⏸]")));
  holder.state = { status: "paused", cursorSec: 2, totalSec: 10, rate: 1.5 };
  h.status.update();
  assert.ok(
    h.frames.some((f) => f === "[▶]"),
    "toggle glyph follows state",
  );
  assert.ok(
    h.frames.some((f) => f === "[1.5x]"),
    "rate follows state",
  );
  // No state change: no new frame (redraw is a no-op when unchanged).
  const before = h.frames.length;
  h.status.update();
  assert.equal(h.frames.length, before);
  h.status.clear();
  assert.equal(h.claims.length, 0);
  const frozen = h.frames.length;
  holder.state = { status: "playing", cursorSec: 9, totalSec: 10, rate: 1 };
  h.status.update();
  assert.equal(h.frames.length, frozen);
  assert.deepEqual(pressed, [], "test drives presses explicitly below");
});

test("buttons appear when loading finishes without a re-render", async () => {
  // Regression: the line used to mount a single node during loading and
  // never create the button nodes afterwards, leaving a bare clock+bar.
  const holder = { state: { status: "loading" } };
  const pressed = [];
  const h = host(holder, {
    toggle: () => pressed.push("toggle"),
    rewind: () => pressed.push("rewind"),
    forward: () => pressed.push("forward"),
    rate: () => pressed.push("rate"),
  });
  await h.status.begin();
  for (const c of h.claims) c.render();
  assert.ok(
    h.frames.some((f) => /Loading voice/.test(f)),
    "loading line mounts",
  );
  // Playback starts: the host does NOT call render again; update() must
  // fill the already-mounted button nodes in place.
  holder.state = { status: "playing", cursorSec: 1, totalSec: 10, rate: 1 };
  h.status.update();
  assert.ok(
    h.frames.some((f) => f === "[-5s]"),
    "rewind button fills in after loading",
  );
  assert.ok(
    h.frames.some((f) => f === "[⏸]"),
    "toggle fills in after loading",
  );
  assert.ok(
    h.frames.some((f) => f === "[1x]"),
    "rate fills in after loading",
  );
  h.byContent("[-5s]").onMouseUp();
  assert.deepEqual(pressed, ["rewind"], "late-filled button is clickable");
  h.status.clear();
});

test("button nodes carry click handlers that dispatch actions", async () => {
  const holder = { state: { status: "playing", cursorSec: 1, totalSec: 10, rate: 1 } };
  const pressed = [];
  const h = host(holder, {
    toggle: () => pressed.push("toggle"),
    rewind: () => pressed.push("rewind"),
    forward: () => pressed.push("forward"),
    rate: () => pressed.push("rate"),
  });
  await h.status.begin();
  for (const c of h.claims) c.render();
  // Each button segment is its own text node with exactly one action.
  h.byContent("[-5s]").onMouseUp();
  h.byContent("[+5s]").onMouseUp();
  h.byContent("[1x]").onMouseUp();
  h.byContent("[⏸]").onMouseUp();
  assert.deepEqual(pressed, ["rewind", "forward", "rate", "toggle"]);
  // The static clock/bar segment has no click handler.
  const main = h.nodes.find((n) => typeof n.content === "string" && n.content.includes("/ 0:10"));
  assert.equal(typeof main.onMouseUp, "undefined");
  h.status.clear();
});

test("begin cancelled during runtime import never mounts stale UI", async () => {
  const h = host({ state: null });
  let loaded;
  const status = createTtsStatus(
    h.ctx,
    () => null,
    {},
    () =>
      new Promise((resolve) => {
        loaded = resolve;
      }),
  );
  const started = status.begin();
  status.clear();
  loaded({});
  assert.equal(await started, false);
  assert.equal(h.claims.length, 0);
});
