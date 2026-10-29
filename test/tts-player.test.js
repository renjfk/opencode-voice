import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPlayArgs,
  createTtsPlayer,
  measurePcmDurationSec,
  measureWavDurationSec,
} from "../lib/tts-player.js";

// Fake clock + fake sox process. No real audio, no timers.
function fakeAudio(initialNow = 0) {
  let now = initialNow;
  const spawns = [];
  const signals = [];
  let nextPid = 100;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    spawns,
    signals,
    spawn(argv) {
      const pid = nextPid++;
      const rec = { pid, argv, closeCb: null, stdinEnded: false };
      rec.onClose = (cb) => {
        rec.closeCb = cb;
      };
      rec.endStdin = () => {
        rec.stdinEnded = true;
      };
      rec.emitClose = (code) => {
        if (typeof rec.closeCb === "function") rec.closeCb(code);
      };
      spawns.push(rec);
      return rec;
    },
    signal: (pid, sig) => {
      signals.push({ pid, sig });
    },
  };
}

function mono16Pcm(seconds, rate = 22050) {
  return Buffer.alloc(Math.floor(seconds * rate) * 2);
}

test("buffered PCM measures an exact total from real frames", () => {
  assert.equal(measurePcmDurationSec({ bytes: mono16Pcm(2), sampleRate: 22050 }, 22050, 1, 16), 2);
  assert.equal(measurePcmDurationSec({ bytes: mono16Pcm(1.5, 16000) }, 16000, 1, 16), 1.5);
});

test("a WAV asset measures its total from the data chunk, not estimates", () => {
  const dataLen = 22050 * 2 * 3;
  const wav = Buffer.alloc(44 + dataLen);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataLen, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(22050, 24);
  wav.writeUInt32LE(22050 * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataLen, 40);
  assert.equal(measureWavDurationSec(wav), 3);
  assert.equal(measureWavDurationSec(Buffer.from("too-short")), null);
});

test("play spawns sox plainly when offset and rate are neutral", () => {
  const audio = fakeAudio();
  const player = createTtsPlayer({ spawn: audio.spawn, signal: audio.signal, now: audio.now });
  player.load({ pcm: mono16Pcm(4), sampleRate: 22050, channels: 1, bits: 16 });
  player.play();
  assert.equal(audio.spawns.length, 1);
  assert.deepEqual(audio.spawns[0].argv, buildPlayArgs({ offsetSec: 0, rate: 1 }));
  assert.ok(!audio.spawns[0].argv.includes("tempo"));
});

test("play applies tempo and trim from rate and seek offset", () => {
  const audio = fakeAudio();
  const player = createTtsPlayer({ spawn: audio.spawn, signal: audio.signal, now: audio.now });
  player.load({ pcm: mono16Pcm(10), sampleRate: 22050, channels: 1, bits: 16 });
  player.setRate(1.5);
  player.seek(3);
  player.play();
  const argv = audio.spawns[0].argv;
  assert.ok(argv.includes("tempo") && argv.includes("1.5"), `tempo missing: ${argv.join(" ")}`);
  assert.ok(argv.includes("trim"), `trim missing: ${argv.join(" ")}`);
  // Regression: effects before the input make sox report "Not enough input
  // filenames" and exit instantly with no audio. Input ("-") must lead.
  assert.deepEqual(argv.slice(0, 2), ["-q", "-"], `input must lead: ${argv.join(" ")}`);
  assert.ok(
    argv.indexOf("trim") > 1 && argv.indexOf("tempo") > 1,
    `effects must follow the input: ${argv.join(" ")}`,
  );
});

test("pause freezes the cursor and resume continues it", () => {
  const audio = fakeAudio();
  const player = createTtsPlayer({ spawn: audio.spawn, signal: audio.signal, now: audio.now });
  player.load({ pcm: mono16Pcm(10), sampleRate: 22050, channels: 1, bits: 16 });
  player.play();
  audio.advance(2000);
  assert.equal(player.getState().cursorSec, 2);
  assert.equal(player.pause(), true);
  assert.deepEqual(audio.signals.at(-1), { pid: 100, sig: "SIGSTOP" });
  audio.advance(5000);
  assert.equal(player.getState().cursorSec, 2, "paused playback must not advance");
  assert.equal(player.getState().status, "paused");
  assert.equal(player.resume(), true);
  assert.deepEqual(audio.signals.at(-1), { pid: 100, sig: "SIGCONT" });
  audio.advance(1000);
  assert.equal(player.getState().cursorSec, 3);
});

