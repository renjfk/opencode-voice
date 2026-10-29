import assert from "node:assert/strict";
import test from "node:test";

import {
  createRollingPcmBuffer,
  createServerTranscriber,
  createStreamingController,
} from "../lib/streaming-stt.js";

// ---- Fakes: manual clock, scripted capture/transcriber, no processes ----

function createManualClock() {
  let nextId = 1;
  const pending = new Map();
  return {
    pending,
    setTimeout(fn) {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    pendingCount() {
      return pending.size;
    },
    fireNext() {
      const [id, fn] = pending.entries().next().value || [];
      if (id === undefined) return false;
      pending.delete(id);
      fn();
      return true;
    },
  };
}

async function flushAsync(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

function wavMarker(text) {
  return Buffer.from(`WAV:${text}`);
}

function createFakeCapture({ finalWav = wavMarker("final") } = {}) {
  return {
    started: 0,
    snapshots: 0,
    stopFinalCalls: 0,
    cancelled: 0,
    disposed: 0,
    snapshotWav: wavMarker("snap"),
    start() {
      this.started += 1;
    },
    snapshot() {
      this.snapshots += 1;
      return { wav: this.snapshotWav, durationMs: 1000 };
    },
    async stopFinal() {
      this.stopFinalCalls += 1;
      return { wav: finalWav, durationMs: 2000 };
    },
    async cancel() {
      this.cancelled += 1;
    },
    async dispose() {
      this.disposed += 1;
    },
  };
}

// Script entries: { text } | { error, code } | { never: true }.
function createFakeTranscriber(script = [], { readyResult = { ready: true } } = {}) {
  const calls = [];
  let cursor = 0;
  const pending = [];
  const tx = {
    calls,
    pending,
    ensureReadyCalls: 0,
    disposeCalls: 0,
    readyResult,
    async ensureReady() {
      this.ensureReadyCalls += 1;
      await Promise.resolve();
      return this.readyResult;
    },
    transcribe(wav, opts) {
      calls.push({ wav, signal: opts?.signal });
      const entry = cursor < script.length ? script[cursor++] : script.at(-1);
      if (!entry || entry.never) {
        let resolve;
        const promise = new Promise((r) => {
          resolve = r;
        });
        pending.push({ resolve, wav, signal: opts?.signal });
        return promise;
      }
      if (entry.error) return Promise.resolve({ error: entry.error, code: entry.code });
      return Promise.resolve({ text: entry.text });
    },
    dispose() {
      this.disposeCalls += 1;
    },
    describe: () => ({ modelPath: "/m.bin", language: "en" }),
  };
  return tx;
}

function createHarness({ capture, transcriber, script, readyResult, controllerOpts = {} } = {}) {
  const clock = createManualClock();
  const cap = capture || createFakeCapture();
  const tx = transcriber || createFakeTranscriber(script, { readyResult });
  const events = { partials: [], finals: [], states: [], errors: [] };
  const controller = createStreamingController({
    captureFactory: () => cap,
    transcriberFactory: () => tx,
    clock,
    cadenceMs: 1000,
    stopDrainTimeoutMs: 20,
    ...controllerOpts,
    onPartial: (p) => events.partials.push(p),
    onFinal: (f) => events.finals.push(f),
    onStateChange: (s) => events.states.push(s),
    onError: (e) => events.errors.push(e),
  });
  return { clock, cap, tx, events, controller };
}

// Start and run until the first snapshot transcribe resolves.
async function startAndSettle(h) {
  assert.equal(h.controller.start(), true);
  await flushAsync();
  assert.equal(h.controller.getState().status, "streaming");
}

test("cold start captures before readiness so initial speech is kept", async () => {
  let releaseReady;
  const readyGate = new Promise((r) => {
    releaseReady = r;
  });
  const cap = createFakeCapture();
  const tx = createFakeTranscriber([{ text: "hello" }]);
  tx.ensureReady = async () => {
    tx.ensureReadyCalls += 1;
    await readyGate;
    return { ready: true };
  };
  const clock = createManualClock();
  const controller = createStreamingController({
    captureFactory: () => cap,
    transcriberFactory: () => tx,
    clock,
    cadenceMs: 1000,
    stopDrainTimeoutMs: 20,
    onPartial: () => {},
  });
  assert.equal(controller.start(), true);
  await flushAsync();
  // Capture is already buffering while the model still loads...
  assert.equal(cap.started, 1);
  assert.equal(controller.getState().status, "starting");
  assert.equal(tx.ensureReadyCalls, 1);
  assert.equal(cap.snapshots, 0); // ...but nothing is transcribed yet
  releaseReady();
  await flushAsync();
  assert.equal(controller.getState().status, "streaming");
  clock.fireNext(); // first tick snapshots audio buffered since t=0
  await flushAsync();
  assert.equal(cap.snapshots, 1);
  assert.equal(tx.calls.length, 1);
  await controller.dispose();
});

test("controller peekPcm exposes the newest capture tail for the live wave", async () => {
  const cap = createFakeCapture();
  const tail = Buffer.from([1, 0, 2, 0, 3, 0]);
  cap.peekTail = (nBytes) => tail.subarray(0, Math.min(nBytes, tail.length));
  const h = createHarness({ capture: cap, script: [{ text: "hello" }] });
  await startAndSettle(h);
  assert.deepEqual(h.controller.peekPcm(4), Buffer.from([1, 0, 2, 0]));
  delete cap.peekTail;
  assert.equal(h.controller.peekPcm(4), null);
  await h.controller.dispose();
});

test("evolving partials stabilize the prefix and replace the tail", async () => {
  const h = createHarness({
    script: [{ text: "hello world" }, { text: "hello world this is" }],
  });
  await startAndSettle(h);
  h.clock.fireNext();
  await flushAsync();
  h.clock.fireNext();
  await flushAsync();
  const last = h.events.partials.at(-1);
  assert.equal(last.stableText, "hello world");
  assert.equal(last.tentativeText, "this is");
  // No duplication: stable + tentative reconstructs the hypothesis once.
  assert.equal(`${last.stableText} ${last.tentativeText}`.trim(), "hello world this is");
  await h.controller.dispose();
});

test("slow inference coalesces to newest audio with exactly one in flight", async () => {
  const h = createHarness({ script: [{ never: true }] });
  await startAndSettle(h);
  h.clock.fireNext(); // tick 1 -> transcribe starts, never resolves
  await flushAsync();
  assert.equal(h.tx.calls.length, 1);
  assert.equal(h.clock.pendingCount(), 1); // cadence stays armed during decode
  // Five more ticks while busy: no new requests, nothing queued.
  for (let i = 0; i < 5; i++) {
    h.clock.fireNext();
    await flushAsync();
  }
  assert.equal(h.tx.calls.length, 1);
  assert.equal(h.clock.pendingCount(), 0);
  // Resolving the slow request immediately schedules the newest snapshot.
  h.tx.pending[0].resolve({ text: "hello" });
  await flushAsync();
  assert.equal(h.clock.pendingCount(), 1);
  const snapshotsBefore = h.cap.snapshots;
  h.clock.fireNext();
  await flushAsync();
  assert.equal(h.cap.snapshots, snapshotsBefore + 1);
  assert.equal(h.tx.calls.length, 2);
  await h.controller.dispose();
});

test("stop captures the SoX tail, commits it, and keeps the server loaded", async () => {
  const h = createHarness({
    capture: createFakeCapture({ finalWav: wavMarker("tail hello world coda") }),
    script: [{ text: "hello world" }, { text: "hello world coda" }],
  });
  await startAndSettle(h);
  h.clock.fireNext();
  await flushAsync();
  const done = await h.controller.stop();
  assert.equal(h.cap.stopFinalCalls, 1);
  assert.equal(done.text, "hello world coda");
  assert.equal(h.events.finals.length, 1);
  assert.equal(h.events.finals[0].text, "hello world coda");
  assert.equal(h.controller.getState().status, "idle");
  // Server stays loaded: no teardown, and a new dictation reuses it.
  assert.equal(h.tx.disposeCalls, 0);
  const readyBefore = h.tx.ensureReadyCalls;
  assert.equal(h.controller.start(), true);
  await flushAsync();
  assert.equal(h.controller.getState().status, "streaming");
  assert.equal(h.tx.ensureReadyCalls, readyBefore + 1); // idempotent re-check
  assert.equal(h.tx.disposeCalls, 0);
  await h.controller.dispose();
});

test("stop with a stuck in-flight request is bounded and drops the late response", async () => {
  const h = createHarness({
    capture: createFakeCapture({ finalWav: wavMarker("final words") }),
    script: [{ never: true }],
    controllerOpts: { stopDrainTimeoutMs: 20 },
  });
  // Final-tail transcription resolves normally.
  h.tx.transcribe = function (wav) {
    this.calls.push(wav);
    if (this.calls.length === 1) {
      let resolve;
      const promise = new Promise((r) => {
        resolve = r;
      });
      this.pending.push({ resolve, wav });
      return promise;
    }
    return Promise.resolve({ text: "final words" });
  };
  await startAndSettle(h);
  h.clock.fireNext(); // stuck snapshot request
  await flushAsync();
  assert.equal(h.tx.calls.length, 1);
  const t0 = Date.now();
  const done = await h.controller.stop();
  assert.ok(Date.now() - t0 < 2000, "stop must not wait for the stuck request");
  assert.equal(done.text, "final words");
  // The stuck request resolves late: ignored, never surfaced as partial.
  const partialsBefore = h.events.partials.length;
  h.tx.pending[0].resolve({ text: "stale stale stale" });
  await flushAsync();
  assert.equal(h.events.partials.length, partialsBefore);
  await h.controller.dispose();
});

test("cancel is prompt, bounded, and invalidates late responses", async () => {
  const h = createHarness({ script: [{ never: true }] });
  await startAndSettle(h);
  h.clock.fireNext();
  await flushAsync();
  assert.equal(h.tx.calls.length, 1);
  assert.equal(await h.controller.cancel(), true);
  assert.equal(h.controller.getState().status, "idle");
  assert.equal(h.cap.cancelled, 1);
  assert.deepEqual(h.events.states, ["starting", "streaming", "cancelled", "idle"]);
  // Late resolution after cancel: dropped silently.
  h.tx.pending[0].resolve({ text: "late words" });
  await flushAsync();
  assert.equal(h.events.partials.length, 0);
  await h.controller.dispose();
});

test("transcribe failure is explicit, preserves fallback audio, never silently falls back", async () => {
  const h = createHarness({
    script: [{ error: "Port 8090 already answers", code: "PORT_IN_USE" }],
  });
  await startAndSettle(h);
  h.clock.fireNext();
  await flushAsync();
  assert.equal(h.controller.getState().status, "error");
  assert.equal(h.events.errors.length, 1);
  assert.equal(h.events.errors[0].code, "PORT_IN_USE");
  assert.equal(h.events.errors[0].hasFallbackAudio, true);
  assert.ok(h.controller.getFallbackAudio() instanceof Buffer);
  // Recovery = a fresh start: exactly one more attempt per tick, no hot loop.
  assert.equal(h.tx.calls.length, 1);
  assert.equal(h.clock.pendingCount(), 0);
  await h.controller.dispose();
});

test("missing server at startup errors explicitly with t=0 audio preserved", async () => {
  const h = createHarness({
    readyResult: { ready: false, error: { code: "PORT_IN_USE", message: "owned by another" } },
  });
  assert.equal(h.controller.start(), true);
  await flushAsync();
  assert.equal(h.controller.getState().status, "error");
  assert.equal(h.events.errors[0].code, "PORT_IN_USE");
  assert.equal(h.cap.started, 1); // capture ran from t=0...
  assert.equal(h.cap.stopFinalCalls, 1); // ...and its audio was preserved
  assert.ok(h.controller.getFallbackAudio() instanceof Buffer);
  await h.controller.dispose();
});

test("setModel is refused mid-dictation and tears down when idle", async () => {
  const h = createHarness({ script: [{ text: "hi" }] });
  await startAndSettle(h);
  assert.equal(h.controller.setModel({ modelPath: "/other.bin", language: "en" }), false);
  assert.equal(h.tx.disposeCalls, 0);
  await h.controller.cancel();
  assert.equal(h.controller.setModel({ modelPath: "/other.bin", language: "en" }), true);
  assert.equal(h.tx.disposeCalls, 1);
  assert.deepEqual(h.controller.getState().model, { modelPath: "/other.bin", language: "en" });
  await h.controller.dispose();
});

test("stop stops the mic before draining a stuck request, final stays serialized", async () => {
  const h = createHarness({
    capture: createFakeCapture({ finalWav: wavMarker("final words") }),
    script: [{ never: true }],
  });
  h.tx.transcribe = function (wav, opts) {
    this.calls.push({ wav, signal: opts?.signal });
    if (this.calls.length === 1) {
      let resolve;
      const promise = new Promise((r) => {
        resolve = r;
      });
      this.pending.push({ resolve, wav, signal: opts?.signal });
      return promise;
    }
    return Promise.resolve({ text: "final words" });
  };
  await startAndSettle(h);
  h.clock.fireNext(); // stuck snapshot request
  await flushAsync();
  assert.equal(h.tx.calls.length, 1);
  const p = h.controller.stop();
  await flushAsync(2);
  // Mic stopped promptly (not after the 5s-style drain): stopFinal ran while
  // the old request was still stuck, and the final transcription has not
  // started concurrently with it.
  assert.equal(h.cap.stopFinalCalls, 1);
  assert.equal(h.tx.calls.length, 1);
  const done = await p;
  assert.equal(done.text, "final words");
  // Exactly one more request (the serialized final), carrying an AbortSignal.
  assert.equal(h.tx.calls.length, 2);
  assert.ok(h.tx.calls[1].signal instanceof AbortSignal);
  assert.equal(h.events.finals.length, 1);
  await h.controller.dispose();
});

test("concurrent stop calls share one finalization", async () => {
  const h = createHarness({
    capture: createFakeCapture({ finalWav: wavMarker("tail hello") }),
    script: [{ text: "hello" }],
  });
  // Final-tail transcription resolves normally.
  h.tx.transcribe = function (wav, opts) {
    this.calls.push({ wav, signal: opts?.signal });
    return Promise.resolve({ text: "tail hello" });
  };
  await startAndSettle(h);
  const [a, b] = await Promise.all([h.controller.stop(), h.controller.stop()]);
  assert.equal(h.cap.stopFinalCalls, 1);
  assert.equal(a.text, "tail hello");
  assert.equal(b.text, "tail hello");
  assert.equal(h.events.finals.length, 1);
  await h.controller.dispose();
});

test("stop during cold start with an unready model fails explicitly, never silently empty", async () => {
  const h = createHarness({
    capture: createFakeCapture({ finalWav: wavMarker("t-zero speech") }),
    controllerOpts: { stopReadyTimeoutMs: 30, stopFinalTimeoutMs: 50 },
  });
  const tx = createFakeTranscriber([{ text: "never used" }]);
  let releaseReady = null;
  tx.ensureReady = () =>
    new Promise((r) => {
      releaseReady = () => r({ ready: true });
    });
  const h2 = createHarness({
    capture: h.cap,
    transcriber: tx,
    controllerOpts: { stopReadyTimeoutMs: 30 },
  });
  assert.equal(h2.controller.start(), true);
  await flushAsync();
  assert.equal(h2.controller.getState().status, "starting");
  const done = await h2.controller.stop();
  // Mic stopped promptly; bounded wait expired; explicit recoverable error.
  assert.equal(h2.cap.stopFinalCalls, 1);
  assert.equal(h2.controller.getState().status, "error");
  assert.equal(h2.events.errors.length, 1);
  assert.equal(h2.events.errors[0].code, "STOP_NOT_READY");
  assert.equal(h2.events.errors[0].recoverable, true);
  assert.equal(done.error.code, "STOP_NOT_READY");
  // t=0 audio preserved for batch fallback, honestly described: the scripted
  // capture reports no coverage, so the controller marks it unverified
  // rather than claiming a complete recording.
  assert.ok(h2.controller.getFallbackAudio() instanceof Buffer);
  assert.equal(h2.controller.getFallbackCoverage().complete, false);
  assert.ok(h2.controller.getFallbackCoverage().message.includes("NOT verified"));
  assert.equal(h2.events.finals.length, 0); // no silent empty success
  releaseReady?.();
  await h2.controller.dispose();
});

test("stop during cold start finalizes normally once readiness lands", async () => {
  const cap = createFakeCapture({ finalWav: wavMarker("tail words") });
  const tx = createFakeTranscriber([{ text: "tail words" }]);
  let releaseReady;
  const readyGate = new Promise((r) => {
    releaseReady = r;
  });
  tx.ensureReady = async () => {
    await readyGate;
    return { ready: true };
  };
  const h = createHarness({
    capture: cap,
    transcriber: tx,
    controllerOpts: { stopReadyTimeoutMs: 5000 },
  });
  assert.equal(h.controller.start(), true);
  await flushAsync();
  assert.equal(h.controller.getState().status, "starting");
  const p = h.controller.stop();
  await flushAsync(2);
  releaseReady();
  const done = await p;
  // One capture stop only: the cold-start tail is reused, never re-stopped.
  assert.equal(cap.stopFinalCalls, 1);
  assert.equal(done.text, "tail words");
  assert.equal(h.events.finals.length, 1);
  assert.equal(h.controller.getState().status, "idle");
  await h.controller.dispose();
});

test("cancel plus immediate restart: the old request cannot clobber the new session", async () => {
  const h = createHarness({ script: [{ never: true }, { text: "new words" }] });
  await startAndSettle(h);
  h.clock.fireNext(); // old request starts, never resolves
  await flushAsync();
  assert.equal(h.tx.calls.length, 1);
  assert.equal(await h.controller.cancel(), true);
  // The physical request was aborted: no overlapping inference on restart.
  assert.equal(h.tx.calls[0].signal instanceof AbortSignal, true);
  assert.equal(h.tx.calls[0].signal.aborted, true);
  // Immediate restart: a new session with its own request.
  assert.equal(h.controller.start(), true);
  await flushAsync();
  assert.equal(h.controller.getState().status, "streaming");
  h.clock.fireNext();
  await flushAsync();
  assert.equal(h.tx.calls.length, 2);
  assert.equal(h.tx.calls[1].signal.aborted, false);
  assert.equal(h.events.partials.length, 1);
  assert.equal(h.events.partials[0].tentativeText, "new words");
  // The old request settles late with conflicting text: dropped, and the
  // new session's in-flight bookkeeping is untouched.
  h.tx.pending[0].resolve({ text: "OLD OLD OLD" });
  await flushAsync();
  assert.equal(h.events.partials.length, 1);
  assert.equal(h.controller.getState().inFlight, false);
  assert.equal(h.controller.getState().tentativeText, "new words");
  await h.controller.dispose();
});

test("cancel during stop suppresses onFinal and late partials", async () => {
  const h = createHarness({
    capture: createFakeCapture({ finalWav: wavMarker("final words") }),
    script: [{ never: true }],
    controllerOpts: { stopDrainTimeoutMs: 50 },
  });
  await startAndSettle(h);
  h.clock.fireNext();
  await flushAsync();
  const p = h.controller.stop();
  await flushAsync(2);
  assert.equal(h.controller.getState().status, "stopping");
  assert.equal(await h.controller.cancel(), true);
  const done = await p; // resolves quietly: cancel owns the outcome
  assert.equal(h.events.finals.length, 0);
  assert.equal(h.events.partials.length, 0);
  assert.equal(h.controller.getState().status, "idle");
  h.tx.pending[0]?.resolve({ text: "late words" });
  await flushAsync();
  assert.equal(h.events.partials.length, 0);
  assert.equal(done.text, "");
  await h.controller.dispose();
});

test("dispose during stop suppresses onFinal", async () => {
  const h = createHarness({
    capture: createFakeCapture({ finalWav: wavMarker("final words") }),
    script: [{ never: true }],
    controllerOpts: { stopDrainTimeoutMs: 50 },
  });
  await startAndSettle(h);
  h.clock.fireNext();
  await flushAsync();
  const p = h.controller.stop();
  await flushAsync(2);
  await h.controller.dispose();
  await p;
  assert.equal(h.events.finals.length, 0);
  assert.equal(h.events.partials.length, 0);
  assert.equal(h.controller.getState().status, "idle");
});

test("late startup failure after restart is ignored", async () => {
  const cap = createFakeCapture();
  const tx = createFakeTranscriber([{ text: "hi" }]);
  let rejectFirst = null;
  let releaseSecond = null;
  const firstGate = new Promise((_r, rej) => {
    rejectFirst = rej;
  });
  const secondGate = new Promise((r) => {
    releaseSecond = r;
  });
  let readyCalls = 0;
  tx.ensureReady = () => {
    readyCalls += 1;
    if (readyCalls === 1)
      return firstGate.then(
        () => ({ ready: true }),
        (err) => ({ ready: false, error: err }),
      );
    return secondGate.then(() => ({ ready: true }));
  };
  const h = createHarness({ capture: cap, transcriber: tx });
  assert.equal(h.controller.start(), true);
  await flushAsync();
  assert.equal(await h.controller.cancel(), true);
  assert.equal(h.controller.start(), true);
  await flushAsync();
  // The stale startup fails after the restart: must not error the session.
  rejectFirst({ code: "PORT_IN_USE", message: "stale owner" });
  await flushAsync();
  assert.equal(h.events.errors.length, 0);
  releaseSecond();
  await flushAsync();
  assert.equal(h.controller.getState().status, "streaming");
  await h.controller.dispose();
});

test("capture death mid-streaming errors explicitly and halts scheduling", async () => {
  const clock = createManualClock();
  const cap = createFakeCapture();
  let captureOnError = null;
  const tx = createFakeTranscriber([{ text: "hello" }]);
  const events = { partials: [], finals: [], states: [], errors: [] };
  const controller = createStreamingController({
    captureFactory: (opts) => {
      captureOnError = opts?.onError || null;
      return cap;
    },
    transcriberFactory: () => tx,
    clock,
    cadenceMs: 1000,
    stopDrainTimeoutMs: 20,
    onPartial: (p) => events.partials.push(p),
    onFinal: (f) => events.finals.push(f),
    onStateChange: (s) => events.states.push(s),
    onError: (e) => events.errors.push(e),
  });
  assert.equal(controller.start(), true);
  await flushAsync();
  assert.equal(controller.getState().status, "streaming");
  assert.ok(captureOnError, "controller wires capture onError");
  clock.fireNext();
  await flushAsync();
  assert.equal(tx.calls.length, 1);
  // SoX crashes mid-session: explicit error, transcript+audio retained,
  // scheduler halted (no further inference attempts).
  captureOnError({ code: "CAPTURE_EXITED", message: "sox died", recoverable: true });
  await flushAsync();
  assert.equal(controller.getState().status, "error");
  assert.equal(events.errors.length, 1);
  assert.equal(events.errors[0].code, "CAPTURE_EXITED");
  assert.equal(events.errors[0].hasFallbackAudio, true);
  assert.ok(controller.getFallbackAudio() instanceof Buffer);
  const callsBefore = tx.calls.length;
  clock.fireNext();
  await flushAsync();
  assert.equal(tx.calls.length, callsBefore);
  await controller.dispose();
});

test("capture death during startup converts to the startup failure path", async () => {
  const clock = createManualClock();
  let alive = true;
  const capError = { code: "CAPTURE_EXITED", message: "sox died", recoverable: true };
  const cap = {
    ...createFakeCapture(),
    isAlive: () => alive,
    getLastError: () => (alive ? null : capError),
  };
  let captureOnError = null;
  const tx = createFakeTranscriber([{ text: "hi" }]);
  let releaseReady;
  const readyGate = new Promise((r) => {
    releaseReady = r;
  });
  tx.ensureReady = async () => {
    await readyGate;
    return { ready: true };
  };
  const events = { errors: [], states: [] };
  const controller = createStreamingController({
    captureFactory: (opts) => {
      captureOnError = opts?.onError || null;
      return cap;
    },
    transcriberFactory: () => tx,
    clock,
    cadenceMs: 1000,
    stopDrainTimeoutMs: 20,
    onStateChange: (s) => events.states.push(s),
    onError: (e) => events.errors.push(e),
  });
  assert.equal(controller.start(), true);
  await flushAsync();
  alive = false;
  captureOnError(capError);
  await flushAsync();
  releaseReady();
  await flushAsync();
  // Never enters streaming on a dead mic; the capture error is reported.
  assert.equal(controller.getState().status, "error");
  assert.equal(events.errors.length, 1);
  assert.equal(events.errors[0].code, "CAPTURE_EXITED");
  assert.ok(controller.getFallbackAudio() instanceof Buffer);
  await controller.dispose();
});

// ---- Virtual clock: prove cadence timestamps, not just call counts ----

function createVirtualClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  let maxPending = 0;
  const firedAt = [];
  return {
    firedAt,
    maxPending: () => maxPending,
    pendingCount: () => timers.size,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { due: now + ms, fn });
      maxPending = Math.max(maxPending, timers.size);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let bestId = null;
        let bestDue = Infinity;
        for (const [id, t] of timers) {
          if (t.due <= end && t.due < bestDue) {
            bestDue = t.due;
            bestId = id;
          }
        }
        if (bestId === null) break;
        const t = timers.get(bestId);
        timers.delete(bestId);
        now = t.due;
        firedAt.push(now);
        t.fn();
      }
      now = end;
    },
  };
}

