import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { spawnSync, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";

import { SynthError } from "../types.ts";
import {
  VIENEU_VOICES,
  createVieneuSynth,
  fixStreamedWav,
  stderrTail,
  type VieneuFetchInit,
  type VieneuOptions,
} from "./vieneu.ts";

const HEALTH = { status: "ok", backend: "onnx", max_streams: 1, sample_rate: 24000 };
const WAV = Buffer.from("RIFF....WAVEfake");

class FakeChild extends EventEmitter {
  pid = 4242;
  stderr = new EventEmitter();
  signals: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }
  exit(code: number | null, signal: string | null = null): void {
    this.emit("exit", code, signal);
  }
}

type PortState = "vieneu" | "other" | "down";
type SpeechHandler = (body: Record<string, unknown>, init: VieneuFetchInit) => Promise<Response>;

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function harness(over: Partial<VieneuOptions> = {}) {
  let clock = 0;
  const ports = new Map<number, PortState>();
  const probes: number[] = [];
  const spawns: { cmd: string; args: readonly string[]; opts: SpawnOptions; child: FakeChild }[] =
    [];
  const sleeps: number[] = [];
  const scheduled: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const bodies: Record<string, unknown>[] = [];
  const logs: string[] = [];
  let voice = "Mai Anh";
  const state = {
    /** Called on every spawn; default: the sidecar becomes healthy at once. */
    onSpawn: (_child: FakeChild, port: number): void => {
      ports.set(port, "vieneu");
    },
    speech: (async () => new Response(WAV)) as SpeechHandler,
  };

  const synth = createVieneuSynth({
    python: "/venv/bin/python",
    voice: () => voice,
    logger: { log: (_s, m) => logs.push(m) },
    deps: {
      now: () => clock,
      sleep: async (ms, signal) => {
        sleeps.push(ms);
        if (signal?.aborted) throw new SynthError("aborted", "ABORTED");
        clock += ms;
        await tick();
        if (signal?.aborted) throw new SynthError("aborted", "ABORTED");
      },
      schedule: (fn, ms) => {
        const entry = { fn, ms, cancelled: false };
        scheduled.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
      workDir: () => "/tmp/private-vieneu",
      spawn: (cmd, args, opts) => {
        const child = new FakeChild();
        spawns.push({ cmd, args, opts, child });
        state.onSpawn(child, Number(opts.env?.["PORT"]));
        return child;
      },
      fetch: async (url, init) => {
        const u = new URL(url);
        const port = Number(u.port);
        const st = ports.get(port) ?? "down";
        if (u.pathname === "/health") {
          probes.push(port);
          if (st === "down") throw new Error("ECONNREFUSED");
          if (st === "other") return Response.json({ status: "ok", app: "something else" });
          return Response.json(HEALTH);
        }
        if (st !== "vieneu") throw new Error("ECONNREFUSED");
        if (u.pathname === "/v1/voices") {
          return Response.json({ object: "list", data: [{ id: "Mai Anh" }, { id: "Custom" }] });
        }
        const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
        bodies.push(body);
        return state.speech(body, init);
      },
    },
    ...over,
  });

  return {
    synth,
    ports,
    probes,
    spawns,
    sleeps,
    scheduled,
    bodies,
    logs,
    state,
    setVoice: (v: string) => {
      voice = v;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    seg: { lang: "vi" as const, text: "Xin chào" },
  };
}

async function rejection(p: Promise<unknown>): Promise<SynthError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SynthError) return err;
    throw err;
  }
  throw new Error("expected rejection");
}

