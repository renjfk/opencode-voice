import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CHATTERBOX_VARIANT,
  buildChatterboxArgs,
  chatterboxSupportsLang,
  createChatterboxClient,
  isChatterboxVariant,
  resolveTtsEngine,
} from "../lib/chatterbox-server.js";

// ---- Engine routing (pure; no sidecar, no model, no audio) ----

test("Piper is the default engine", () => {
  assert.deepEqual(resolveTtsEngine({}, "en"), { engine: "piper", reason: "default" });
  assert.deepEqual(resolveTtsEngine(undefined, "en"), { engine: "piper", reason: "default" });
  assert.deepEqual(resolveTtsEngine({ ttsEngine: "piper" }, "en"), {
    engine: "piper",
    reason: "default",
  });
});

test("an unknown ttsEngine warns and falls back to Piper", () => {
  const warns = [];
  const route = resolveTtsEngine({ ttsEngine: "elevenlabs" }, "en", (m) => warns.push(m));
  assert.equal(route.engine, "piper");
  assert.equal(route.reason, "unknown-engine");
  assert.equal(warns.length, 1);
  assert.match(warns[0], /Unknown ttsEngine "elevenlabs"/);
});

test("chatterbox handles English and defaults to the multilingual variant", () => {
  const route = resolveTtsEngine({ ttsEngine: "chatterbox" }, "en");
  assert.deepEqual(route, {
    engine: "chatterbox",
    variant: DEFAULT_CHATTERBOX_VARIANT,
    reason: "ok",
  });
});

test("Vietnamese routes to Piper on EVERY variant", () => {
  // Measured against chatterbox-tts 0.1.7: the multilingual model speaks 23
  // languages and vi is NOT one of them (generate() raises on language_id
  // "vi"), and nano/turbo are English-only. So a vi utterance must reach Piper
  // whichever variant is configured - reading it with an English voice would be
  // worse than Piper's real vi model.
  for (const variant of ["multilingual", "turbo", "nano"]) {
    const route = resolveTtsEngine(
      { ttsEngine: "chatterbox", ttsChatterboxVariant: variant },
      "vi",
    );
    assert.equal(route.engine, "piper", `${variant} must route vi to piper`);
    assert.equal(route.reason, "unsupported-language");
    assert.equal(chatterboxSupportsLang(variant, "vi"), false);
    assert.equal(chatterboxSupportsLang(variant, "en"), true);
  }
});

test("English is handled by every known variant", () => {
  for (const variant of ["multilingual", "turbo", "nano"]) {
    assert.equal(chatterboxSupportsLang(variant, "en"), true, `${variant} should speak en`);
    const route = resolveTtsEngine(
      { ttsEngine: "chatterbox", ttsChatterboxVariant: variant },
      "en",
    );
    assert.equal(route.engine, "chatterbox");
  }
  // An unknown variant is not trusted with any language - Piper answers instead.
  assert.equal(chatterboxSupportsLang("bogus", "en"), false);
});

test("an unknown variant warns and falls back to multilingual", () => {
  const warns = [];
  const route = resolveTtsEngine(
    { ttsEngine: "chatterbox", ttsChatterboxVariant: "ultra" },
    "en",
    (m) => warns.push(m),
  );
  assert.deepEqual(route, {
    engine: "chatterbox",
    variant: DEFAULT_CHATTERBOX_VARIANT,
    reason: "ok",
  });
  assert.match(warns[0], /Unknown ttsChatterboxVariant "ultra"/);
  assert.equal(isChatterboxVariant("ultra"), false);
});

test("builds sidecar args with host, port and variant", () => {
  assert.deepEqual(
    buildChatterboxArgs({
      scriptPath: "/pkg/vendor/chatterbox_server.py",
      host: "127.0.0.1",
      port: 8120,
      variant: "turbo",
    }),
    [
      "/pkg/vendor/chatterbox_server.py",
      "--host",
      "127.0.0.1",
      "--port",
      "8120",
      "--variant",
      "turbo",
    ],
  );
});

// ---- Sidecar client lifecycle ----
// Faked with an injectable fetch rather than a real listener, matching
// test/whisper-server.test.js. A real pre-listening socket cannot work here:
// the client probes the port BEFORE spawning and must refuse one that already
// answers (so it never claims or kills a foreign sidecar), which is exactly
// what a listening fake would trip.