function createVirtualHarness({ script, cadenceMs = 1000 }) {
  const clock = createVirtualClock();
  const cap = createFakeCapture();
  const tx = createFakeTranscriber(script);
  const events = { partials: [], finals: [], states: [], errors: [] };
  const controller = createStreamingController({
    captureFactory: () => cap,
    transcriberFactory: () => tx,
    clock,
    cadenceMs,
    stopDrainTimeoutMs: 20,
    onPartial: (p) => events.partials.push(p),
    onFinal: (f) => events.finals.push(f),
    onStateChange: (s) => events.states.push(s),
    onError: (e) => events.errors.push(e),
  });
  return { clock, cap, tx, events, controller };
}

test("slow inference: cadence ticks during decode, one immediate catch-up, no backlog", async () => {
  const h = createVirtualHarness({ script: [{ never: true }, { text: "caught up" }] });
  assert.equal(h.controller.start(), true);
  await flushAsync();
  h.clock.advance(0); // t=0: first tick launches the slow request
  await flushAsync();
  assert.equal(h.tx.calls.length, 1);
  h.clock.advance(1000); // t=1000: cadence tick fires while busy -> coalesce
  await flushAsync();
  assert.equal(h.tx.calls.length, 1); // no second request, no queue
  assert.equal(h.clock.pendingCount(), 0);
  h.tx.pending[0].resolve({ text: "hello" });
  await flushAsync();
  assert.equal(h.clock.pendingCount(), 1); // one catch-up tick armed
  h.clock.advance(0); // fires immediately at the same virtual time
  await flushAsync();
  assert.equal(h.tx.calls.length, 2); // newest audio, exactly once
  assert.deepEqual(h.clock.firedAt, [0, 1000, 1000]);
  assert.ok(h.clock.maxPending() <= 1, "never more than one timer pending");
  await h.controller.dispose();
});

