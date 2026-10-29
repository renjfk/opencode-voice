import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  detectLang,
  groupSentencesByLang,
  isSpeakableSentence,
  localSpeechCleanup,
  registerTTS,
  resolveSpeechText,
  splitSpokenSentences,
  summarizeMarkdownTable,
  summarizeMermaidForSpeech,
} from "../lib/tts.js";

test("cleans markdown for speech", () => {
  assert.equal(localSpeechCleanup("Hello **world**!"), "Hello world!");
  assert.equal(
    localSpeechCleanup("See parseConfig in src/utils/helpers.ts"),
    "See parse Config in helpers dot ts",
  );
  assert.equal(localSpeechCleanup("Run `npm test` now"), "Run npm test now");
  assert.equal(localSpeechCleanup("```js\nconst x = 1;\n```\nDone."), "code snippet Done.");
  assert.equal(
    localSpeechCleanup("Details at https://example.com/docs?q=1"),
    "Details at example dot com",
  );
});

test("summarizes markdown tables instead of reading pipes", () => {
  assert.equal(
    summarizeMarkdownTable(
      "| Name | Status |\n|------|--------|\n| build | pass |\n| test | fail |",
    ),
    "Table with columns Name, Status. 2 rows: build, pass; test, fail.",
  );
  // More than the cap: shape + head + overflow count, never the whole dump.
  const big = [
    "| K | V |",
    "|---|---|",
    ...Array.from({ length: 6 }, (_, i) => `| k${i} | v${i} |`),
  ].join("\n");
  assert.equal(
    summarizeMarkdownTable(big),
    "Table with columns K, V. 6 rows: k0, v0; k1, v1; k2, v2. And 3 more.",
  );
  // No separator row: still speakable, never raw pipes.
  assert.equal(summarizeMarkdownTable("| A |\n| B |"), "Table with columns A. 1 row: B.");
});

test("summarizes mermaid diagrams as flows, not syntax", () => {
  assert.equal(
    summarizeMermaidForSpeech("graph TD\n  A[Start] --> B[Build]\n  B --> C[Test]"),
    "Diagram, graph: Start, Build, Test.",
  );
  assert.equal(summarizeMermaidForSpeech("sequenceDiagram\n  A->>B: hi"), "Diagram.");
  assert.equal(summarizeMermaidForSpeech(""), "Diagram.");
});

test("cleanup routes tables and diagrams before the generic code rule", () => {
  assert.equal(
    localSpeechCleanup("Results:\n| Name | Status |\n|---|---|\n| build | pass |\nDone."),
    "Results: Table with columns Name, Status. 1 row: build, pass. Done.",
  );
  assert.equal(
    localSpeechCleanup("```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\nDone."),
    "Diagram, graph: Start, End. Done.",
  );
  // Non-mermaid fences keep the old behavior.
  assert.equal(localSpeechCleanup("```js\nconst x = 1;\n```\nDone."), "code snippet Done.");
});

test("narrator prompts cover tables, diagrams, and code-switching", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "tts.js"), "utf-8");
  assert.match(src, /TABLES: never read a markdown table cell by cell/);
  assert.match(src, /DIAGRAMS: mermaid and other fenced diagrams are never read as syntax/);
  assert.match(src, /Keep technical terms.*in English/);
});

test("splits streamed text into complete sentences", () => {
  assert.deepEqual(splitSpokenSentences("Hello world. How are"), {
    sentences: ["Hello world."],
    rest: "How are",
  });
  assert.deepEqual(splitSpokenSentences("Done. Next."), {
    sentences: ["Done.", "Next."],
    rest: "",
  });
  assert.deepEqual(splitSpokenSentences("Partial no punctuation"), {
    sentences: [],
    rest: "Partial no punctuation",
  });
  assert.deepEqual(splitSpokenSentences(""), { sentences: [], rest: "" });
});

test("decides one language for a whole utterance by word majority", () => {
  // Vietnamese-dominant instruction with English tech loanwords -> vi voice
  // reads the whole thing (was the original mixed-voice request).
  assert.equal(detectLang("Tìm symbol, search text, đọc file cụ thể"), "vi");
  // Pure English.
  assert.equal(detectLang("Run the build and check logs"), "en");
  // A single stray Vietnamese word must NOT flip an English-dominant reply -
  // this was the root cause of "speaks English with the Vietnamese voice".
  assert.equal(detectLang("Please check with Nguyễn about the API before you deploy it"), "en");
  // Pure Vietnamese greeting.
  assert.equal(detectLang("Xin chào, bạn khỏe không?"), "vi");
  assert.equal(detectLang(""), "en");
  assert.equal(detectLang(null), "en");
});