function makeProc(pid = 5150) {
  const handlers = {};
  return {
    pid,
    killed: [],
    stderr: { on() {} },
    on(event, fn) {
      handlers[event] = fn;
    },
    kill(signal) {
      this.killed.push(signal);
    },
    emit(event, ...args) {
      handlers[event]?.(...args);
    },
  };
}

function connRefused() {
  const err = new Error("connect ECONNREFUSED 127.0.0.1:8120");
  err.code = "ECONNREFUSED";
  throw err;
}

function jsonResp(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function wavResp(buffer) {
  // Copy out of Buffer's shared pool: `buffer.buffer` would alias the pool and
  // hand back unrelated bytes.
  const copy = Uint8Array.from(buffer);
  return { ok: true, status: 200, arrayBuffer: async () => copy.buffer };
}

const READY_BODY = {
  ok: true,
  variant: "multilingual",
  device: "mps",
  phase: "ready",
  sr: 24000,
  supports_language: true,
  languages: ["en", "vi-placeholder-checked-by-sidecar"],
};

// A stand-in sidecar: silent until brought up (mirrors "our spawn made the port
// answer"), with a /health state machine and a /speak outcome the test picks.
function fakeSidecar({ healthStates, speak } = {}) {
  const state = { healthCalls: 0, speakBodies: [], speakCalls: 0 };
  let up = false;
  let healthAt = 0;
  const fetch = async (url, opts) => {
    const href = String(url);
    if (!up) connRefused();
    if (href.endsWith("/health")) {
      state.healthCalls += 1;
      const picked = healthStates
        ? (healthStates[Math.min(healthAt++, healthStates.length - 1)] ?? healthStates.at(-1))
        : { status: 200, body: READY_BODY };
      return jsonResp(picked.status, picked.body);
    }
    if (href.endsWith("/speak")) {
      state.speakCalls += 1;
      state.speakBodies.push(JSON.parse(opts.body));
      return speak ? speak(opts) : wavResp(Buffer.from("RIFF0000WAVEfmt-data"));
    }
    connRefused();
  };
  fetch.setUp = (v) => {
    up = v !== false;
  };
  fetch.state = state;
  return fetch;
}

function clientWith({ fetch, procs, onSpawn, ...overrides } = {}) {
  const spawnCalls = [];
  const client = createChatterboxClient({
    port: 8120,
    portScanMax: 1,
    readyTimeoutMs: 2000,
    readyPollMs: 5,
    synthesizeTimeoutMs: 200,
    deps: {
      spawn: (bin) => {
        spawnCalls.push({ bin });
        onSpawn?.();
        return procs?.length > 0 ? procs.shift() : makeProc();
      },
      fetch,
    },
    ...overrides,
  });
  return { client, spawnCalls };
}

function readyClient({ proc = makeProc(111), fetch, ...overrides } = {}) {
  fetch = fetch ?? fakeSidecar();
  const built = clientWith({
    fetch,
    procs: [proc],
    onSpawn: () => fetch.setUp(true),
    ...overrides,
  });
  return { ...built, proc, fetch };
}

test("start becomes ready via /health and reuses the owned sidecar", async () => {
  const proc = makeProc(111);
  const fetch = fakeSidecar();
  const { client, spawnCalls } = readyClient({ proc, fetch });

  assert.equal(await client.start(), true);
  assert.equal(client.isRunning(), true);
  assert.equal(client.getPort(), 8120);
  assert.equal(client.getLastError(), null);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].bin, "python3");

  // Second start reuses the running sidecar: the model is never loaded twice.
  assert.equal(await client.start(), true);
  assert.equal(spawnCalls.length, 1);

  client.stop();
  assert.equal(client.isRunning(), false);
  assert.deepEqual(proc.killed, ["SIGTERM"]);
});

test("start uses the configured interpreter and forwards the variant", async () => {
  const fetch = fakeSidecar();
  const { client, spawnCalls } = readyClient({
    fetch,
    python: "/custom/venv/bin/python",
    variant: "turbo",
  });

  await client.start();
  assert.equal(spawnCalls[0].bin, "/custom/venv/bin/python");
  client.stop();
});