test("pause and resume are no-ops outside their states", () => {
  const audio = fakeAudio();
  const player = createTtsPlayer({ spawn: audio.spawn, signal: audio.signal, now: audio.now });
  assert.equal(player.pause(), false);
  assert.equal(player.resume(), false);
  player.load({ pcm: mono16Pcm(4), sampleRate: 22050, channels: 1, bits: 16 });
  player.play();
  assert.equal(player.resume(), false);
});

test("stop kills the owned process and settles, clearing to idle", async () => {
  const audio = fakeAudio();
  const player = createTtsPlayer({ spawn: audio.spawn, signal: audio.signal, now: audio.now });
  player.load({ pcm: mono16Pcm(10), sampleRate: 22050, channels: 1, bits: 16 });
  const done = player.play();
  audio.spawns[0].emitClose(0);
  await done;
  assert.equal(player.getState().status, "idle");
});

test("a stale close from a previous process never clears current playback", async () => {
  const audio = fakeAudio();
  const player = createTtsPlayer({ spawn: audio.spawn, signal: audio.signal, now: audio.now });
  player.load({ pcm: mono16Pcm(10), sampleRate: 22050, channels: 1, bits: 16 });
  player.play();
  const first = audio.spawns[0];
  player.seek(5);
  assert.equal(audio.spawns.length, 2, "seek while playing respawns at the new offset");
  first.emitClose(0);
  assert.equal(player.getState().status, "playing");
  assert.ok(player.getState().cursorSec >= 5);
});

test("seek clamps to the measured total and rewinds past zero safely", () => {
  const audio = fakeAudio();
  const player = createTtsPlayer({ spawn: audio.spawn, signal: audio.signal, now: audio.now });
  player.load({ pcm: mono16Pcm(10), sampleRate: 22050, channels: 1, bits: 16 });
  player.seek(99);
  assert.equal(player.getState().cursorSec, 10);
  player.seek(-5);
  assert.equal(player.getState().cursorSec, 0);
  player.play();
  audio.advance(4000);
  player.rewind(10);
  assert.equal(player.getState().cursorSec, 0);
  player.forward(3.5);
  assert.equal(player.getState().cursorSec, 3.5);
});

test("setRate clamps to 0.75x-2x and respawns mid-play preserving the cursor", () => {
  const audio = fakeAudio();
  const player = createTtsPlayer({ spawn: audio.spawn, signal: audio.signal, now: audio.now });
  player.load({ pcm: mono16Pcm(20), sampleRate: 22050, channels: 1, bits: 16 });
  assert.equal(player.setRate(5), 2);
  assert.equal(player.setRate(0.1), 0.75);
  player.setRate(2);
  player.play();
  audio.advance(2000);
  assert.equal(player.getState().cursorSec, 4, "cursor runs at 2x rate");
  player.setRate(1);
  assert.equal(audio.spawns.length, 2, "rate change respawns playback");
  assert.equal(player.getState().cursorSec, 4, "respawn preserves the cursor");
  assert.equal(player.getState().rate, 1);
});

test("replay restarts from zero and reports exact total with approximate cursor", () => {
  const audio = fakeAudio();
  const player = createTtsPlayer({ spawn: audio.spawn, signal: audio.signal, now: audio.now });
  player.load({ pcm: mono16Pcm(6), sampleRate: 22050, channels: 1, bits: 16 });
  player.play();
  audio.advance(5000);
  player.replay();
  const state = player.getState();
  assert.equal(state.cursorSec, 0);
  assert.equal(state.totalSec, 6);
  assert.equal(state.exactTotal, true);
  assert.equal(state.cursorApproximate, true);
});

test("dispose stops owned playback and refuses further plays", async () => {
  const audio = fakeAudio();
  const player = createTtsPlayer({ spawn: audio.spawn, signal: audio.signal, now: audio.now });
  player.load({ pcm: mono16Pcm(6), sampleRate: 22050, channels: 1, bits: 16 });
  const done = player.play();
  player.dispose();
  await done;
  assert.equal(player.getState().status, "idle");
  assert.equal(
    audio.signals.some((s) => s.sig === "SIGKILL"),
    true,
  );
  assert.equal(player.play(), false);
});