describe("createVieneuSynth", () => {
  test("spawns the bundled server with a private cwd and HOST/PORT, then synthesizes", async () => {
    const h = harness();
    const wav = await h.synth.synthesize(h.seg);
    expect(wav.equals(WAV)).toBe(true);
    expect(h.spawns.length).toBe(1);
    const sp = h.spawns[0];
    expect(sp?.cmd).toBe("/venv/bin/python");
    expect(sp?.args.length).toBe(1);
    expect(sp?.args[0]).toEndWith("src/tts/vieneu_server.py");
    expect(sp?.opts.cwd).toBe("/tmp/private-vieneu");
    expect(sp?.opts.env?.["HOST"]).toBe("127.0.0.1");
    expect(sp?.opts.env?.["PORT"]).toBe("8000");
    expect(h.bodies[0]).toEqual({
      model: "vieneu-v3-turbo",
      input: "Xin chào",
      voice: "Mai Anh",
      response_format: "wav",
    });
    expect(h.synth.supports("vi")).toBe(true);
    expect(h.synth.supports("en")).toBe(true);
  });

  test("port scan walks a fixed base: 8000, 8001, 8002, 8003 (no skipped ports)", async () => {
    const h = harness();
    h.ports.set(8000, "other");
    h.ports.set(8001, "other");
    h.ports.set(8002, "other");
    await h.synth.synthesize(h.seg);
    expect(h.probes.slice(0, 4)).toEqual([8000, 8001, 8002, 8003]);
    expect(h.spawns[0]?.opts.env?.["PORT"]).toBe("8003");
  });

  test("all ports taken -> UNAVAILABLE naming the range", async () => {
    const h = harness();
    for (const p of [8000, 8001, 8002, 8003]) h.ports.set(p, "other");
    const err = await rejection(h.synth.synthesize(h.seg));
    expect(err.code).toBe("UNAVAILABLE");
    expect(err.message).toBe("VieNeu unavailable (no free port in 8000-8003) — using Piper");
    expect(h.spawns.length).toBe(0);
  });

  test("a sidecar that fails to bind its port moves the scan on", async () => {
    const h = harness();
    h.state.onSpawn = (child, port) => {
      if (port === 8000) {
        setImmediate(() => {
          child.stderr.emit("data", "ERROR: [Errno 48] address already in use\n");
          child.exit(1);
        });
      } else h.ports.set(port, "vieneu");
    };
    await h.synth.synthesize(h.seg);
    expect(h.spawns.map((s) => s.opts.env?.["PORT"])).toEqual(["8000", "8001"]);
  });

  test("adopts a pre-existing sidecar only after verifying it is VieNeu", async () => {
    const h = harness();
    h.ports.set(8000, "other"); // answers /health, but not VieNeu's shape
    h.ports.set(8001, "vieneu");
    await h.synth.synthesize(h.seg);
    expect(h.spawns.length).toBe(0);
    expect(h.probes).toEqual([8000, 8001]);
    expect(h.bodies.length).toBe(1);
    await h.synth.dispose(); // nothing owned, nothing killed
  });

  test("an adopted sidecar that disappears is forgotten; the next call starts one", async () => {
    const h = harness();
    h.ports.set(8000, "vieneu");
    await h.synth.synthesize(h.seg);
    h.ports.set(8000, "down");
    const err = await rejection(h.synth.synthesize(h.seg));
    expect(err.code).toBe("FAILED");
    await h.synth.synthesize(h.seg);
    expect(h.spawns.length).toBe(1);
  });

  test("concurrent callers share one start", async () => {
    let ready: (() => void) | null = null;
    const h = harness();
    h.state.onSpawn = (_c, port) => {
      ready = () => h.ports.set(port, "vieneu");
    };
    h.synth.warm();
    const a = h.synth.synthesize(h.seg);
    const b = h.synth.synthesize({ lang: "en", text: "Hello" });
    for (let i = 0; i < 5; i++) await tick();
    expect(h.spawns.length).toBe(1);
    (ready as (() => void) | null)?.();
    await Promise.all([a, b]);
    expect(h.spawns.length).toBe(1);
    expect(h.bodies.length).toBe(2);
  });

  test("failed start: stderr tail in message, immediate UNAVAILABLE during cooldown, one background retry", async () => {
    const h = harness();
    h.state.onSpawn = (child) => {
      setImmediate(() => {
        child.stderr.emit(
          "data",
          "Traceback (most recent call last):\n  File x\nImportError: libfoo missing\n",
        );
        child.exit(1);
      });
    };
    const first = await rejection(h.synth.synthesize(h.seg));
    expect(first.code).toBe("UNAVAILABLE");
    expect(first.message).toStartWith("VieNeu unavailable (sidecar exited (code=1): ");
    expect(first.message).toContain("ImportError: libfoo missing");
    expect(first.message).toEndWith(") — using Piper");

    // Cooldown: no new start, fails fast.
    const second = await rejection(h.synth.synthesize(h.seg));
    expect(second.code).toBe("UNAVAILABLE");
    expect(second.message).toBe(first.message);
    h.synth.warm();
    expect(h.spawns.length).toBe(1);

    const retry = h.scheduled.find((s) => s.ms === 120_000 && !s.cancelled);
    expect(retry).toBeDefined();

    // Background retry succeeds after the cooldown.
    let ready: (() => void) | null = null;
    h.state.onSpawn = (_c, port) => {
      ready = () => h.ports.set(port, "vieneu");
    };
    h.advance(120_000);
    retry?.fn();
    await tick();
    expect(h.spawns.length).toBe(2);
    // While the background retry runs, speech still falls back immediately.
    expect((await rejection(h.synth.synthesize(h.seg))).code).toBe("UNAVAILABLE");
    (ready as (() => void) | null)?.();
    for (let i = 0; i < 5; i++) await tick();
    const wav = await h.synth.synthesize(h.seg);
    expect(wav.equals(WAV)).toBe(true);
    expect(h.spawns.length).toBe(2);
  });

  test("a failed background retry renews the cooldown without scheduling another", async () => {
    const h = harness();
    h.state.onSpawn = (child) => setImmediate(() => child.exit(1));
    await rejection(h.synth.synthesize(h.seg));
    expect(h.scheduled.filter((s) => s.ms === 120_000).length).toBe(1);
    h.advance(120_000);
    h.scheduled[0]?.fn();
    for (let i = 0; i < 5; i++) await tick();
    expect(h.spawns.length).toBe(2);
    expect(h.scheduled.filter((s) => s.ms === 120_000).length).toBe(1);
    expect((await rejection(h.synth.synthesize(h.seg))).code).toBe("UNAVAILABLE");
    expect(h.spawns.length).toBe(2);
    // After the renewed cooldown a foreground start is attempted again.
    h.advance(120_000);
    await rejection(h.synth.synthesize(h.seg));
    expect(h.spawns.length).toBe(3);
  });

  test("start times out after 180s and the process is killed", async () => {
    const h = harness();
    h.state.onSpawn = (child) => {
      setImmediate(() => child.stderr.emit("data", "loading model...\n"));
    };
    const err = await rejection(h.synth.synthesize(h.seg));
    expect(err.code).toBe("UNAVAILABLE");
    expect(err.message).toBe(
      "VieNeu unavailable (did not start within 180s: loading model...) — using Piper",
    );
    expect(h.spawns[0]?.child.signals).toEqual(["SIGTERM"]);
    // A SIGKILL follow-up is scheduled in case SIGTERM is ignored.
    const killer = h.scheduled.find((s) => s.ms === 3000);
    killer?.fn();
    expect(h.spawns[0]?.child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("spawn throwing -> UNAVAILABLE", async () => {
    const h = harness({
      deps: {
        spawn: () => {
          throw new Error("EACCES");
        },
        fetch: async () => {
          throw new Error("ECONNREFUSED");
        },
        schedule: () => () => {},
      },
    });
    const err = await rejection(h.synth.synthesize(h.seg));
    expect(err.message).toBe(
      "VieNeu unavailable (cannot run /venv/bin/python: EACCES) — using Piper",
    );
  });

  test("async spawn error (python missing) -> UNAVAILABLE", async () => {
    const h = harness();
    h.state.onSpawn = (child) => {
      setImmediate(() => child.emit("error", new Error("spawn /venv/bin/python ENOENT")));
    };
    const err = await rejection(h.synth.synthesize(h.seg));
    expect(err.message).toContain("cannot run /venv/bin/python: spawn /venv/bin/python ENOENT");
  });

  test("voice is read per request; changing it mid-start neither resets nor respawns", async () => {
    let ready: (() => void) | null = null;
    const h = harness();
    h.state.onSpawn = (_c, port) => {
      ready = () => h.ports.set(port, "vieneu");
    };
    const p = h.synth.synthesize(h.seg);
    await tick();
    h.setVoice("Ngọc Huyền");
    (ready as (() => void) | null)?.();
    await p;
    h.setVoice("Adam");
    await h.synth.synthesize(h.seg);
    expect(h.bodies.map((b) => b["voice"])).toEqual(["Ngọc Huyền", "Adam"]);
    expect(h.spawns.length).toBe(1);
    expect(h.spawns[0]?.child.signals).toEqual([]);
  });

  test("abort cancels the HTTP request without touching the sidecar", async () => {
    const h = harness();
    let seen: AbortSignal | undefined;
    h.state.speech = (_b, init) =>
      new Promise((_resolve, reject) => {
        seen = init.signal;
        init.signal?.addEventListener("abort", () => reject(new DOMException("x", "AbortError")));
      });
    const ac = new AbortController();
    const p = h.synth.synthesize(h.seg, ac.signal);
    for (let i = 0; i < 5; i++) await tick();
    ac.abort();
    const err = await rejection(p);
    expect(err.code).toBe("ABORTED");
    expect(seen?.aborted).toBe(true);
    expect(h.spawns[0]?.child.signals).toEqual([]);
    h.state.speech = async () => new Response(WAV);
    await h.synth.synthesize(h.seg);
    expect(h.spawns.length).toBe(1);
  });

  test("abort while waiting for start rejects ABORTED; the start continues", async () => {
    let ready: (() => void) | null = null;
    const h = harness();
    h.state.onSpawn = (_c, port) => {
      ready = () => h.ports.set(port, "vieneu");
    };
    const ac = new AbortController();
    const p = h.synth.synthesize(h.seg, ac.signal);
    await tick();
    ac.abort();
    expect((await rejection(p)).code).toBe("ABORTED");
    (ready as (() => void) | null)?.();
    await h.synth.synthesize(h.seg);
    expect(h.spawns.length).toBe(1);
  });

  test("already-aborted signal rejects without starting anything", async () => {
    const h = harness();
    const ac = new AbortController();
    ac.abort();
    expect((await rejection(h.synth.synthesize(h.seg, ac.signal))).code).toBe("ABORTED");
    expect(h.spawns.length).toBe(0);
  });

  test("429 is retried with backoff and never disposes the sidecar", async () => {
    const h = harness();
    let calls = 0;
    h.state.speech = async () => {
      calls++;
      return calls < 3
        ? Response.json({ error: { message: "server busy: queue full" } }, { status: 429 })
        : new Response(WAV);
    };
    await h.synth.synthesize(h.seg);
    expect(calls).toBe(3);
    expect(h.sleeps.filter((ms) => ms === 500 || ms === 1000)).toEqual([500, 1000]);
    expect(h.spawns[0]?.child.signals).toEqual([]);
  });

  test("busy on every try -> FAILED, sidecar kept for the next call", async () => {
    const h = harness();
    h.state.speech = async () =>
      Response.json({ error: { message: "server busy" } }, { status: 503 });
    const err = await rejection(h.synth.synthesize(h.seg));
    expect(err.code).toBe("FAILED");
    expect(err.message).toBe("VieNeu busy after 3 tries (HTTP 503: server busy)");
    expect(h.bodies.length).toBe(3);
    h.state.speech = async () => new Response(WAV);
    await h.synth.synthesize(h.seg);
    expect(h.spawns.length).toBe(1);
    expect(h.spawns[0]?.child.signals).toEqual([]);
  });

  test("abort during busy backoff -> ABORTED", async () => {
    const h = harness();
    const ac = new AbortController();
    h.state.speech = async () => {
      ac.abort();
      return new Response("busy", { status: 429 });
    };
    expect((await rejection(h.synth.synthesize(h.seg, ac.signal))).code).toBe("ABORTED");
  });

  test("object error bodies render as text", async () => {
    const h = harness();
    h.state.speech = async () =>
      Response.json({ error: { message: "unknown voice 'X'", type: "invalid" } }, { status: 400 });
    const err = await rejection(h.synth.synthesize(h.seg));
    expect(err.message).toBe("VieNeu failed (HTTP 400: unknown voice 'X')");
  });

  test("empty audio -> FAILED", async () => {
    const h = harness();
    h.state.speech = async () => new Response(new Uint8Array(0));
    expect((await rejection(h.synth.synthesize(h.seg))).message).toBe("VieNeu returned no audio");
  });

  test("an owned sidecar exiting after ready starts a cooldown and a background retry", async () => {
    const h = harness();
    await h.synth.synthesize(h.seg);
    h.spawns[0]?.child.stderr.emit("data", "Killed\n");
    h.spawns[0]?.child.exit(null, "SIGKILL");
    const err = await rejection(h.synth.synthesize(h.seg));
    expect(err.message).toBe(
      "VieNeu unavailable (sidecar exited (signal=SIGKILL): Killed) — using Piper",
    );
    expect(h.scheduled.some((s) => s.ms === 120_000)).toBe(true);
  });

  test("dispose kills owned processes (including one still starting) and cancels the retry", async () => {
    const h = harness();
    h.state.onSpawn = () => {};
    const p = h.synth.synthesize(h.seg);
    await tick();
    await h.synth.dispose();
    expect(h.spawns[0]?.child.signals).toEqual(["SIGTERM"]);
    expect((await rejection(p)).code).toBe("UNAVAILABLE");
    expect((await rejection(h.synth.synthesize(h.seg))).code).toBe("UNAVAILABLE");
    expect(h.scheduled.filter((s) => s.ms === 120_000 && !s.cancelled).length).toBe(0);
  });

  test("dispose kills a ready owned sidecar", async () => {
    const h = harness();
    await h.synth.synthesize(h.seg);
    await h.synth.dispose();
    expect(h.spawns[0]?.child.signals).toEqual(["SIGTERM"]);
  });

  test("voices(): static list before start, server list after", async () => {
    const h = harness();
    expect(await h.synth.voices()).toEqual([...VIENEU_VOICES]);
    await h.synth.synthesize(h.seg);
    expect(await h.synth.voices()).toEqual(["Mai Anh", "Custom"]);
  });

  test("never logs speech text", async () => {
    const h = harness();
    await h.synth.synthesize({ lang: "vi", text: "bí mật riêng tư" });
    expect(h.logs.join("\n")).not.toContain("bí mật");
  });

  test("stderrTail keeps the last lines on one line, bounded", () => {
    expect(stderrTail("a\n\nb\nc\nd\n")).toBe("b | c | d");
    expect(stderrTail("")).toBe("");
    expect(stderrTail("x".repeat(500), 10)).toBe(`…${"x".repeat(10)}`);
  });
});

describe("fixStreamedWav", () => {
  test("replaces 0xFFFFFFFF placeholder sizes with real ones", () => {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(0xffffffff, 4);
    header.write("WAVEfmt ", 8, "ascii");
    header.writeUInt32LE(16, 16);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(0xffffffff, 40);
    const wav = fixStreamedWav(Buffer.concat([header, Buffer.alloc(100)]));
    expect(wav.readUInt32LE(4)).toBe(136);
    expect(wav.readUInt32LE(40)).toBe(100);
  });

  test("leaves non-WAV data alone", () => {
    expect(fixStreamedWav(Buffer.from("not a wav")).toString()).toBe("not a wav");
  });

  test("synthesize returns the fixed WAV", async () => {
    const h = harness();
    const streamed = Buffer.alloc(54);
    streamed.write("RIFF", 0, "ascii");
    streamed.writeUInt32LE(0xffffffff, 4);
    streamed.write("WAVEfmt ", 8, "ascii");
    streamed.writeUInt32LE(16, 16);
    streamed.write("data", 36, "ascii");
    streamed.writeUInt32LE(0xffffffff, 40);
    h.state.speech = async () => new Response(streamed);
    const wav = await h.synth.synthesize(h.seg);
    expect(wav.readUInt32LE(40)).toBe(10);
  });
});

// The sidecar bootstrap is Python; exercise its pure helpers when python3 exists.
const python3 = Bun.which("python3");
describe.skipIf(!python3)("vieneu_server.py", () => {
  const script = fileURLToPath(new URL("./vieneu_server.py", import.meta.url));
  const run = (program: string) =>
    spawnSync(python3 ?? "python3", ["-I", "-B", "-c", program, script], { encoding: "utf8" });
  const load = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("bootstrap", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
`;

  test("materializes symlinked model files without touching the source", () => {
    const r = run(`${load}
import pathlib, tempfile
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    (root / "blob").write_bytes(b"weights")
    (root / "source").mkdir()
    (root / "source" / "w.data").symlink_to(root / "blob")
    out = m.materialize(root / "source", ["w.data", "missing.json"], root / "out")
    assert (out / "w.data").read_bytes() == b"weights"
    assert not (out / "w.data").is_symlink()
    assert (root / "source" / "w.data").is_symlink()
    try:
        m.materialize(root / "source", ["../x"], root / "out")
        raise SystemExit("accepted a path")
    except ValueError:
        pass
`);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  test("closing a disconnected body always releases the stream slot once", () => {
    const r = run(`${load}
class Engine:
    def __init__(self): self.released = 0
    def release(self): self.released += 1

def chunks(engine):
    try:
        yield 1
        yield 2
    finally:
        engine.release()

def body(c):
    yield b"header"
    for x in c:
        yield bytes([x])

# Disconnect after the header: inner generator never started.
e = Engine(); c = m.SlotChunks(e, chunks(e)); b = m.ClosingBody(body(c), c)
next(b); b.close(); b.close()
assert e.released == 1, e.released
assert list(b) == []

# Disconnect mid-stream: inner generator suspended.
e = Engine(); c = m.SlotChunks(e, chunks(e)); b = m.ClosingBody(body(c), c)
next(b); next(b); b.close()
assert e.released == 1, e.released

# Normal completion, then close: no double release.
e = Engine(); c = m.SlotChunks(e, chunks(e)); b = m.ClosingBody(body(c), c)
assert list(b) == [b"header", b"\\x01", b"\\x02"]
b.close()
assert e.released == 1, e.released
`);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  test("environment HOST/PORT are honored, defaulting to loopback:8000", () => {
    const r = run(`${load}
import os
os.environ.pop("HOST", None); os.environ.pop("PORT", None)
assert m.server_address() == ("127.0.0.1", 8000)
os.environ["HOST"] = "127.0.0.1"; os.environ["PORT"] = "8003"
assert m.server_address() == ("127.0.0.1", 8003)
`);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});