test("start waits through /health 503 (model loading) before ready", async () => {
  const fetch = fakeSidecar({
    healthStates: [
      { status: 503, body: { ok: false, phase: "loading" } },
      { status: 503, body: { ok: false, phase: "loading" } },
      { status: 200, body: READY_BODY },
    ],
  });
  const { client } = readyClient({ fetch });

  assert.equal(await client.start(), true);
  assert.ok(fetch.state.healthCalls >= 3, "should poll through the loading phase");
  client.stop();
});

test("a failed model load fails fast with the sidecar's own reason", async () => {
  // The point of the 503 body: a broken install explains itself instead of
  // burning the whole readiness budget on a load that can never succeed.
  const fetch = fakeSidecar({
    healthStates: [
      {
        status: 503,
        body: { ok: false, phase: "failed", error: "chatterbox-tts not installed" },
      },
    ],
  });
  const { client } = readyClient({ fetch, readyTimeoutMs: 60000 });

  const started = Date.now();
  assert.equal(await client.start(), false);
  assert.ok(Date.now() - started < 5000, "must fail fast, not wait out the readiness bound");
  assert.equal(client.getLastError().code, "MODEL_LOAD_FAILED");
  assert.match(client.getLastError().message, /chatterbox-tts not installed/);
});

test("an occupied port is refused, never claimed - the scan advances", async () => {
  // 8120 permanently answers (another TUI's sidecar), so it must be refused;
  // 8121 is silent until our own spawn brings it up.
  const proc = makeProc(222);
  let up = false;
  const fetch = async (url) => {
    const href = String(url);
    if (href.includes(":8120")) {
      return href.endsWith("/health") ? jsonResp(200, READY_BODY) : connRefused();
    }
    if (!up) connRefused();
    return jsonResp(200, READY_BODY);
  };
  const { client, spawnCalls } = clientWith({
    fetch,
    procs: [proc],
    onSpawn: () => {
      up = true;
    },
    portScanMax: 2,
  });

  assert.equal(await client.start(), true);
  assert.equal(client.getPort(), 8121);
  assert.equal(spawnCalls.length, 1, "only the unclaimed port gets a spawn");
  client.stop();
  assert.deepEqual(proc.killed, ["SIGTERM"], "the process we spawned is signalled");
});

test("an exhausted port range refuses without spawning", async () => {
  const fetch = async (url) =>
    String(url).endsWith("/health") ? jsonResp(200, READY_BODY) : connRefused();
  const { client, spawnCalls } = clientWith({ fetch: Object.assign(fetch, { setUp() {} }) });

  assert.equal(await client.start(), false);
  assert.equal(client.getLastError().code, "PORT_RANGE_EXHAUSTED");
  assert.equal(spawnCalls.length, 0);
});

test("health() reports the loaded device and language support", async () => {
  const fetch = fakeSidecar();
  const { client } = readyClient({ fetch });
  await client.start();

  const health = await client.health();

  assert.equal(health.ok, true);
  assert.equal(health.device, "mps");
  assert.equal(health.sr, 24000);
  client.stop();
});