test("skips code-like sentences", () => {
  assert.equal(isSpeakableSentence("Hello there."), true);
  assert.equal(isSpeakableSentence("Use `npm test`."), false);
  assert.equal(isSpeakableSentence(`x${"y".repeat(500)}`), false);
  assert.equal(isSpeakableSentence(""), false);
});

test("successful narrator output cannot pass raw Mermaid to speech", () => {
  const result = resolveSpeechText("source", {
    text: "Overview:\n```mermaid\nflowchart TD\nA[Request] --> B[Response]\n```\nDone.",
  });
  assert.doesNotMatch(result.text, /```|-->|flowchart TD/);
  assert.match(result.text, /Request/);
  assert.match(result.text, /Done/);
});

test("successful narrator output cannot pass a literal table to speech", () => {
  const result = resolveSpeechText("source", {
    text: "| Name | Status |\n| --- | --- |\n| build | pass |",
  });
  assert.doesNotMatch(result.text, /\|/);
  assert.match(result.text, /build/);
});

test("speech text survives an unavailable narrator", () => {
  // Narrator ok -> passthrough, no fallback flag.
  assert.deepEqual(resolveSpeechText("raw text", { text: "Narrated text." }), {
    text: "Narrated text.",
  });
  // Narrator out of quota -> local cleanup, error preserved, fallback flagged.
  assert.deepEqual(
    resolveSpeechText("Done. See parseConfig in `helpers.ts`", {
      text: null,
      error: "LLM request failed (429)",
    }),
    {
      text: "Done. See parse Config in helpers dot ts",
      error: "LLM request failed (429)",
      fellBack: true,
    },
  );
  // Narrator failed AND the cleanup left nothing speakable (image-only reply)
  // -> empty text, still a fallback, no throw.
  assert.deepEqual(
    resolveSpeechText("![](screenshot.png)", { text: null, error: "quota exceeded" }),
    {
      text: "",
      error: "quota exceeded",
      fellBack: true,
    },
  );
});

// ---- registerTTS-level: TTS must not depend on model availability ----

function fakeTtsHost(assistantText = "Done. See parseConfig in helpers.ts") {
  const toasts = [];
  const logs = [];
  const disposes = [];
  const api = {
    client: {
      session: {
        list: async () => ({ data: [] }),
        message: async () => ({ data: { parts: [{ type: "text", text: assistantText }] } }),
      },
    },
    route: { current: { name: "session", params: { sessionID: "ses_1" } } },
    state: {
      session: {
        messages: () => [{ role: "user" }, { role: "assistant", id: "msg_1" }],
      },
    },
    event: { on: () => {} },
    ui: { toast: (t) => toasts.push(t), dialog: {} },
    lifecycle: { onDispose: (fn) => disposes.push(fn) },
  };
  const kv = {
    get: (key, fallback) => (key === "tts.mode" ? "on" : fallback),
    set: () => {},
  };
  const logger = { log: (scope, message, level) => logs.push({ scope, message, level }) };
  return { api, kv, logger, toasts, logs, disposes };
}

// speakAssistantTurn with an empty PATH: piperOnPath() reads process.env.PATH,
// so playback bails before spawning rather than making the test suite talk.
async function speakTurnWithoutPlayback(host) {
  const complete = async () => host.llmResult;
  const { controller } = registerTTS(host.api, host.kv, complete, undefined, {}, host.logger);
  const realPath = process.env.PATH;
  process.env.PATH = "";
  try {
    return await controller.speakAssistantTurn();
  } finally {
    process.env.PATH = realPath;
  }
}

test("an out-of-quota narrator still speaks the local cleanup", async () => {
  const host = fakeTtsHost();
  host.llmResult = { text: null, error: "quota exceeded" };

  const outcome = await speakTurnWithoutPlayback(host);

  // Reached speak instead of returning early with the normalization error.
  assert.deepEqual(outcome, { spoken: true });
  const messages = host.toasts.map((t) => t.message);
  assert.ok(messages.includes("Model unavailable - speaking text as-is"));
  assert.equal(messages.filter((m) => /normalization failed/i.test(m)).length, 0);
  assert.ok(
    host.logs.some((l) => l.level === "warn" && l.message.includes("speaking local cleanup")),
  );
});

test("a working narrator is untouched by the fallback", async () => {
  const host = fakeTtsHost();
  host.llmResult = { text: "Narrated text." };

  const outcome = await speakTurnWithoutPlayback(host);

  assert.deepEqual(outcome, { spoken: true });
  assert.equal(host.toasts.filter((t) => /Model unavailable/i.test(t.message)).length, 0);
  assert.equal(host.logs.filter((l) => /speaking local cleanup/.test(l.message)).length, 0);
});

test("nothing to read after the fallback stays quiet", async () => {
  const host = fakeTtsHost("![](screenshot.png)");
  host.llmResult = { text: null, error: "quota exceeded" };

  const outcome = await speakTurnWithoutPlayback(host);

  assert.deepEqual(outcome, { spoken: false });
  const messages = host.toasts.map((t) => t.message);
  assert.equal(messages.filter((m) => /normalization failed/i.test(m)).length, 0);
  assert.ok(!messages.some((m) => /Model unavailable/i.test(m)));
  assert.ok(host.logs.some((l) => l.level === "debug" && /nothing speakable/.test(l.message)));
});

// ---- Chatterbox engine: routing, playback, per-utterance Piper fallback ----
// Both branches are observable WITHOUT audio, thanks to an empty PATH:
// - "Piper binary not found on PATH" proves the Piper branch ran (it bails in
//   resolveVoiceOrWarn, before spawning anything).
// - a "play error" log proves a sox `play` process WAS spawned and failed to
//   launch, i.e. the shared playback path really received something. With PATH
//   empty the spawn can never hang, so these tests never touch real audio.

// A minimal but structurally valid WAV: the player measures the total from
// real frames, so fixtures must parse like real synthesizer output.
function makeTestWav(seconds = 2, sampleRate = 22050) {
  const dataLen = Math.floor(seconds * sampleRate) * 2;
  const wav = Buffer.alloc(44 + dataLen);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataLen, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataLen, 40);
  return wav;
}

function fakeChatterbox({ startOk = true, synthesize } = {}) {
  const calls = { start: 0, synthesize: [], stop: 0 };
  return {
    calls,
    client: {
      start: async () => {
        calls.start += 1;
        return startOk;
      },
      isRunning: () => startOk,
      getLastError: () => ({
        code: "MODEL_LOAD_FAILED",
        message: "chatterbox-tts not installed",
      }),
      synthesize:
        synthesize ??
        (async (text, lang) => {
          calls.synthesize.push({ text, lang });
          return { ok: true, wav: makeTestWav(2) };
        }),
      stop: () => {
        calls.stop += 1;
      },
    },
  };
}

// Default synthesize records the call; the default one above already does, so a
// failing fake just returns an error.
function failingChatterbox(message = "synthesis exploded") {
  const calls = { start: 0, synthesize: [], stop: 0 };
  return {
    calls,
    client: {
      start: async () => {
        calls.start += 1;
        return true;
      },
      isRunning: () => true,
      getLastError: () => ({ code: "SYNTH_TIMEOUT", message }),
      synthesize: async (text, lang) => {
        calls.synthesize.push({ text, lang });
        return { ok: false, code: "SYNTH_TIMEOUT", message };
      },
      stop: () => {
        calls.stop += 1;
      },
    },
  };
}

// speak() with PATH emptied, so neither branch can make noise.
// speak() with PATH emptied, so neither branch can make noise. Registers the
// plugin ONCE and returns its controller: the outage toast latch is per-session
// state, so a fresh registerTTS per utterance would reset it and hide the very
// behaviour under test.
function chatterboxHost(host, opts, chatterbox) {
  const { controller } = registerTTS(
    host.api,
    host.kv,
    async () => ({}),
    undefined,
    opts,
    host.logger,
    { createChatterboxClient: () => chatterbox.client },
  );
  return controller;
}

async function speakWithPathCleared(host, text, opts, chatterbox) {
  const controller = chatterboxHost(host, opts, chatterbox);
  const realPath = process.env.PATH;
  process.env.PATH = "";
  try {
    return await controller.speak(text);
  } finally {
    process.env.PATH = realPath;
  }
}

const piperMissed = (host) => host.toasts.filter((t) => /Piper binary not found/.test(t.message));
const playSpawned = (host) => host.logs.filter((l) => /play error/.test(l.message));

test("an English utterance plays through the Chatterbox path, not Piper", async () => {
  const host = fakeTtsHost();
  const cb = fakeChatterbox();

  await speakWithPathCleared(host, "Deploying now.", { ttsEngine: "chatterbox" }, cb);

  assert.equal(cb.calls.start, 1, "the sidecar is started lazily, on first use");
  assert.deepEqual(cb.calls.synthesize, [{ text: "Deploying now.", lang: "en" }]);
  // A sox play process was spawned for the WAV: the existing playback path.
  assert.equal(playSpawned(host).length, 1);
  assert.equal(piperMissed(host).length, 0, "Piper must not be consulted on success");
});

test("a Vietnamese utterance never reaches Chatterbox", async () => {
  const host = fakeTtsHost();
  const cb = fakeChatterbox();

  await speakWithPathCleared(host, "Xin chào, triển khai ngay.", { ttsEngine: "chatterbox" }, cb);

  // Chatterbox does not speak Vietnamese; Piper's real vi voice must.
  assert.equal(cb.calls.start, 0, "the sidecar must not load for a vi-only session");
  assert.equal(cb.calls.synthesize.length, 0);
  assert.equal(piperMissed(host).length, 1);
  assert.ok(
    host.logs.some((l) => l.level === "warn" && /cannot speak "vi"/.test(l.message)),
    "the skipped utterance is explained in the log, not toasted",
  );
  assert.equal(
    host.toasts.filter((t) => /cannot speak/i.test(t.message)).length,
    0,
    "no toast spam for a language Piper already handles",
  );
});

test("a sidecar that cannot start falls back to Piper for that utterance", async () => {
  const host = fakeTtsHost();
  const cb = fakeChatterbox({ startOk: false });

  await speakWithPathCleared(host, "Deploying now.", { ttsEngine: "chatterbox" }, cb);

  assert.equal(cb.calls.start, 1);
  assert.equal(cb.calls.synthesize.length, 0, "nothing is synthesized without a sidecar");
  assert.equal(piperMissed(host).length, 1, "speech continues on Piper");
  assert.ok(host.toasts.some((t) => /Chatterbox unavailable.*using Piper/.test(t.message)));
});

test("a failed synthesis falls back to Piper instead of going silent", async () => {
  const host = fakeTtsHost();
  const cb = failingChatterbox();

  await speakWithPathCleared(host, "Deploying now.", { ttsEngine: "chatterbox" }, cb);

  assert.equal(cb.calls.synthesize.length, 1);
  assert.equal(piperMissed(host).length, 1, "the utterance is still spoken");
  assert.ok(host.toasts.some((t) => /Chatterbox synthesis failed.*using Piper/.test(t.message)));
});

test("one toast per outage, not one per utterance, and recovery re-arms it", async () => {
  const host = fakeTtsHost();
  const cb = failingChatterbox();
  const opts = { ttsEngine: "chatterbox" };
  // One registered session across all four utterances, so its latch is what is
  // being measured.
  const controller = chatterboxHost(host, opts, cb);

  const realPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await controller.speak("First one.");
    await controller.speak("Second one.");
    await controller.speak("Third one.");

    const outageToasts = host.toasts.filter((t) => /Chatterbox synthesis failed/.test(t.message));
    assert.equal(outageToasts.length, 1, "three failed utterances must not toast three times");
    // Every utterance still retried the sidecar - no permanent latch.
    assert.equal(cb.calls.synthesize.length, 3);

    // A working engine re-arms the notice, so a LATER outage is reported again.
    // Swap the fake to success: without this "Recovered." would fail synthesis
    // exactly like the first three and never log the Chatterbox path.
    cb.client.synthesize = async (text, lang) => {
      cb.calls.synthesize.push({ text, lang });
      return { ok: true, wav: makeTestWav(2) };
    };
    await controller.speak("Recovered.");
    assert.equal(host.logs.filter((l) => /Speak via Chatterbox/.test(l.message)).length, 1);
    cb.calls.synthesize.length = 0;
    cb.client.synthesize = async (text, lang) => {
      cb.calls.synthesize.push({ text, lang });
      return { ok: false, code: "SYNTH_TIMEOUT", message: "synthesis exploded" };
    };
    await controller.speak("Fails again.");
    assert.equal(
      host.toasts.filter((t) => /Chatterbox synthesis failed/.test(t.message)).length,
      2,
    );
  } finally {
    process.env.PATH = realPath;
  }
});

test("a cancel during synthesis prevents playback entirely", async () => {
  const host = fakeTtsHost();
  const calls = { synthesize: [] };
  let release;
  const cb = {
    client: {
      start: async () => true,
      isRunning: () => true,
      getLastError: () => null,
      synthesize: (text, lang) => {
        calls.synthesize.push({ text, lang });
        return new Promise((resolve) => {
          release = () => resolve({ ok: true, wav: makeTestWav(2) });
        });
      },
      stop: () => {},
    },
  };
  const { controller } = registerTTS(
    host.api,
    host.kv,
    async () => ({}),
    undefined,
    { ttsEngine: "chatterbox" },
    host.logger,
    { createChatterboxClient: () => cb.client },
  );
  const realPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const speaking = controller.speak("Deploying now.");
    // A waiting synthesis still counts as speaking, so stop() acts on it.
    assert.equal(controller.isSpeaking(), true);
    // speak() awaits sidecar startup before synthesizing, so stop/release must
    // wait until the utterance is actually in-flight - otherwise this tests a
    // cancel-before-synthesis, not the mid-synthesis cancel under test.
    const deadline = Date.now() + 2000;
    while (calls.synthesize.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1));
    }
    assert.equal(calls.synthesize.length, 1, "synthesis must be in-flight before the cancel");
    controller.stop();
    assert.equal(controller.isSpeaking(), false);
    // The sidecar answers only after the cancel landed.
    release();
    await speaking;
  } finally {
    process.env.PATH = realPath;
  }

  assert.equal(calls.synthesize.length, 1);
  assert.equal(
    playSpawned(host).length,
    0,
    "no sox play process may be spawned for a cancelled utterance",
  );
  assert.equal(piperMissed(host).length, 0, "a cancel must not turn into Piper speech");
});

test("the sidecar is stopped when the plugin is disposed", async () => {
  const host = fakeTtsHost();
  const cb = fakeChatterbox();
  const { controller } = registerTTS(
    host.api,
    host.kv,
    async () => ({}),
    undefined,
    { ttsEngine: "chatterbox" },
    host.logger,
    { createChatterboxClient: () => cb.client },
  );

  const realPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await controller.speak("Deploying now.");
  } finally {
    process.env.PATH = realPath;
  }
  assert.equal(cb.calls.stop, 0, "a running sidecar outlives individual utterances");

  for (const fn of host.disposes) fn();
  assert.equal(cb.calls.stop, 1, "dispose releases the model, it does not strand it in RAM");
});

test("the default engine never constructs a Chatterbox client", async () => {
  const host = fakeTtsHost();
  let constructed = 0;
  const { controller } = registerTTS(
    host.api,
    host.kv,
    async () => ({}),
    undefined,
    {},
    host.logger,
    {
      createChatterboxClient: () => {
        constructed += 1;
        return fakeChatterbox().client;
      },
    },
  );

  const realPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await controller.speak("Run the build and check logs");
  } finally {
    process.env.PATH = realPath;
  }

  assert.equal(constructed, 0, "Piper is the default: no sidecar, no model, no ports");
  assert.equal(piperMissed(host).length, 1);
});

// ---- Measured playback wiring: buffered synth -> exact total -> player ----
// registerTTS drives lib/tts-player.js through injected seams (no audio):
// synthPiperToPcm replaces the piper spawn, resolveVoice replaces the
// voice-file probe, playerHooks replaces the sox spawn/clock.

function mapKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    set: (key, value) => {
      store.set(key, value);
    },
  };
}

function fakePlayerAudio(initialNow = 0) {
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
      const rec = { pid, argv, closeCb: null, fed: null };
      rec.onClose = (cb) => {
        rec.closeCb = cb;
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

function monoPcm16(seconds, rate = 22050) {
  return Buffer.alloc(Math.floor(seconds * rate) * 2);
}

function playerHost({
  opts = {},
  kvInitial = {},
  chatterbox = null,
  synthPcm = null,
  statusHooks = null,
} = {}) {
  const host = fakeTtsHost();
  host.kv = mapKv({ "tts.mode": "on", ...kvInitial });
  host.api.ui.DialogSelect = (props) => props;
  let replaced = null;
  host.api.ui.dialog.replace = (node) => {
    replaced = node;
  };
  host.api.ui.dialog.clear = () => {};
  host.ttsActions = null;
  host.api.setTtsStatusActions = (actions) => {
    host.ttsActions = actions;
  };
  if (statusHooks) {
    host.api.ttsStatus = statusHooks.status;
    host.api.setTtsStatusReader = statusHooks.setReader;
  }
  const audio = fakePlayerAudio();
  const deps = {
    playerHooks: {
      spawn: audio.spawn,
      signal: audio.signal,
      now: audio.now,
      feed: (handle, { wav }) => {
        handle.fed = wav;
      },
    },
    resolveVoice: () => "/fake/voice.onnx",
  };
  if (chatterbox) deps.createChatterboxClient = () => chatterbox.client;
  if (synthPcm) deps.synthPiperToPcm = synthPcm;
  const { controller, commands } = registerTTS(
    host.api,
    host.kv,
    async () => ({}),
    undefined,
    opts,
    host.logger,
    deps,
  );
  const command = (value) => commands.find((c) => c.value === value);
  // Let promise microtasks flush (synth -> load -> play) WITHOUT awaiting
  // the play promise itself: it only settles on close/stop.
  const settleTwice = async () => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
  return { host, audio, controller, commands, command, settleTwice, replaced: () => replaced };
}

test("piper audio is buffered and played with an exact measured total", async () => {
  const { audio, controller, settleTwice } = playerHost({ synthPcm: async () => monoPcm16(4) });

  const speaking = controller.speak("Hello there.");
  await settleTwice();
  assert.equal(audio.spawns.length, 1);
  assert.deepEqual(audio.spawns[0].argv, ["-q", "-"], "neutral playback carries no effects");
  assert.equal(audio.spawns[0].fed.length, 44 + monoPcm16(4).length, "full WAV fed to play");
  audio.spawns[0].emitClose(0);
  await speaking;

  const state = controller.getState();
  assert.equal(state.totalSec, 4);
  assert.equal(state.exactTotal, true);
  assert.equal(state.cursorApproximate, true);
  assert.equal(state.status, "idle");
});

test("pause freezes the cursor and resume continues it", async () => {
  const { audio, controller, settleTwice } = playerHost({ synthPcm: async () => monoPcm16(10) });

  const speaking = controller.speak("Hello there.");
  await settleTwice();
  audio.advance(2000);
  assert.equal(controller.getState().cursorSec, 2);
  assert.equal(controller.pause(), true);
  assert.deepEqual(audio.signals.at(-1), { pid: 100, sig: "SIGSTOP" });
  audio.advance(5000);
  assert.equal(controller.getState().cursorSec, 2, "paused playback must not advance");
  assert.equal(controller.getState().status, "paused");
  assert.equal(controller.resume(), true);
  assert.deepEqual(audio.signals.at(-1), { pid: 100, sig: "SIGCONT" });
  audio.advance(1000);
  assert.equal(controller.getState().cursorSec, 3);
  audio.spawns[0].emitClose(0);
  await speaking;
});

test("stop during piper synthesis never plays stale audio", async () => {
  let release = () => {};
  const { audio, controller } = playerHost({
    synthPcm: () =>
      new Promise((resolve) => {
        release = () => resolve(monoPcm16(4));
      }),
  });

  const speaking = controller.speak("Hello there.");
  await new Promise((r) => setImmediate(r));
  assert.equal(controller.isSpeaking(), true, "synthesis counts as speaking");
  controller.stop();
  assert.equal(controller.isSpeaking(), false);
  release();
  await speaking;

  assert.equal(audio.spawns.length, 0, "no play process for a stopped synthesis");
  assert.equal(controller.getState().status, "idle");
});

test("rate clamps, persists, and applies to playback", async () => {
  const { audio, controller, settleTwice, host } = playerHost({
    synthPcm: async () => monoPcm16(10),
  });

  assert.equal(controller.setRate(5), 2);
  assert.equal(controller.setRate(0.1), 0.75);
  assert.equal(host.kv.get("tts.rate"), 0.75, "clamped rate persists");
  controller.setRate(1.5);
  const speaking = controller.speak("Hello there.");
  await settleTwice();
  assert.ok(audio.spawns[0].argv.includes("tempo"), "rate effect present");
  assert.ok(audio.spawns[0].argv.includes("1.5"));
  audio.spawns[0].emitClose(0);
  await speaking;
});

test("corrupt chatterbox audio falls back to piper instead of going silent", async () => {
  const host = fakeTtsHost();
  const cb = fakeChatterbox();
  cb.client.synthesize = async () => ({ ok: true, wav: Buffer.from("junk") });
  const { controller } = registerTTS(
    host.api,
    host.kv,
    async () => ({}),
    undefined,
    { ttsEngine: "chatterbox" },
    host.logger,
    { createChatterboxClient: () => cb.client },
  );

  const realPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await controller.speak("Deploying now.");
  } finally {
    process.env.PATH = realPath;
  }

  assert.ok(
    host.toasts.some((t) => /BAD_WAV/.test(t.message)),
    "corrupt audio is reported",
  );
  assert.equal(piperMissed(host).length, 1, "speech still attempts Piper");
});

test("pause command toggles and reports state", async () => {
  const { audio, controller, command, host, settleTwice } = playerHost({
    synthPcm: async () => monoPcm16(10),
  });
  const pause = command("tts.pause");

  pause.onSelect();
  assert.ok(host.toasts.some((t) => /Nothing playing/.test(t.message)));

  const speaking = controller.speak("Hello there.");
  await settleTwice();
  audio.advance(1000);
  pause.onSelect();
  assert.ok(host.toasts.some((t) => t.message === "Paused"));
  assert.equal(controller.getState().status, "paused");
  pause.onSelect();
  assert.ok(host.toasts.some((t) => t.message === "Resumed"));
  audio.spawns[0].emitClose(0);
  await speaking;
});

test("rewind and forward move the cursor and clamp to the measured total", async () => {
  const { audio, controller, command, host, settleTwice } = playerHost({
    synthPcm: async () => monoPcm16(10),
  });
  const speaking = controller.speak("Hello there.");
  await settleTwice();

  controller.forward(99);
  assert.equal(controller.getState().cursorSec, 10);
  controller.rewind(99);
  assert.equal(controller.getState().cursorSec, 0);
  controller.forward(3.5);
  assert.equal(controller.getState().cursorSec, 3.5);

  command("tts.rewind").onSelect();
  assert.ok(host.toasts.some((t) => /Rewound \(0:00 \/ 0:10\)/.test(t.message)));
  command("tts.forward").onSelect();
  assert.ok(host.toasts.some((t) => /Forwarded \(0:05 \/ 0:10\)/.test(t.message)));

  controller.replay();
  assert.equal(controller.getState().cursorSec, 0);
  audio.spawns.at(-1).emitClose(0);
  await speaking;
});

test("groupSentencesByLang splits vi/en spans preserving order", () => {
  assert.deepEqual(groupSentencesByLang("Xin chào. Hello world. Cảm ơn bạn."), [
    { lang: "vi", text: "Xin chào." },
    { lang: "en", text: "Hello world." },
    { lang: "vi", text: "Cảm ơn bạn." },
  ]);
  assert.deepEqual(groupSentencesByLang("Hello world. How are you."), [
    { lang: "en", text: "Hello world. How are you." },
  ]);
  assert.deepEqual(groupSentencesByLang(""), []);
  assert.deepEqual(groupSentencesByLang("  "), []);
});

test("mixed vi/en utterance routes each group to its engine in order", async () => {
  const piperCalls = [];
  const cb = fakeChatterbox();
  const status = { begin: 0, update: 0, clear: 0 };
  let reader = null;
  const { audio, controller, settleTwice } = playerHost({
    opts: { ttsEngine: "chatterbox" },
    synthPcm: async (voice, line) => {
      piperCalls.push({ voice, line });
      return monoPcm16(2);
    },
    chatterbox: cb,
    statusHooks: {
      status: {
        begin: () => {
          status.begin += 1;
        },
        update: () => {
          status.update += 1;
        },
        clear: () => {
          status.clear += 1;
        },
      },
      setReader: (fn) => {
        reader = fn;
      },
    },
  });

  const speaking = controller.speak("Xin chào. Hello world.");
  await settleTwice();
  // vi group via Piper (Chatterbox has no vi), en group via Chatterbox.
  assert.deepEqual(
    piperCalls.map((c) => c.line),
    ["Xin chào."],
  );
  assert.deepEqual(
    cb.calls.synthesize.map((c) => ({ text: c.text, lang: c.lang })),
    [{ text: "Hello world.", lang: "en" }],
  );
  // Both groups buffered before either plays: two sequential playbacks.
  assert.equal(audio.spawns.length, 1, "first group plays first");
  audio.spawns[0].emitClose(0);
  await new Promise((r) => setImmediate(r));
  assert.equal(audio.spawns.length, 2, "second group plays after the first ends");
  const snap = reader();
  assert.equal(snap.totalSec, 4, "utterance total sums measured groups");
  assert.equal(snap.status, "playing");
  assert.equal(status.begin, 1, "status line mounts once per utterance");
  await new Promise((r) => setImmediate(r));
  audio.spawns[1].emitClose(0);
  await speaking;
  assert.equal(status.clear, 1, "status line clears when the chain ends");
});

test("stop during group synthesis drops the whole utterance", async () => {
  let releaseSecond = () => {};
  let synthCalls = 0;
  const { audio, controller, settleTwice } = playerHost({
    synthPcm: () =>
      new Promise((resolve) => {
        synthCalls += 1;
        if (synthCalls === 1) resolve(monoPcm16(1));
        else releaseSecond = () => resolve(monoPcm16(1));
      }),
  });

  const speaking = controller.speak("Xin chào. Hello there. Tạm biệt.");
  await settleTwice();
  // Group 2 synthesis is still pending: stop, then let it resolve late.
  controller.stop();
  releaseSecond();
  await speaking;
  assert.equal(synthCalls, 2, "third group never starts after a stop");
  assert.equal(audio.spawns.length, 0, "no audio plays for a stopped chain");
});

test("chatterbox failure falls back to piper for that group only", async () => {
  const piperCalls = [];
  const cb = fakeChatterbox();
  cb.client.synthesize = async (text, lang) => {
    cb.calls.synthesize.push({ text, lang });
    return { ok: false, code: "SYNTH_DOWN", message: "boom" };
  };
  const { audio, controller, settleTwice, host } = playerHost({
    opts: { ttsEngine: "chatterbox" },
    synthPcm: async (voice, line) => {
      piperCalls.push({ voice, line });
      return monoPcm16(1);
    },
    chatterbox: cb,
  });

  const speaking = controller.speak("Hello world.");
  await settleTwice();
  assert.deepEqual(
    piperCalls.map((c) => c.line),
    ["Hello world."],
  );
  assert.ok(
    host.toasts.some((t) => /SYNTH_DOWN/.test(t.message)),
    "group failure is reported",
  );
  assert.equal(audio.spawns.length, 1);
  audio.spawns[0].emitClose(0);
  await speaking;
});

test("media status begins on speak and clears on stop", async () => {
  const calls = { begin: 0, update: 0, clear: 0 };
  let reader = null;
  const { audio, controller, settleTwice } = playerHost({
    synthPcm: async () => monoPcm16(4),
    statusHooks: {
      status: {
        begin: () => {
          calls.begin += 1;
        },
        update: () => {
          calls.update += 1;
        },
        clear: () => {
          calls.clear += 1;
        },
      },
      setReader: (fn) => {
        reader = fn;
      },
    },
  });

  const speaking = controller.speak("Hello there.");
  await settleTwice();
  assert.equal(calls.begin, 1);
  const snap = reader();
  assert.equal(snap.totalSec, 4, "exact measured total, not an estimate");
  assert.equal(snap.status, "playing");
  audio.spawns[0].emitClose(0);
  await speaking;
  assert.equal(calls.clear, 1);
});

test("status actions drive pause, seek, and rate cycling", async () => {
  const { audio, controller, host, settleTwice } = playerHost({
    synthPcm: async () => monoPcm16(10),
  });
  const speaking = controller.speak("Hello there.");
  await settleTwice();
  const actions = host.ttsActions;
  assert.ok(actions, "status actions registered");
  actions.toggle();
  assert.equal(controller.getState().status, "paused");
  actions.toggle();
  assert.equal(controller.getState().status, "playing");
  actions.forward();
  assert.equal(Math.round(controller.getState().cursorSec), 5);
  actions.rewind();
  assert.equal(Math.round(controller.getState().cursorSec), 0);
  actions.rate();
  assert.equal(host.kv.get("tts.rate"), 1.25);
  actions.rate();
  assert.equal(host.kv.get("tts.rate"), 1.5);
  // Forward/rewind/rate all respawn the player; only closing the latest
  // process settles the play promise (stale closes are fenced).
  audio.spawns.at(-1).emitClose(0);
  await speaking;
});

test("status shows loading while synthesis is slow", async () => {
  let release = () => {};
  const calls = { begin: 0, update: 0, clear: 0 };
  let reader = null;
  const { audio, controller, settleTwice } = playerHost({
    synthPcm: () =>
      new Promise((resolve) => {
        release = () => resolve(monoPcm16(4));
      }),
    statusHooks: {
      status: {
        begin: () => {
          calls.begin += 1;
        },
        update: () => {
          calls.update += 1;
        },
        clear: () => {
          calls.clear += 1;
        },
      },
      setReader: (fn) => {
        reader = fn;
      },
    },
  });

  const speaking = controller.speak("Hello there.");
  await settleTwice();
  assert.equal(calls.begin, 1, "line mounts before slow synthesis finishes");
  assert.equal(reader().status, "loading");
  release();
  await settleTwice();
  assert.equal(reader().status, "playing");
  assert.equal(reader().totalSec, 4);
  audio.spawns[0].emitClose(0);
  await speaking;
  assert.equal(calls.clear, 1);
});

test("rate command persists the chosen speed", () => {
  const { command, host, replaced } = playerHost();
  command("tts.rate").onSelect();
  // dialog.replace receives a render node (host contract); render it.
  const dialog = replaced()();
  assert.ok(dialog, "rate opens a dialog");
  dialog.options.find((o) => o.value === "1.5").onSelect();
  assert.equal(host.kv.get("tts.rate"), 1.5);
  assert.ok(host.toasts.some((t) => t.message === "Playback speed: 1.5x"));
});
