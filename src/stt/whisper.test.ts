import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { isAbortError } from "../types.ts";
import { pcmToWav } from "./long.ts";
import {
  type ChildLike,
  type WhisperDeps,
  buildServerArgs,
  createWhisperTranscriber,
  defaultWhisperModel,
  findWhisperModels,
  resetWhisperServersForTests,
  whisperTimeoutMs,
} from "./whisper.ts";
import { shortModelName } from "./whisper.ts";

class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed: string[] = [];
  constructor(
    readonly cmd: string,
    readonly args: readonly string[],
  ) {
    super();
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
  /** Simulate the process dying. */
  die(code: number | null = 1, stderr = ""): void {
    if (stderr) this.stderr.emit("data", Buffer.from(stderr));
    this.emit("exit", code);
  }
}

const wav = pcmToWav(Buffer.alloc(16000 * 2), 16000); // 1s silence
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Harness {
  deps: Partial<WhisperDeps>;
  children: FakeChild[];
  busy: Set<number>;
  requests: Array<{ url: string; init: RequestInit | undefined }>;
  inference: (url: string, init: RequestInit | undefined) => Promise<Response>;
  health: (port: number) => Promise<Response>;
  timers: Array<() => void>;
  clock: { t: number };
  paths: Set<string>;
  written: string[];
  removed: string[];
}

function portOf(url: string): number {
  return Number(new URL(url).port);
}

function harness(): Harness {
  const h: Harness = {
    deps: {},
    children: [],
    busy: new Set(),
    requests: [],
    inference: async () => Response.json({ text: " hello [BLANK_AUDIO] world " }),
    health: async (port) => {
      const live = h.children.some(
        (c) =>
          c.cmd === "whisper-server" &&
          c.args.includes(String(port)) &&
          c.listenerCount("exit") > 0,
      );
      if (!live) throw new Error("ECONNREFUSED");
      return new Response("ok", { status: 200 });
    },
    timers: [],
    clock: { t: 0 },
    paths: new Set(["whisper-server"]),
    written: [],
    removed: [],
  };
  h.deps = {
    spawn: (cmd, args) => {
      const c = new FakeChild(cmd, args);
      h.children.push(c);
      return c;
    },
    fetch: async (url, init) => {
      h.requests.push({ url, init });
      if (url.endsWith("/health")) return h.health(portOf(url));
      return h.inference(url, init);
    },
    isPortFree: async (port) => !h.busy.has(port),
    onPath: (cmd) => h.paths.has(cmd),
    existsSync: () => true,
    writeFile: async (p) => {
      h.written.push(p);
    },
    rm: async (p) => {
      h.removed.push(p);
    },
    tmpdir: () => "/tmp",
    now: () => h.clock.t,
    sleep: async (ms) => {
      h.clock.t += ms;
      await tick();
    },
    setTimeout: (cb) => {
      h.timers.push(cb);
      return h.timers.length;
    },
    clearTimeout: () => {},
  };
  return h;
}

const servers = (h: Harness): FakeChild[] => h.children.filter((c) => c.cmd === "whisper-server");
const portArg = (c: FakeChild): string | undefined => c.args[c.args.indexOf("--port") + 1];

afterEach(() => resetWhisperServersForTests());