test("fast inference: next tick keeps wall cadence from launch, not from decode", async () => {
  const h = createVirtualHarness({ script: [{ text: "a" }, { text: "b" }] });
  assert.equal(h.controller.start(), true);
  await flushAsync();
  h.clock.advance(0); // t=0: launch, scripted text resolves on flush
  await flushAsync();
  assert.equal(h.tx.calls.length, 1);
  assert.equal(h.events.partials.length, 1);
  h.clock.advance(300); // decode long done; no tick yet
  await flushAsync();
  assert.equal(h.tx.calls.length, 1);
  h.clock.advance(700); // t=1000: cadence tick (would be t=1300 under decode-relative scheduling)
  await flushAsync();
  assert.equal(h.tx.calls.length, 2);
  assert.deepEqual(h.clock.firedAt, [0, 1000]);
  await h.controller.dispose();
});

test("tick format defaults to plain json (halved latency, no segments fetch)", async () => {
  const calls = [];
  const factory = () => ({
    client: {
      start: async () => true,
      getPort: () => 8090,
      async transcribeBuffer(_wav, opts) {
        calls.push(opts?.responseFormat);
        return { text: "hello" };
      },
    },
    release() {},
  });
  const tx = createServerTranscriber({
    modelPath: "/m.bin",
    language: "en",
    serverFactory: factory,
  });
  assert.equal((await tx.ensureReady()).ready, true);
  const r = await tx.transcribe(Buffer.from("WAV:snap"));
  assert.equal(r.text, "hello");
  assert.deepEqual(calls, ["json"]);
  assert.equal(tx.getResponseFormat(), "json");
  assert.equal(tx.describe().responseFormat, "json");
  tx.dispose();
});

