import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createStreamingController } from "../lib/streaming-stt.js";
import { isStreamingServerFault, streamModelKey } from "../lib/stt.js";

// Warm-lease follow-up: the whisper-server must stay loaded across
// finalize/cancel (stop/cancel must not dispose the transcriber); the lease
// is released only on setModel/dispose (or a proven server fault in stt.js).
// Deterministic: fake capture/transcriber, manual clock, no processes/ports.

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
    stopFinalCalls: 0,
    cancelled: 0,
    disposed: 0,
    start() {
      this.started += 1;
    },
    snapshot() {
      return { wav: wavMarker("snap"), durationMs: 1000 };
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

function createCountingTranscriberFactory() {
  const instances = [];
  let creations = 0;
  const factory = () => {
    creations += 1;
    const tx = {
      disposeCalls: 0,
      ensureReadyCalls: 0,
      transcribeCalls: 0,
      async ensureReady() {
        this.ensureReadyCalls += 1;
        return { ready: true };
      },
      async transcribe() {
        this.transcribeCalls += 1;
        return { text: "hello warm" };
      },
      dispose() {
        this.disposeCalls += 1;
      },
      describe: () => ({ modelPath: "/m.bin", language: "en" }),
    };
    instances.push(tx);
    return tx;
  };
  return { factory, instances, creations: () => creations };
}

async function startAndSettle(controller) {
  assert.equal(controller.start(), true);
  await flushAsync();
  assert.equal(controller.getState().status, "streaming");
}

test("stop keeps the server loaded: second start reuses the one transcriber", async () => {
  const counted = createCountingTranscriberFactory();
  const controller = createStreamingController({
    captureFactory: () => createFakeCapture(),
    transcriberFactory: counted.factory,
    clock: createManualClock(),
    cadenceMs: 1000,
    stopDrainTimeoutMs: 20,
  });
  await startAndSettle(controller);
  assert.equal(counted.creations(), 1);
  const done = await controller.stop();
  assert.ok((done.text || "").includes("hello"));
  // No dispose on the stop path: exactly one warm lease survives.
  assert.equal(counted.instances[0].disposeCalls, 0);
  await startAndSettle(controller);
  // Reused, never double-spawned: factory ran once total.
  assert.equal(counted.creations(), 1);
  assert.equal(counted.instances[0].disposeCalls, 0);
  await controller.dispose();
});

test("cancel preserves the lease: restart reuses the same transcriber", async () => {
  const counted = createCountingTranscriberFactory();
  const controller = createStreamingController({
    captureFactory: () => createFakeCapture(),
    transcriberFactory: counted.factory,
    clock: createManualClock(),
    cadenceMs: 1000,
    stopDrainTimeoutMs: 20,
  });
  await startAndSettle(controller);
  assert.equal(await controller.cancel(), true);
  assert.equal(counted.instances[0].disposeCalls, 0);
  await startAndSettle(controller);
  assert.equal(counted.creations(), 1);
  await controller.dispose();
});

test("setModel tears down the warm lease; next start loads the new model", async () => {
  const counted = createCountingTranscriberFactory();
  const controller = createStreamingController({
    captureFactory: () => createFakeCapture(),
    transcriberFactory: counted.factory,
    clock: createManualClock(),
    cadenceMs: 1000,
    stopDrainTimeoutMs: 20,
  });
  await startAndSettle(controller);
  await controller.stop();
  assert.equal(controller.setModel({ modelPath: "/new.bin", language: "en" }), true);
  assert.equal(counted.instances[0].disposeCalls, 1);
  await startAndSettle(controller);
  assert.equal(counted.creations(), 2);
  await controller.dispose();
  assert.equal(counted.instances[1].disposeCalls, 1);
});

test("dispose releases the lease exactly once", async () => {
  const counted = createCountingTranscriberFactory();
  const controller = createStreamingController({
    captureFactory: () => createFakeCapture(),
    transcriberFactory: counted.factory,
    clock: createManualClock(),
    cadenceMs: 1000,
    stopDrainTimeoutMs: 20,
  });
  await startAndSettle(controller);
  await controller.dispose();
  assert.equal(counted.instances[0].disposeCalls, 1);
});

test("updateCallbacks rebinds the session editor, refused mid-dictation", async () => {
  const seenA = [];
  const seenB = [];
  const tx = {
    async ensureReady() {
      return { ready: true };
    },
    async transcribe() {
      return { text: "hello warm world" };
    },
    dispose() {},
    describe: () => ({ modelPath: "/m.bin", language: "en" }),
  };
  const clock = createManualClock();
  const controller = createStreamingController({
    captureFactory: () => createFakeCapture(),
    transcriberFactory: () => tx,
    clock,
    cadenceMs: 1000,
    stopDrainTimeoutMs: 20,
    onPartial: (p) => seenA.push(p),
  });
  await startAndSettle(controller);
  // Mid-dictation rewire is refused so a live session keeps its editor.
  assert.equal(controller.updateCallbacks({ onPartial: (p) => seenB.push(p) }), false);
  await controller.stop();
  const aAfterFirst = seenA.length;
  // Idle: rebind succeeds; the next session's partials reach the new editor.
  assert.equal(controller.updateCallbacks({ onPartial: (p) => seenB.push(p) }), true);
  await startAndSettle(controller);
  clock.pending.values().next().value?.();
  await flushAsync();
  assert.equal(seenA.length, aAfterFirst);
  assert.ok(seenB.length >= 1);
  await controller.dispose();
});

test("server-fault classification: capture faults preserve, server faults release", () => {
  assert.equal(isStreamingServerFault(null), false);
  assert.equal(isStreamingServerFault(undefined), false);
  assert.equal(isStreamingServerFault({ code: "CAPTURE_FAILED", message: "sox died" }), false);
  assert.equal(isStreamingServerFault({ code: "CAPTURE_EXITED", message: "SoX exited" }), false);
  assert.equal(isStreamingServerFault({ code: "CAPTURE_SPAWN_ENOENT", message: "spawn" }), false);
  assert.equal(isStreamingServerFault({ code: "AUDIO_SPOOL_OVERFLOW", message: "cap" }), false);
  assert.equal(isStreamingServerFault({ code: "NOT_READY", message: "not ready" }), true);
  assert.equal(isStreamingServerFault({ code: "STOP_NOT_READY", message: "cold start" }), true);
  assert.equal(isStreamingServerFault({ code: "PORT_IN_USE", message: "port" }), true);
  assert.equal(isStreamingServerFault({ code: "REQUEST_FAILED", message: "fetch failed" }), true);
});

test("streamModelKey separates model and language", () => {
  assert.equal(streamModelKey("/a.bin", "en"), "/a.bin::en");
  assert.notEqual(streamModelKey("/a.bin", "en"), streamModelKey("/b.bin", "en"));
  assert.notEqual(streamModelKey("/a.bin", "en"), streamModelKey("/a.bin", "zh"));
});

test("streamModelKey distinguishes bound ports, omitting the port keeps the legacy form", () => {
  assert.equal(streamModelKey("/a.bin", "en", 8090), "/a.bin::en::8090");
  assert.notEqual(streamModelKey("/a.bin", "en", 8090), streamModelKey("/a.bin", "en", 8091));
  assert.equal(streamModelKey("/a.bin", "en", undefined), "/a.bin::en");
  assert.equal(streamModelKey("/a.bin", "en", null), "/a.bin::en");
});

test("stt.js session layer retains the lease and disposes only on server-fault/unload/model-change", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "stt.js"), "utf-8");
  const finIdx = src.indexOf("async function finalizeStreamingDictation");
  assert.ok(finIdx >= 0);
  const finSrc = src.slice(finIdx, finIdx + 6000);
  // Warm retention on every non-server-fault path...
  assert.match(finSrc, /retainWarmStreamController/);
  // ...with disposal only behind the server-fault classifier.
  assert.match(finSrc, /isStreamingServerFault/);
  const cancelIdx = src.indexOf("async function cancelStreamingDictation");
  assert.ok(cancelIdx >= 0);
  const cancelSrc = src.slice(cancelIdx, cancelIdx + 2000);
  assert.match(cancelSrc, /retainWarmStreamController/);
  assert.doesNotMatch(cancelSrc, /controller\.dispose/);
  // Model/language pickers tear down the parked lease; unload does too.
  assert.match(src, /disposeWarmStreamController/);
  // No unconditional dispose right after stop: the cold-start-per-dictation
  // regression (dispose on every finalize) must not come back. Exactly two
  // disposes: server faults and cancelled/disposed generations releasing
  // their stale handles instead of resurrecting a warm lease after unload.
  const disposeHits = finSrc.match(/controller\.dispose/g) || [];
  assert.equal(disposeHits.length, 2);
  assert.match(finSrc, /streamDisposed \|\| myGen !== streamGeneration/);
  assert.doesNotMatch(finSrc, /submitTurnText/);
});
