import assert from "node:assert/strict";
import test from "node:test";

import {
  __clearSharedWhisperServersForTest,
  acquireSharedWhisperServer,
  buildWhisperServerArgs,
  createWhisperServerClient,
} from "../lib/whisper-server.js";

test("builds whisper-server args with model, language, host, port", () => {
  assert.deepEqual(
    buildWhisperServerArgs({
      modelPath: "/models/ggml.bin",
      language: "en",
      host: "127.0.0.1",
      port: 8090,
    }),
    ["-m", "/models/ggml.bin", "-l", "en", "--host", "127.0.0.1", "--port", "8090"],
  );
});

test("defaults language to auto and includes threads when given", () => {
  assert.deepEqual(
    buildWhisperServerArgs({
      modelPath: "/models/ggml.bin",
      host: "127.0.0.1",
      port: 8090,
      threads: 4,
    }),
    ["-m", "/models/ggml.bin", "-l", "auto", "--host", "127.0.0.1", "--port", "8090", "-t", "4"],
  );
});

// ---- Lifecycle hardening (stage 1): fakes, no real processes/ports ----

function makeProc(pid = 4242) {
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

function makeFetch(handler) {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push(String(url));
    return handler(String(url), opts);
  };
  fetch.calls = calls;
  return fetch;
}

function okJson(body, server = "whisper.cpp") {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === "server" ? server : null) },
    json: async () => body,
  };
}

function statusOnly(status, server = "whisper.cpp") {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === "server" ? server : null) },
    json: async () => ({}),
  };
}

function connRefused() {
  const err = new Error("connect ECONNREFUSED 127.0.0.1:8090");
  err.code = "ECONNREFUSED";
  throw err;
}

function clientWith({ fetch, procs, onSpawn, ...overrides } = {}) {
  const spawnCalls = [];
  const spawn =
    procs === undefined
      ? () => {
          throw new Error("spawn should not have been called");
        }
      : (bin, args, opts) => {
          spawnCalls.push({ bin, args, opts });
          onSpawn?.();
          const proc = procs.length > 0 ? procs.shift() : makeProc();
          return proc;
        };
  const client = createWhisperServerClient({
    modelPath: "/models/ggml.bin",
    language: "en",
    port: 8090,
    readyTimeoutMs: 500,
    readyPollMs: 5,
    deps: { spawn, fetch: fetch || (async () => connRefused()) },
    ...overrides,
  });
  return { client, spawnCalls };
}