test("unknown preferred format falls back to plain json", async () => {
  const factory = () => ({
    client: {
      start: async () => true,
      async transcribeBuffer(_wav, opts) {
        return { text: `fmt=${opts?.responseFormat}` };
      },
    },
    release() {},
  });
  const tx = createServerTranscriber({
    modelPath: "/m.bin",
    language: "en",
    responseFormat: "bogus",
    serverFactory: factory,
  });
  const r = await tx.transcribe(Buffer.from("WAV:snap"));
  assert.equal(r.text, "fmt=json");
  assert.equal(tx.getResponseFormat(), "json");
  tx.dispose();
});

test("explicit verbose_json opt-in still downgrades once on old builds, then stays on json", async () => {
  const calls = [];
  let verboseAttempts = 0;
  const factory = () => ({
    client: {
      start: async () => true,
      async transcribeBuffer(_wav, opts) {
        calls.push(opts?.responseFormat);
        if (opts?.responseFormat === "verbose_json" && verboseAttempts++ === 0) {
          return { error: "unsupported response_format", code: "BAD_STATUS" };
        }
        return { text: "hi" };
      },
    },
    release() {},
  });
  const tx = createServerTranscriber({
    modelPath: "/m.bin",
    language: "en",
    responseFormat: "verbose_json",
    serverFactory: factory,
  });
  const first = await tx.transcribe(Buffer.from("WAV:snap"));
  assert.equal(first.text, "hi");
  assert.deepEqual(calls, ["verbose_json", "json"]);
  assert.equal(tx.getResponseFormat(), "json");
  const second = await tx.transcribe(Buffer.from("WAV:snap"));
  assert.equal(second.text, "hi");
  assert.deepEqual(calls, ["verbose_json", "json", "json"]);
  tx.dispose();
});

