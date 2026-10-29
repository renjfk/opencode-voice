import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSoxRollingCapture, createStreamingController } from "../lib/streaming-stt.js";

const BYTES_PER_SECOND = 32000; // 16kHz mono 16-bit, must match STREAMING_DEFAULTS

// ---- Fake SoX process: the REAL capture adapter, injected PCM ----

function createFakeSox() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killedWith = [];
  proc.kill = (sig) => {
    proc.killedWith.push(sig);
    proc.emit("exit", 0);
    proc.emit("close", 0); // Node semantics: close (stdio flushed) follows exit
    return true;
  };
  return proc;
}

// One second of PCM filled with a marker byte identifying the second.
function pcmSecond(sec) {
  return Buffer.alloc(BYTES_PER_SECOND, (sec + 1) % 256);
}

function pushSeconds(proc, fromSec, count) {
  for (let s = fromSec; s < fromSec + count; s++) {
    proc.stdout.emit("data", pcmSecond(s));
  }
}

function wavPcm(wav) {
  assert.ok(wav instanceof Buffer);
  return wav.subarray(44); // strip the WAV header written by wrapPcmAsWav
}

function makeSpoolDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spool-test-"));
}

function spoolFiles(dir) {
  return fs.readdirSync(dir).filter((n) => n.startsWith("opencode-voice-stream-"));
}