test("start becomes ready via /health and reuses the owned server", async () => {
  const proc = makeProc(111);
  // Nothing listens until our spawn brings the server up.
  let up = false;
  const fetch = makeFetch(async (url) => {
    if (!up) return connRefused();
    if (url.endsWith("/health")) return statusOnly(200);
    return connRefused();
  });
  const saved = process.env.PATH;
  // whisperServerOnPath checks the real PATH; point it at a fake dir holding
  // a whisper-server file instead of touching the environment globally.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-ws-test-"));
  try {
    fs.writeFileSync(path.join(dir, "whisper-server"), "#!/bin/sh\n");
    process.env.PATH = `${dir}${path.delimiter}${saved}`;
    const { client, spawnCalls } = clientWith({
      fetch,
      procs: [proc],
      onSpawn: () => {
        up = true;
      },
    });
    assert.equal(await client.start(), true);
    assert.equal(client.isRunning(), true);
    assert.equal(client.getOwnerPid(), 111);
    assert.equal(client.getLastError(), null);
    // Second start reuses: no second spawn.
    assert.equal(await client.start(), true);
    assert.equal(spawnCalls.length, 1);
    client.stop();
    assert.equal(client.isRunning(), false);
    assert.deepEqual(proc.killed, ["SIGTERM"]);
  } finally {
    process.env.PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("start waits through /health 503 (model loading) before ready", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-ws-test-"));
  const saved = process.env.PATH;
  try {
    fs.writeFileSync(path.join(dir, "whisper-server"), "#!/bin/sh\n");
    process.env.PATH = `${dir}${path.delimiter}${saved}`;
    let healthCalls = 0;
    let up = false;
    const fetch = makeFetch(async (url) => {
      if (!up) return connRefused();
      if (url.endsWith("/health")) {
        healthCalls += 1;
        return healthCalls < 3 ? statusOnly(503) : statusOnly(200);
      }
      return connRefused();
    });
    const { client } = clientWith({
      fetch,
      procs: [makeProc(222)],
      onSpawn: () => {
        up = true;
      },
    });
    assert.equal(await client.start(), true);
    assert.ok(healthCalls >= 3);
    client.stop();
  } finally {
    process.env.PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("start refuses a foreign-owned port and never spawns or kills", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-ws-test-"));
  const saved = process.env.PATH;
  try {
    fs.writeFileSync(path.join(dir, "whisper-server"), "#!/bin/sh\n");
    process.env.PATH = `${dir}${path.delimiter}${saved}`;
    // Something (not ours) already answers on the port.
    const fetch = makeFetch(async () => statusOnly(200, "some-other-app"));
    const { client, spawnCalls } = clientWith({ fetch });
    assert.equal(await client.start(), false);
    assert.equal(spawnCalls.length, 0);
    assert.equal(client.getLastError()?.code, "PORT_IN_USE");
    assert.match(client.getLastError()?.message || "", /another process/);
    // Explicit failure for a later batch fallback - code is machine-readable.
    const r = await client.transcribeFile("/tmp/whatever.wav");
    assert.equal(r.code, "PORT_IN_USE");
    assert.match(r.error, /another process/);
    client.stop(); // no owned proc: must not throw
  } finally {
    process.env.PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy server without /health is accepted only via whisper Server header", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-ws-test-"));
  const saved = process.env.PATH;
  try {
    fs.writeFileSync(path.join(dir, "whisper-server"), "#!/bin/sh\n");
    process.env.PATH = `${dir}${path.delimiter}${saved}`;
    // Legacy whisper build: /health 404, base URL identifies whisper.cpp.
    let up = false;
    const legacyFetch = makeFetch(async (url) => {
      if (!up) return connRefused();
      if (url.endsWith("/health")) return statusOnly(404, "whisper.cpp");
      return statusOnly(200, "whisper.cpp");
    });
    const { client: legacy } = clientWith({
      fetch: legacyFetch,
      procs: [makeProc(333)],
      onSpawn: () => {
        up = true;
      },
    });
    assert.equal(await legacy.start(), true);
    legacy.stop();

    // Impostor: /health 404 and base URL is some other app -> never ready.
    let up2 = false;
    const impostorFetch = makeFetch(async (url) => {
      if (!up2) return connRefused();
      if (url.endsWith("/health")) return statusOnly(404, "nginx");
      return statusOnly(200, "nginx");
    });
    const owned = makeProc(444);
    const { client: impostor } = clientWith({
      fetch: impostorFetch,
      procs: [owned],
      onSpawn: () => {
        up2 = true;
      },
      readyTimeoutMs: 40,
      readyPollMs: 5,
    });
    assert.equal(await impostor.start(), false);
    assert.equal(impostor.getLastError()?.code, "START_TIMEOUT");
    // The owned proc we spawned is ours to clean up - and only ours.
    assert.deepEqual(owned.killed, ["SIGTERM"]);
  } finally {
    process.env.PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("transcribeBuffer passes response_format through and returns segments", async () => {
  const proc = makeProc(555);
  let seenBody = null;
  let up = false;
  const fetch = makeFetch(async (url, opts) => {
    if (!up) return connRefused();
    if (url.endsWith("/health")) return statusOnly(200);
    if (url.endsWith("/inference")) {
      seenBody = opts?.body;
      return okJson({
        text: " hello world ",
        segments: [{ id: 0, start: 0.0, end: 1.2, text: " hello world" }],
      });
    }
    return connRefused();
  });
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-ws-test-"));
  const saved = process.env.PATH;
  try {
    fs.writeFileSync(path.join(dir, "whisper-server"), "#!/bin/sh\n");
    process.env.PATH = `${dir}${path.delimiter}${saved}`;
    const { client } = clientWith({
      fetch,
      procs: [proc],
      onSpawn: () => {
        up = true;
      },
    });
    assert.equal(await client.start(), true);
    const r = await client.transcribeBuffer(Buffer.from("RIFFfake"), {
      responseFormat: "verbose_json",
    });
    assert.equal(r.text, "hello world");
    assert.equal(r.segments?.length, 1);
    assert.equal(r.segments[0].end, 1.2);
    assert.ok(seenBody instanceof FormData);
    client.stop();
  } finally {
    process.env.PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("transcribeBuffer honors an external abort signal with ABORTED", async () => {
  const proc = makeProc(556);
  let up = false;
  const fetch = makeFetch(async (url, opts) => {
    if (!up) return connRefused();
    if (url.endsWith("/health")) return statusOnly(200);
    if (url.endsWith("/inference")) {
      // Hang until the caller aborts, like a slow decode.
      await new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
      return okJson({ text: "never" });
    }
    return connRefused();
  });
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-ws-test-"));
  const saved = process.env.PATH;
  try {
    fs.writeFileSync(path.join(dir, "whisper-server"), "#!/bin/sh\n");
    process.env.PATH = `${dir}${path.delimiter}${saved}`;
    const { client } = clientWith({
      fetch,
      procs: [proc],
      onSpawn: () => {
        up = true;
      },
    });
    assert.equal(await client.start(), true);
    const controller = new AbortController();
    const p = client.transcribeBuffer(Buffer.from("RIFFfake"), { signal: controller.signal });
    controller.abort();
    const r = await p;
    assert.equal(r.code, "ABORTED");
    client.stop();
  } finally {
    process.env.PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shared servers refcount: one client, released only when all holders release", async () => {
  __clearSharedWhisperServersForTest();
  try {
    const a = acquireSharedWhisperServer({ modelPath: "/m.bin", language: "en", port: 8091 });
    const b = acquireSharedWhisperServer({ modelPath: "/m.bin", language: "en", port: 8091 });
    assert.equal(a.client, b.client);
    const c = acquireSharedWhisperServer({ modelPath: "/m.bin", language: "en", port: 8092 });
    assert.notEqual(a.client, c.client);
    let stopped = 0;
    const origStop = a.client.stop;
    a.client.stop = () => {
      stopped += 1;
      return origStop();
    };
    a.release();
    assert.equal(stopped, 0); // b still holds it
    b.release();
    assert.equal(stopped, 1); // last holder triggers stop
    c.release();
  } finally {
    __clearSharedWhisperServersForTest();
  }
});

// ---- Multi-TUI port auto-advance: default path scans, explicit stays strict ----

function portOf(url) {
  const m = String(url).match(/:(\d+)(?:\/|$)/);
  return m ? Number(m[1]) : 0;
}

async function withFakeWhisperBinary(fn) {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-ws-test-"));
  const saved = process.env.PATH;
  try {
    fs.writeFileSync(path.join(dir, "whisper-server"), "#!/bin/sh\n");
    process.env.PATH = `${dir}${path.delimiter}${saved}`;
    await fn();
  } finally {
    process.env.PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Default-path client: no `port` passed, so start() scans upward from 8090.
function autoClientWith({ fetch, procs, onSpawn, ...overrides } = {}) {
  const spawnCalls = [];
  const spawn =
    procs === undefined
      ? () => {
          throw new Error("spawn should not have been called");
        }
      : (bin, args, opts) => {
          spawnCalls.push({ bin, args, opts });
          onSpawn?.();
          const proc = procs.length > 0 ? procs.shift() : makeProc();
          return proc;
        };
  const client = createWhisperServerClient({
    modelPath: "/models/ggml.bin",
    language: "en",
    readyTimeoutMs: 500,
    readyPollMs: 5,
    deps: { spawn, fetch: fetch || (async () => connRefused()) },
    ...overrides,
  });
  return { client, spawnCalls };
}

test("default path claims 8091 when 8090 already answers, getPort reports it", async () => {
  await withFakeWhisperBinary(async () => {
    const proc = makeProc(777);
    let up8091 = false;
    const fetch = makeFetch(async (url) => {
      const p = portOf(url);
      if (p === 8090) return statusOnly(200, "whisper.cpp"); // first TUI owns it
      if (p === 8091) {
        if (!up8091) return connRefused();
        if (String(url).endsWith("/health")) return statusOnly(200);
        return connRefused();
      }
      return connRefused();
    });
    const { client, spawnCalls } = autoClientWith({
      fetch,
      procs: [proc],
      onSpawn: () => {
        up8091 = true;
      },
    });
    assert.equal(await client.start(), true);
    assert.equal(client.getPort(), 8091);
    assert.equal(spawnCalls.length, 1);
    assert.ok(spawnCalls[0].args.includes("8091"));
    client.stop();
    assert.deepEqual(proc.killed, ["SIGTERM"]);
  });
});

test("explicit port still refuses PORT_IN_USE and never scans", async () => {
  await withFakeWhisperBinary(async () => {
    const fetch = makeFetch(async () => statusOnly(200, "whisper.cpp"));
    const { client, spawnCalls } = clientWith({ fetch }); // port 8090, explicit
    assert.equal(await client.start(), false);
    assert.equal(client.getLastError()?.code, "PORT_IN_USE");
    assert.equal(client.getPort(), 8090);
    assert.equal(spawnCalls.length, 0);
    client.stop();
  });
});

function makeRacingProc(pid) {
  const p = makeProc(pid);
  let dataHandler = null;
  p.stderr = {
    on(evt, fn) {
      if (evt === "data") dataHandler = fn;
    },
  };
  p.loseBindRace = () => {
    dataHandler?.(Buffer.from("error: failed to bind to 127.0.0.1:8090 - Address already in use"));
    p.emit("exit", 1);
  };
  return p;
}

test("bind race on 8090 advances to 8091 without killing anything foreign", async () => {
  await withFakeWhisperBinary(async () => {
    const raceProc = makeRacingProc(888);
    const goodProc = makeProc(889);
    let spawns = 0;
    let up8091 = false;
    let raceConsumed = false;
    const fetch = makeFetch(async (url) => {
      const p = portOf(url);
      if (!spawns) return connRefused(); // pre-spawn probes: port is free
      if (p === 8090 && spawns === 1 && !raceConsumed) {
        raceConsumed = true;
        raceProc.loseBindRace(); // sibling TUI won between probe and spawn
        return connRefused();
      }
      if (p === 8091) {
        if (!up8091) return connRefused();
        if (String(url).endsWith("/health")) return statusOnly(200);
        return connRefused();
      }
      return connRefused();
    });
    const { client, spawnCalls } = autoClientWith({
      fetch,
      procs: [raceProc, goodProc],
      onSpawn: () => {
        spawns += 1;
        if (spawns === 2) up8091 = true;
      },
    });
    assert.equal(await client.start(), true);
    assert.equal(client.getPort(), 8091);
    assert.equal(spawnCalls.length, 2);
    assert.ok(spawnCalls[0].args.includes("8090"));
    assert.ok(spawnCalls[1].args.includes("8091"));
    // The race loser exited on its own; we never signaled it, and the
    // foreign winner was never touched (only owned handles are signaled).
    assert.deepEqual(raceProc.killed, []);
    assert.deepEqual(goodProc.killed, []);
    client.stop();
    assert.deepEqual(goodProc.killed, ["SIGTERM"]);
    assert.deepEqual(raceProc.killed, []);
  });
});

test("exhausted range returns PORT_RANGE_EXHAUSTED without spawning", async () => {
  await withFakeWhisperBinary(async () => {
    const fetch = makeFetch(async () => statusOnly(200, "whisper.cpp"));
    const { client, spawnCalls } = autoClientWith({ fetch, portScanMax: 3 });
    assert.equal(await client.start(), false);
    assert.equal(client.getLastError()?.code, "PORT_RANGE_EXHAUSTED");
    assert.equal(spawnCalls.length, 0);
    const r = await client.transcribeFile("/tmp/whatever.wav");
    assert.equal(r.code, "PORT_RANGE_EXHAUSTED");
    client.stop();
  });
});

test("rendezvous keys: default coalesces, explicit ports differ, getPort reports", async () => {
  __clearSharedWhisperServersForTest();
  try {
    const a = acquireSharedWhisperServer({ modelPath: "/m.bin", language: "en" });
    const b = acquireSharedWhisperServer({ modelPath: "/m.bin", language: "en" });
    assert.equal(a.client, b.client); // default path coalesces in-process
    const c = acquireSharedWhisperServer({ modelPath: "/m.bin", language: "en", port: 8090 });
    assert.notEqual(a.client, c.client); // explicit 8090 is a different entry
    const d = acquireSharedWhisperServer({ modelPath: "/m.bin", language: "en", port: 8091 });
    assert.notEqual(c.client, d.client); // bound ports differ per entry
    assert.equal(a.client.getPort(), 8090); // pre-start default reports the base
    assert.equal(c.client.getPort(), 8090);
    assert.equal(d.client.getPort(), 8091);
    a.release();
    b.release();
    c.release();
    d.release();
  } finally {
    __clearSharedWhisperServersForTest();
  }
});

test("late exit/error from a replaced child never wipes the new handle", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-ws-test-"));
  const saved = process.env.PATH;
  try {
    fs.writeFileSync(path.join(dir, "whisper-server"), "#!/bin/sh\n");
    process.env.PATH = `${dir}${path.delimiter}${saved}`;
    let up = false;
    const fetch = makeFetch(async (url) => {
      if (!up) return connRefused();
      if (url.endsWith("/health")) return statusOnly(200);
      return connRefused();
    });
    const oldProc = makeProc(501);
    const newProc = makeProc(502);
    const { client } = clientWith({
      fetch,
      procs: [oldProc, newProc],
      onSpawn: () => {
        up = true;
      },
    });
    assert.equal(await client.start(), true);
    assert.equal(client.getOwnerPid(), 501);
    client.stop();
    assert.equal(client.isRunning(), false);
    assert.deepEqual(oldProc.killed, ["SIGTERM"]);
    up = false;
    assert.equal(await client.start(), true);
    assert.equal(client.getOwnerPid(), 502);
    // The old child reports late (after the restart): must be ignored so
    // the new handle stays ready and stoppable.
    oldProc.emit("exit", 1);
    assert.equal(client.isRunning(), true);
    assert.equal(client.getOwnerPid(), 502);
    oldProc.emit("error", new Error("stale EPIPE"));
    assert.equal(client.isRunning(), true);
    assert.equal(client.getOwnerPid(), 502);
    assert.deepEqual(newProc.killed, []);
    client.stop();
    assert.deepEqual(newProc.killed, ["SIGTERM"]);
  } finally {
    process.env.PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