test("commit decisions never depend on segments (jittered segments ignored)", async () => {
  const h = createHarness({ script: [{ text: "placeholder" }] });
  h.tx.transcribe = () =>
    Promise.resolve({
      text: "hello world",
      segments: [{ id: 0, start: 9.9, end: 10.1, text: "bogus tail" }],
    });
  await startAndSettle(h);
  h.clock.fireNext();
  await flushAsync();
  const last = h.events.partials.at(-1);
  assert.ok((`${last.stableText} ${last.tentativeText}`.trim() || "").includes("hello world"));
  assert.doesNotMatch(`${last.stableText} ${last.tentativeText}`, /bogus/);
  await h.controller.dispose();
});

test("rolling PCM ring is bounded and snapshots the newest bytes", async () => {
  const ring = createRollingPcmBuffer({ capacityBytes: 100 });
  ring.push(Buffer.alloc(80, 1));
  ring.push(Buffer.alloc(80, 2));
  assert.ok(ring.size() <= 100);
  assert.equal(ring.size(), 100);
  const snap = ring.snapshotLast(100);
  assert.equal(snap.length, 100);
  assert.ok(snap.every((b) => b === 2 || b === 1));
  // Newest bytes win: the tail is all 2s.
  assert.ok(snap.subarray(20).every((b) => b === 2));
  // Sustained over-capacity input never grows the ring.
  for (let i = 0; i < 50; i++) ring.push(Buffer.alloc(100, 3));
  assert.ok(ring.size() <= 100);
  assert.ok(ring.snapshotLast(100).every((b) => b === 3));
});