async function flushAsync(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

test("cold start longer than the window preserves initial speech in the spool", async () => {
  const dir = makeSpoolDir();
  const proc = createFakeSox();
  const cap = createSoxRollingCapture({
    windowMs: 10000,
    spawnFn: () => proc,
    spoolDir: dir,
  });
  cap.start();
  // 25s of speech arrive before recognition is ready: far past the 13s ring.
  pushSeconds(proc, 0, 25);
  await cap.flushSpool();

  // The rolling snapshot only covers the last 10s (ring behavior unchanged).
  const snap = cap.snapshot();
  assert.equal(wavPcm(snap.wav).length, 10 * BYTES_PER_SECOND);
  assert.equal(wavPcm(snap.wav)[0], 16); // second 15 is the oldest retained
  assert.equal(snap.absoluteStartMs, 15000);
  assert.equal(snap.absoluteEndMs, 25000);

  // But the spool kept everything from t=0: the fallback is the full 25s,
  // honestly described as complete.
  const fin = await cap.stopFinal();
  const pcm = wavPcm(fin.wav);
  assert.equal(pcm.length, 25 * BYTES_PER_SECOND);
  assert.equal(pcm[0], 1); // second 0 survived the >window cold start
  assert.equal(pcm[pcm.length - 1], 25);
  assert.equal(fin.coverage.complete, true);
  assert.equal(fin.coverage.fromMs, 0);
  assert.equal(fin.coverage.toMs, 25000);
  assert.deepEqual(fin.coverage.droppedRanges, []);
  // Spool file consumed: no litter left behind.
  assert.deepEqual(spoolFiles(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("inference slower than the window keeps unprocessed audio", async () => {
  const dir = makeSpoolDir();
  const proc = createFakeSox();
  const cap = createSoxRollingCapture({
    windowMs: 10000,
    spawnFn: () => proc,
    spoolDir: dir,
  });
  cap.start();
  pushSeconds(proc, 0, 10);
  await cap.flushSpool();
  const early = cap.snapshot(); // slow inference transcribes only this...
  pushSeconds(proc, 10, 20); // ...while 20 more seconds arrive unprocessed
  await cap.flushSpool();

  const fin = await cap.stopFinal();
  const pcm = wavPcm(fin.wav);
  assert.equal(pcm.length, 30 * BYTES_PER_SECOND);
  assert.equal(pcm[0], 1); // unprocessed middle (seconds 10-29) preserved
  assert.equal(fin.coverage.complete, true);
  assert.equal(fin.coverage.totalMs, 30000);
  assert.equal(early.absoluteEndMs, 10000);
  assert.deepEqual(spoolFiles(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("spool overflow is explicit, counted, and never claims completeness", async () => {
  const dir = makeSpoolDir();
  const proc = createFakeSox();
  const overflows = [];
  const cap = createSoxRollingCapture({
    windowMs: 10000,
    spoolMaxMs: 5000,
    spawnFn: () => proc,
    spoolDir: dir,
    onOverflow: (e) => overflows.push(e),
  });
  cap.start();
  pushSeconds(proc, 0, 30);
  await cap.flushSpool();

  // Explicit recoverable overflow, reported exactly once (the byte counters
  // keep accumulating after the first report - the report itself counts).
  assert.equal(overflows.length, 1);
  assert.equal(overflows[0].code, "AUDIO_SPOOL_OVERFLOW");
  assert.equal(overflows[0].recoverable, true);
  assert.equal(overflows[0].spooledMs, 5000);
  // Running total at the moment of first overflow (this one 1s chunk);
  // cumulative loss is tracked in getCoverage, asserted below.
  assert.equal(overflows[0].droppedMs, 1000);

  // 30s total, 5s spool head, 13s ring tail (17-30s): the middle is an
  // explicit gap, never presented as retained.
  const coverage = cap.getCoverage();
  assert.equal(coverage.complete, false);
  assert.equal(coverage.totalMs, 30000);
  assert.deepEqual(coverage.droppedRanges, [{ fromMs: 5000, toMs: 17000 }]);
  assert.ok(coverage.message.includes("NOT a complete recording"));

  // The fallback WAV covers exactly the retained 0-5s head: honest length.
  const fin = await cap.stopFinal();
  assert.equal(wavPcm(fin.wav).length, 5 * BYTES_PER_SECOND);
  assert.equal(wavPcm(fin.wav)[0], 1);
  assert.equal(fin.coverage.complete, false);
  assert.deepEqual(spoolFiles(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("async spawn error (ENOENT) reports explicitly and retains prior audio", async () => {
  const dir = makeSpoolDir();
  const proc = createFakeSox();
  const errors = [];
  const cap = createSoxRollingCapture({
    windowMs: 10000,
    spawnFn: () => proc,
    spoolDir: dir,
    onError: (e) => errors.push(e),
  });
  cap.start();
  assert.equal(cap.isAlive(), true);
  pushSeconds(proc, 0, 2);
  await cap.flushSpool();
  const enoent = new Error("spawn sox ENOENT");
  enoent.code = "ENOENT";
  proc.emit("error", enoent);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "CAPTURE_SPAWN_ENOENT");
  assert.equal(errors[0].recoverable, true);
  assert.equal(cap.isAlive(), false);
  assert.equal(cap.getLastError().code, "CAPTURE_SPAWN_ENOENT");
  // Audio captured before the failure is retained, not lost with the proc.
  const fin = await cap.stopFinal();
  assert.equal(wavPcm(fin.wav).length, 2 * BYTES_PER_SECOND);
  assert.deepEqual(spoolFiles(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("unexpected exit reports CAPTURE_EXITED; our own kills stay silent", async () => {
  const dir = makeSpoolDir();
  // Unexpected crash exit.
  const proc = createFakeSox();
  const errors = [];
  const cap = createSoxRollingCapture({
    windowMs: 10000,
    spawnFn: () => proc,
    spoolDir: dir,
    onError: (e) => errors.push(e),
  });
  cap.start();
  pushSeconds(proc, 0, 3);
  await cap.flushSpool();
  proc.emit("exit", 1, null);
  proc.emit("close", 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "CAPTURE_EXITED");
  assert.deepEqual(errors[0].exit, { code: 1, signal: null });
  assert.equal(cap.isAlive(), false);
  const fin = await cap.stopFinal();
  assert.equal(wavPcm(fin.wav).length, 3 * BYTES_PER_SECOND);
  await cap.dispose();

  // Our own SIGINT stop kill: no error.
  const proc2 = createFakeSox();
  const errors2 = [];
  const cap2 = createSoxRollingCapture({
    windowMs: 10000,
    spawnFn: () => proc2,
    spoolDir: dir,
    onError: (e) => errors2.push(e),
  });
  cap2.start();
  pushSeconds(proc2, 0, 1);
  await cap2.stopFinal(); // SIGINT kill inside stopFinal
  assert.deepEqual(errors2, []);
  assert.deepEqual(spoolFiles(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("audio arriving between exit and close is still drained", async () => {
  const dir = makeSpoolDir();
  const proc = createFakeSox();
  const errors = [];
  const cap = createSoxRollingCapture({
    windowMs: 10000,
    spawnFn: () => proc,
    spoolDir: dir,
    onError: (e) => errors.push(e),
  });
  cap.start();
  pushSeconds(proc, 0, 2);
  await cap.flushSpool();
  proc.emit("exit", 2, null); // crash...
  pushSeconds(proc, 2, 1); // ...but the tail was already in flight
  proc.emit("close", 2);
  await cap.flushSpool();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "CAPTURE_EXITED");
  const fin = await cap.stopFinal();
  const pcm = wavPcm(fin.wav);
  assert.equal(pcm.length, 3 * BYTES_PER_SECOND);
  assert.equal(pcm[0], 1); // second 0
  assert.equal(pcm[pcm.length - 1], 3); // post-exit tail second 2
  assert.deepEqual(spoolFiles(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("stale process handlers cannot null a restarted session", async () => {
  const dir = makeSpoolDir();
  const proc1 = createFakeSox();
  const procs = [proc1];
  const errors = [];
  const cap = createSoxRollingCapture({
    windowMs: 10000,
    spawnFn: () => procs[procs.length - 1],
    spoolDir: dir,
    onError: (e) => errors.push(e),
  });
  cap.start();
  pushSeconds(proc1, 0, 1);
  proc1.emit("exit", 1, null);
  proc1.emit("close", 1);
  assert.equal(errors.length, 1);
  // Restart on a new process.
  const proc2 = createFakeSox();
  procs.push(proc2);
  cap.start();
  assert.equal(cap.isAlive(), true);
  // The OLD process emits late events: must not touch the new session.
  proc1.emit("error", Object.assign(new Error("late"), { code: "ENOENT" }));
  proc1.emit("exit", 1, null);
  assert.equal(errors.length, 1); // no second report
  assert.equal(cap.isAlive(), true);
  pushSeconds(proc2, 0, 2);
  await cap.flushSpool();
  assert.ok(cap.snapshot());
  await cap.dispose();
  assert.deepEqual(spoolFiles(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("synchronous spawn throw propagates and is recorded", async () => {
  const dir = makeSpoolDir();
  const enoent = new Error("spawn sox ENOENT");
  enoent.code = "ENOENT";
  const cap = createSoxRollingCapture({
    windowMs: 10000,
    spawnFn: () => {
      throw enoent;
    },
    spoolDir: dir,
  });
  assert.throws(() => cap.start(), /ENOENT/);
  assert.equal(cap.getLastError().code, "CAPTURE_SPAWN_ENOENT");
  assert.equal(cap.isAlive(), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
test("cancel and dispose remove the spool file", async () => {
  const dir = makeSpoolDir();
  const proc = createFakeSox();
  const cap = createSoxRollingCapture({
    windowMs: 10000,
    spawnFn: () => proc,
    spoolDir: dir,
  });
  cap.start();
  pushSeconds(proc, 0, 3);
  await cap.flushSpool();
  assert.equal(spoolFiles(dir).length, 1);
  await cap.cancel();
  assert.deepEqual(spoolFiles(dir), []);
  // Restart + dispose path cleans up too.
  cap.start();
  pushSeconds(proc, 0, 2);
  await cap.flushSpool();
  assert.equal(spoolFiles(dir).length, 1);
  await cap.dispose();
  assert.deepEqual(spoolFiles(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("controller fallback audio via the real adapter describes retained coverage", async () => {
  const dir = makeSpoolDir();
  const proc = createFakeSox();
  const capture = createSoxRollingCapture({
    windowMs: 10000,
    spawnFn: () => proc,
    spoolDir: dir,
  });
  const tx = {
    ensureReadyCalls: 0,
    async ensureReady() {
      this.ensureReadyCalls += 1;
      return { ready: true };
    },
    transcribeCalls: 0,
    transcribe() {
      this.transcribeCalls += 1;
      return Promise.resolve({ error: "boom", code: "TRANSCRIBE_FAILED" });
    },
    dispose() {},
    describe: () => ({ modelPath: "/m.bin", language: "en" }),
  };
  const errors = [];
  const controller = createStreamingController({
    captureFactory: () => capture,
    transcriberFactory: () => tx,
    cadenceMs: 50,
    stopDrainTimeoutMs: 20,
    onError: (e) => errors.push(e),
  });
  assert.equal(controller.start(), true);
  await flushAsync();
  assert.equal(controller.getState().status, "streaming");

  // 12s of real PCM through the real adapter, then a failed inference tick.
  pushSeconds(proc, 0, 12);
  await capture.flushSpool();
  await new Promise((r) => setTimeout(r, 120));
  await flushAsync();

  assert.equal(controller.getState().status, "error");
  const audio = controller.getFallbackAudio();
  assert.equal(wavPcm(audio).length, 12 * BYTES_PER_SECOND);
  assert.equal(wavPcm(audio)[0], 1); // second 0 retained, not just the window
  const coverage = controller.getFallbackCoverage();
  assert.equal(coverage.complete, true);
  assert.equal(coverage.fromMs, 0);
  assert.equal(coverage.toMs, 12000);
  assert.equal(errors[0].fallbackCoverage.complete, true);
  await controller.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pause SIGSTOPs the mic and stopFinal resumes before stopping it", async () => {
  const dir = makeSpoolDir();
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killedWith = [];
  proc.kill = (sig) => {
    proc.killedWith.push(sig);
    if (sig === "SIGSTOP" || sig === "SIGCONT") return true; // frozen, stays alive
    proc.emit("exit", 0);
    proc.emit("close", 0);
    return true;
  };
  const cap = createSoxRollingCapture({
    windowMs: 10000,
    spawnFn: () => proc,
    spoolDir: dir,
  });
  assert.equal(cap.pause(), false, "no proc, nothing to pause");
  cap.start();
  pushSeconds(proc, 0, 2);
  await cap.flushSpool();
  assert.equal(cap.pause(), true);
  assert.deepEqual(proc.killedWith, ["SIGSTOP"]);
  assert.equal(cap.isAlive(), true, "paused mic is frozen, not dead");
  const fin = await cap.stopFinal({ soxExitTimeoutMs: 50 });
  const contIdx = proc.killedWith.indexOf("SIGCONT");
  const intIdx = proc.killedWith.indexOf("SIGINT");
  assert.ok(contIdx !== -1 && contIdx < intIdx, "SIGCONT precedes SIGINT on teardown");
  assert.ok(fin.wav && fin.wav.length > 44, "retained audio still returned");
  await cap.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("cancel resumes a paused mic before killing it", async () => {
  const dir = makeSpoolDir();
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killedWith = [];
  proc.kill = (sig) => {
    proc.killedWith.push(sig);
    if (sig === "SIGSTOP" || sig === "SIGCONT") return true;
    proc.emit("exit", 0);
    proc.emit("close", 0);
    return true;
  };
  const cap = createSoxRollingCapture({
    windowMs: 10000,
    spawnFn: () => proc,
    spoolDir: dir,
  });
  cap.start();
  pushSeconds(proc, 0, 1);
  await cap.flushSpool();
  assert.equal(cap.pause(), true);
  await cap.cancel();
  const contIdx = proc.killedWith.indexOf("SIGCONT");
  const killIdx = proc.killedWith.indexOf("SIGKILL");
  assert.ok(contIdx !== -1 && killIdx !== -1 && contIdx < killIdx, "SIGCONT precedes SIGKILL");
  await cap.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});