describe("whisper-server sidecar", () => {
  test("concurrent warm/transcribe share one start", async () => {
    const h = harness();
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-a.bin", deps: h.deps });
    const results = await Promise.all([
      t.warm(),
      t.transcribe(wav, { language: "en" }),
      t.transcribe(wav, { language: "vi" }),
    ]);
    expect(servers(h)).toHaveLength(1);
    expect(results[1]).toBe("hello world");
    expect(results[2]).toBe("hello world");
  });

  test("server args", () => {
    expect(buildServerArgs("/m/x.bin", 8178, 4)).toEqual([
      "-m",
      "/m/x.bin",
      "--host",
      "127.0.0.1",
      "--port",
      "8178",
      "-t",
      "4",
    ]);
  });

  test("port scan starts from a fixed base every time", async () => {
    const h = harness();
    h.busy.add(8178);
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-b.bin", deps: h.deps });
    await t.transcribe(wav, { language: "en" });
    const first = servers(h)[0];
    expect(first && portArg(first)).toBe("8179");
    const inf = h.requests.find((r) => r.url.endsWith("/inference"));
    expect(inf?.url).toBe("http://127.0.0.1:8179/inference");

    // Crash; base is free again -> restart goes back to 8178, not 8180.
    h.busy.clear();
    first?.die(1);
    await t.transcribe(wav, { language: "en" });
    const second = servers(h)[1];
    expect(second && portArg(second)).toBe("8178");
  });

  test("restarts after a crash between calls", async () => {
    const h = harness();
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-c.bin", deps: h.deps });
    await t.transcribe(wav, { language: "en" });
    servers(h)[0]?.die(139);
    expect(await t.transcribe(wav, { language: "en" })).toBe("hello world");
    expect(servers(h)).toHaveLength(2);
  });

  test("server dying mid-request restarts once and retries", async () => {
    const h = harness();
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-d.bin", deps: h.deps });
    await t.warm();
    let calls = 0;
    h.inference = async () => {
      calls += 1;
      if (calls === 1) {
        servers(h)[0]?.die(139);
        throw new Error("socket closed");
      }
      return Response.json({ text: "ok" });
    };
    expect(await t.transcribe(wav, { language: "en" })).toBe("ok");
    expect(servers(h)).toHaveLength(2);
  });

  test("network error with live server is not retried", async () => {
    const h = harness();
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-d2.bin", deps: h.deps });
    h.inference = async () => {
      throw new Error("socket closed");
    };
    await expect(t.transcribe(wav, { language: "en" })).rejects.toThrow(
      "Whisper request failed: socket closed",
    );
    expect(servers(h)).toHaveLength(1);
  });

  test("request shape: multipart fields", async () => {
    const h = harness();
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-e.bin", deps: h.deps });
    await t.transcribe(wav, { language: "vi", prompt: "OpenCode, TypeScript" });
    const inf = h.requests.find((r) => r.url.endsWith("/inference"));
    expect(inf?.init?.method).toBe("POST");
    const body = inf?.init?.body;
    expect(body).toBeInstanceOf(FormData);
    if (!(body instanceof FormData)) return;
    expect(body.get("response_format")).toBe("json");
    expect(body.get("temperature")).toBe("0");
    expect(body.get("language")).toBe("vi");
    expect(body.get("prompt")).toBe("OpenCode, TypeScript");
    expect(body.get("file")).toBeInstanceOf(Blob);
  });

  test("auto language is sent as auto and prompt omitted", async () => {
    const h = harness();
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-e2.bin", deps: h.deps });
    await t.transcribe(wav, { language: "auto" });
    const body = h.requests.find((r) => r.url.endsWith("/inference"))?.init?.body;
    if (!(body instanceof FormData)) throw new Error("expected form");
    expect(body.get("language")).toBe("auto");
    expect(body.get("prompt")).toBeNull();
  });

  test("abort cancels the in-flight request", async () => {
    const h = harness();
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-f.bin", deps: h.deps });
    await t.warm();
    let seen: AbortSignal | undefined;
    h.inference = (_url, init) =>
      new Promise((_resolve, reject) => {
        seen = init?.signal ?? undefined;
        seen?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const ctl = new AbortController();
    const p = t.transcribe(wav, { language: "en", signal: ctl.signal });
    await tick();
    ctl.abort();
    const err = await p.catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
    expect(seen?.aborted).toBe(true);
  });

  test("already-aborted signal rejects without spawning", async () => {
    const h = harness();
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-f2.bin", deps: h.deps });
    const ctl = new AbortController();
    ctl.abort();
    const err = await t.transcribe(wav, { language: "en", signal: ctl.signal }).catch((e) => e);
    expect(isAbortError(err)).toBe(true);
    expect(h.children).toHaveLength(0);
  });

  test("request timeout scales with audio and reports a hint", async () => {
    const h = harness();
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-g.bin", deps: h.deps });
    await t.warm();
    h.inference = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const p = t.transcribe(wav, { language: "en" });
    await tick();
    h.timers.at(-1)?.();
    await expect(p).rejects.toThrow("Whisper timed out after 22s");
    expect(whisperTimeoutMs(wav)).toBe(22_000);
  });

  test("non-200 inference response surfaces status", async () => {
    const h = harness();
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-g2.bin", deps: h.deps });
    h.inference = async () => new Response("boom", { status: 500 });
    await expect(t.transcribe(wav, { language: "en" })).rejects.toThrow(
      "whisper-server responded 500",
    );
  });

  test("missing model gives an actionable error", async () => {
    const h = harness();
    const t = createWhisperTranscriber({
      modelPath: "/m/ggml-missing.bin",
      deps: { ...h.deps, existsSync: () => false },
    });
    await expect(t.transcribe(wav, { language: "en" })).rejects.toThrow(
      "Whisper model not found: /m/ggml-missing.bin — pick one with /stt-model",
    );
  });

  test("no whisper binary installed", async () => {
    const h = harness();
    h.paths.clear();
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-h.bin", deps: h.deps });
    await expect(t.warm()).rejects.toThrow("whisper.cpp is not installed");
  });

  test("early exit with a real error fails without scanning on", async () => {
    const h = harness();
    h.health = async () => {
      throw new Error("ECONNREFUSED");
    };
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-i.bin", deps: h.deps });
    const p = t.warm();
    await tick();
    servers(h)[0]?.die(1, "whisper_init: failed to load model\n");
    await expect(p).rejects.toThrow(
      "whisper-server failed to start: whisper_init: failed to load model",
    );
    expect(servers(h)).toHaveLength(1);
  });

  test("lost bind race advances to the next port", async () => {
    const h = harness();
    let first = true;
    h.deps.spawn = (cmd, args) => {
      const c = new FakeChild(cmd, args);
      h.children.push(c);
      if (first) {
        first = false;
        queueMicrotask(() => c.die(1, "error: bind failed: address already in use\n"));
      }
      return c;
    };
    h.health = async (port) => {
      if (port === 8178) throw new Error("ECONNREFUSED");
      return new Response("ok");
    };
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-j.bin", deps: h.deps });
    await t.warm();
    expect(servers(h).map(portArg)).toEqual(["8178", "8179"]);
  });

  test("start timeout kills the process", async () => {
    const h = harness();
    h.health = async () => new Response("loading", { status: 503 });
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-k.bin", deps: h.deps });
    await expect(t.warm()).rejects.toThrow("did not start within 60s");
    expect(servers(h)[0]?.killed).toEqual(["SIGTERM"]);
  });

  test("all ports busy", async () => {
    const h = harness();
    for (let p = 8178; p < 8188; p++) h.busy.add(p);
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-l.bin", deps: h.deps });
    await expect(t.warm()).rejects.toThrow("No free port for whisper-server in 8178-8187");
  });

  test("refcounted registry shares one server per model", async () => {
    const h = harness();
    const a = createWhisperTranscriber({ modelPath: "/m/ggml-m.bin", deps: h.deps });
    const b = createWhisperTranscriber({ modelPath: "/m/ggml-m.bin", deps: h.deps });
    await a.warm();
    await b.transcribe(wav, { language: "en" });
    expect(servers(h)).toHaveLength(1);
    await a.dispose();
    await a.dispose(); // idempotent
    expect(servers(h)[0]?.killed).toEqual([]);
    await b.dispose();
    expect(servers(h)[0]?.killed).toEqual(["SIGTERM"]);
    await expect(a.transcribe(wav, { language: "en" })).rejects.toThrow("disposed");

    const c = createWhisperTranscriber({ modelPath: "/m/ggml-m.bin", deps: h.deps });
    await c.warm();
    expect(servers(h)).toHaveLength(2);
  });

  test("dispose during startup leaves no orphan", async () => {
    const h = harness();
    h.health = async () => new Response("loading", { status: 503 });
    h.deps.sleep = () => tick();
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-n.bin", deps: h.deps });
    const p = t.warm();
    await tick();
    await t.dispose();
    await expect(p).rejects.toThrow("disposed");
    expect(servers(h)[0]?.killed.length).toBeGreaterThan(0);
  });

  test("describe", () => {
    const h = harness();
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-large-v3-turbo.bin", deps: h.deps });
    expect(t.describe()).toBe("whisper large-v3-turbo");
  });
});

describe("whisper-cli fallback", () => {
  function cliHarness(): Harness {
    const h = harness();
    h.paths = new Set(["whisper-cli"]);
    return h;
  }

  test("parses stdout and cleans up the temp file", async () => {
    const h = cliHarness();
    h.deps.spawn = (cmd, args) => {
      const c = new FakeChild(cmd, args);
      h.children.push(c);
      queueMicrotask(() => {
        c.stdout.emit("data", Buffer.from(" [BLANK_AUDIO]\n xin chào"));
        c.stdout.emit("data", Buffer.from(" thế giới (music)\n"));
        c.die(0);
      });
      return c;
    };
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-o.bin", threads: 4, deps: h.deps });
    const out = await t.transcribe(wav, { language: "vi", prompt: "hint" });
    expect(out).toBe("xin chào thế giới");
    const c = h.children[0];
    expect(c?.cmd).toBe("whisper-cli");
    const file = h.written[0];
    expect(c?.args).toEqual([
      "-m",
      "/m/ggml-o.bin",
      "-f",
      file ?? "",
      "-l",
      "vi",
      "-np",
      "-nt",
      "-t",
      "4",
      "--prompt",
      "hint",
    ]);
    expect(h.removed).toEqual([file ?? ""]);
  });

  test("nonzero exit surfaces last stderr line", async () => {
    const h = cliHarness();
    h.deps.spawn = (cmd, args) => {
      const c = new FakeChild(cmd, args);
      queueMicrotask(() =>
        c.die(11, "failed to read the frames of the audio data\nerror: 1 input file(s) failed\n"),
      );
      return c;
    };
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-p.bin", deps: h.deps });
    await expect(t.transcribe(wav, { language: "en" })).rejects.toThrow(
      "whisper-cli failed: error: 1 input file(s) failed",
    );
    expect(h.removed).toHaveLength(1);
  });

  test("unknown language on exit 0", async () => {
    const h = cliHarness();
    h.deps.spawn = (cmd, args) => {
      const c = new FakeChild(cmd, args);
      queueMicrotask(() => c.die(0, "error: unknown language 'xx'\n"));
      return c;
    };
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-q.bin", deps: h.deps });
    await expect(t.transcribe(wav, { language: "en" })).rejects.toThrow(
      "Unknown whisper language: xx",
    );
  });

  test("abort kills whisper-cli", async () => {
    const h = cliHarness();
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-r.bin", deps: h.deps });
    const ctl = new AbortController();
    const p = t.transcribe(wav, { language: "en", signal: ctl.signal });
    await tick();
    ctl.abort();
    const err = await p.catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
    expect(h.children[0]?.killed).toEqual(["SIGKILL"]);
    expect(h.removed).toHaveLength(1);
  });

  test("timeout kills whisper-cli", async () => {
    const h = cliHarness();
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-s.bin", deps: h.deps });
    const p = t.transcribe(wav, { language: "en" });
    await tick();
    h.timers.at(-1)?.();
    await expect(p).rejects.toThrow("Whisper timed out");
    expect(h.children[0]?.killed).toEqual(["SIGKILL"]);
  });

  test("spawn error event", async () => {
    const h = cliHarness();
    h.deps.spawn = (cmd, args) => {
      const c = new FakeChild(cmd, args);
      queueMicrotask(() => c.emit("error", new Error("ENOENT")));
      return c;
    };
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-t.bin", deps: h.deps });
    await expect(t.transcribe(wav, { language: "en" })).rejects.toThrow(
      "whisper-cli failed: ENOENT",
    );
  });

  test("warm is a no-op in cli mode", async () => {
    const h = cliHarness();
    const t = createWhisperTranscriber({ modelPath: "/m/ggml-u.bin", deps: h.deps });
    await t.warm();
    expect(h.children).toHaveLength(0);
  });
});

describe("model discovery", () => {
  const files: Record<string, Record<string, number>> = {
    "/home/u/.local/share/whisper-cpp": {
      "ggml-base.en.bin": 142,
      "ggml-large-v3-turbo-q5_0.bin": 548,
      "ggml-silero-v5.1.2.bin": 1,
      "notes.txt": 1,
    },
    "/opt/homebrew/share/whisper-cpp/models": {
      "ggml-medium.bin": 1500,
      "for-tests-ggml-tiny.bin": 1,
    },
  };
  const deps = {
    homedir: () => "/home/u",
    existsSync: (p: string) => p in files,
    readdirSync: (d: string) => Object.keys(files[d] ?? {}),
    statSync: (p: string) => {
      const dir = p.slice(0, p.lastIndexOf("/"));
      const name = p.slice(p.lastIndexOf("/") + 1);
      return { size: files[dir]?.[name] ?? 0, isFile: () => true };
    },
  };

  test("finds ggml models, largest first, skipping VAD/test files", () => {
    expect(findWhisperModels(deps)).toEqual([
      "/opt/homebrew/share/whisper-cpp/models/ggml-medium.bin",
      "/home/u/.local/share/whisper-cpp/ggml-large-v3-turbo-q5_0.bin",
      "/home/u/.local/share/whisper-cpp/ggml-base.en.bin",
    ]);
  });

  test("default prefers large-v3-turbo", () => {
    expect(defaultWhisperModel(deps)).toBe(
      "/home/u/.local/share/whisper-cpp/ggml-large-v3-turbo-q5_0.bin",
    );
  });

  test("default falls back to the largest, then null", () => {
    const noTurbo = {
      ...deps,
      existsSync: (p: string) => p === "/opt/homebrew/share/whisper-cpp/models",
    };
    expect(defaultWhisperModel(noTurbo)).toBe(
      "/opt/homebrew/share/whisper-cpp/models/ggml-medium.bin",
    );
    expect(defaultWhisperModel({ ...deps, existsSync: () => false })).toBeNull();
  });
});

test("shortModelName gives a compact status label", () => {
  expect(shortModelName("/x/ggml-large-v3-turbo-q5_0.bin")).toBe("turbo");
  expect(shortModelName("/x/ggml-medium.bin")).toBe("medium");
  expect(shortModelName("/x/ggml-small.en-q5_1.bin")).toBe("small en");
  expect(shortModelName("ggml-large-v3.bin")).toBe("large-v3");
});