test("pause is refused when idle and resume is refused when not paused", async () => {
  const h = createHarness({});
  assert.equal(h.controller.pause(), false);
  assert.equal(h.controller.resume(), false);
  assert.equal(h.controller.getState().paused, false);
  await h.controller.dispose();
});

test("pause freezes inference ticks and resume continues them", async () => {
  const h = createHarness({ script: [{ text: "hello" }, { text: "hello world" }] });
  await startAndSettle(h);
  h.clock.fireNext();
  await flushAsync();
  assert.equal(h.tx.calls.length, 1, "one inference per tick while live");
  assert.equal(h.controller.pause(), true);
  assert.equal(h.controller.getState().paused, true);
  assert.equal(h.controller.pause(), false, "double pause is a no-op");
  h.clock.fireNext();
  await flushAsync();
  h.clock.fireNext();
  await flushAsync();
  assert.equal(h.tx.calls.length, 1, "no inference while paused");
  assert.ok(h.clock.pendingCount() > 0, "cadence timer stays armed for instant resume");
  assert.equal(h.controller.resume(), true);
  assert.equal(h.controller.getState().paused, false);
  assert.equal(h.controller.resume(), false, "resume when live is a no-op");
  h.clock.fireNext();
  await flushAsync();
  assert.equal(h.tx.calls.length, 2, "inference resumes after unpause");
  await h.controller.dispose();
});

test("stop from paused keeps the transcript and clears the pause flag", async () => {
  const h = createHarness({ script: [{ text: "hello world" }] });
  await startAndSettle(h);
  h.clock.fireNext();
  await flushAsync();
  assert.equal(h.controller.pause(), true);
  const done = await h.controller.stop();
  assert.ok(done.text.includes("hello"), "stop-tail transcription still works");
  assert.equal(h.controller.getState().paused, false);
  assert.equal(h.controller.getState().status, "idle");
});

test("cancel from paused succeeds without hanging", async () => {
  const h = createHarness({ script: [{ text: "hello world" }] });
  await startAndSettle(h);
  assert.equal(h.controller.pause(), true);
  assert.equal(await h.controller.cancel(), true);
  assert.equal(h.controller.getState().paused, false);
});

test("a fresh start never resumes paused", async () => {
  const h = createHarness({ script: [{ text: "hello" }] });
  await startAndSettle(h);
  assert.equal(h.controller.pause(), true);
  await h.controller.cancel();
  assert.equal(h.controller.getState().paused, false);
  await startAndSettle(h);
  assert.equal(h.controller.getState().paused, false, "reuse starts unpaused");
  await h.controller.dispose();
});