test("synthesize returns the wav bytes", async () => {
  const fetch = fakeSidecar();
  const { client } = readyClient({ fetch });
  await client.start();

  const result = await client.synthesize("Deploying now.", "en");

  assert.equal(result.ok, true);
  assert.ok(Buffer.isBuffer(result.wav));
  assert.equal(result.wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(fetch.state.speakBodies[0].text, "Deploying now.");
  assert.equal(fetch.state.speakBodies[0].language_id, "en");
  client.stop();
});

test("an unset voice reference synthesizes voiceless", async () => {
  const fetch = fakeSidecar();
  const { client } = readyClient({ fetch });
  await client.start();

  await client.synthesize("No reference voice.", "en");

  // Key absent, not empty-string: the sidecar reads a missing key as "use the
  // model's default voice".
  assert.equal("voice_ref" in fetch.state.speakBodies[0], false);
  client.stop();
});

test("a configured voice reference is forwarded to the sidecar", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-cb-test-"));
  const ref = path.join(dir, "ref.wav");
  fs.writeFileSync(ref, "RIFF");
  try {
    const fetch = fakeSidecar();
    const { client } = readyClient({ fetch, voiceRef: ref });
    await client.start();

    await client.synthesize("Cloned voice.", "en");

    assert.equal(fetch.state.speakBodies[0].voice_ref, ref);
    client.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing voice reference warns and proceeds with the default voice", async () => {
  // Losing the reference clip must not lose the engine: it still speaks, just
  // with the model's own voice.
  const warnings = [];
  const fetch = fakeSidecar();
  const { client } = readyClient({
    fetch,
    voiceRef: "/definitely/not/here.wav",
    logger: { log: (_scope, message, level) => level === "warn" && warnings.push(message) },
  });
  await client.start();

  await client.synthesize("Still speaks.", "en");

  assert.ok(warnings.some((m) => /voice reference not found/i.test(m)));
  assert.equal("voice_ref" in fetch.state.speakBodies[0], false);
  client.stop();
});

test("a sidecar error becomes a typed error carrying its reason", async () => {
  const fetch = fakeSidecar({
    speak: () => jsonResp(400, { ok: false, error: "language 'vi' not supported by this model" }),
  });
  const { client } = readyClient({ fetch });
  await client.start();

  const result = await client.synthesize("Xin chào", "vi");

  assert.equal(result.ok, false);
  assert.equal(result.code, "BAD_STATUS");
  assert.match(result.message, /not supported by this model/);
  client.stop();
});

test("a hung synthesis times out into a typed error instead of stalling speech", async () => {
  const fetch = fakeSidecar({
    // Never answers, but honours the abort signal exactly like undici does -
    // without that, the stub would hang forever instead of letting the
    // client's synthesize bound fire.
    speak: (opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted due to timeout");
          err.name = "TimeoutError";
          reject(err);
        });
      }),
  });
  const { client } = readyClient({ fetch, synthesizeTimeoutMs: 120 });
  await client.start();

  const result = await client.synthesize("This one hangs.", "en");

  assert.equal(result.ok, false);
  assert.equal(result.code, "SYNTH_TIMEOUT");
  assert.match(result.message, /chatterbox synthesis failed/);
  client.stop();
});

test("empty audio is rejected rather than played", async () => {
  const fetch = fakeSidecar({ speak: () => wavResp(Buffer.alloc(0)) });
  const { client } = readyClient({ fetch });
  await client.start();

  const result = await client.synthesize("Silence?", "en");

  assert.equal(result.ok, false);
  assert.equal(result.code, "EMPTY_AUDIO");
  client.stop();
});

test("a mid-session sidecar crash surfaces as a typed error", async () => {
  const proc = makeProc(333);
  const fetch = fakeSidecar();
  const { client } = readyClient({ proc, fetch });
  await client.start();

  proc.emit("exit", 1);
  const result = await client.synthesize("After the crash.", "en");

  assert.equal(result.ok, false);
  assert.equal(result.code, "EXITED");
  assert.match(result.message, /exited \(code=1\)/);
});

test("synthesize before start is NOT_READY, never a throw", async () => {
  const client = createChatterboxClient({ deps: { spawn: () => makeProc() } });

  const result = await client.synthesize("Too early.", "en");

  assert.equal(result.ok, false);
  assert.equal(result.code, "NOT_READY");
});

test("a late exit from a replaced child never wipes the new handle", async () => {
  const first = makeProc(444);
  const second = makeProc(555);
  const fetch = fakeSidecar();
  const queue = [first, second];
  const client = createChatterboxClient({
    port: 8120,
    portScanMax: 1,
    readyTimeoutMs: 1000,
    readyPollMs: 5,
    deps: {
      spawn: () => {
        fetch.setUp(true);
        return queue.shift() ?? makeProc();
      },
      fetch,
    },
  });
  await client.start();
  client.stop();
  // Our child is gone, so the port goes quiet again - exactly as it would in
  // production, which is what lets the next start() claim it.
  fetch.setUp(false);
  // A new session starts a new child; the old one's late exit must not clear it.
  await client.start();
  assert.equal(client.isRunning(), true);

  first.emit("exit", 0);

  assert.equal(client.isRunning(), true, "the replacement child must stay ready");
  client.stop();
});

test("a spawn failure is reported as SPAWN_FAILED, not thrown", async () => {
  const fetch = fakeSidecar();
  const { client } = clientWith({
    fetch: Object.assign(fetch, { setUp() {} }),
    deps: {
      spawn: () => {
        throw new Error("spawn python3 ENOENT");
      },
      fetch,
    },
  });

  assert.equal(await client.start(), false);
  assert.equal(client.getLastError().code, "SPAWN_FAILED");
  assert.match(client.getLastError().message, /ENOENT/);
});
