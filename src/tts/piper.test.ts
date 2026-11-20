import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { SynthError } from "../types.ts";
import {
  createPiperSynth,
  defaultPiperVoice,
  findPiperVoices,
  pcmToWav,
  type PiperDeps,
} from "./piper.ts";

class FakeStdin extends EventEmitter {
  written = "";
  ended = false;
  write(data: string): boolean {
    this.written += data;
    return true;
  }
  end(): void {
    this.ended = true;
  }
}

class FakePiper extends EventEmitter {
  stdin = new FakeStdin();
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  signals: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }
}

const VI = "/voices/vi_VN-vais1000-medium.onnx";
const EN = "/voices/en_US-ryan-high.onnx";

function setup(behave: (child: FakePiper) => void, extra: Partial<PiperDeps> = {}) {
  const spawned: { cmd: string; args: readonly string[]; child: FakePiper }[] = [];
  const synth = createPiperSynth({
    voiceFor: (lang) => (lang === "vi" ? VI : lang === "en" ? EN : null),
    deps: {
      spawn: (cmd, args) => {
        const child = new FakePiper();
        spawned.push({ cmd, args, child });
        setImmediate(() => behave(child));
        return child;
      },
      exists: (f) => f === VI || f === EN,
      readFile: (f) => {
        if (f === `${VI}.json`) return JSON.stringify({ audio: { sample_rate: 16000 } });
        throw new Error("ENOENT");
      },
      ...extra,
    },
  });
  return { synth, spawned };
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

const ok = (child: FakePiper): void => {
  child.stdout.emit("data", Buffer.alloc(320, 1));
  child.emit("close", 0, null);
};

describe("createPiperSynth", () => {
  test("spawns piper with the language voice and returns a WAV at the voice rate", async () => {
    const { synth, spawned } = setup(ok);
    const wav = await synth.synthesize({ lang: "vi", text: "Xin chào\ncác bạn" });
    expect(spawned[0]?.cmd).toBe("piper");
    expect(spawned[0]?.args).toEqual(["-m", VI, "--output-raw"]);
    expect(spawned[0]?.child.stdin.written).toBe("Xin chào các bạn\n");
    expect(spawned[0]?.child.stdin.ended).toBe(true);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.length).toBe(44 + 320);
  });

  test("falls back to 22050 Hz when the voice config is missing", async () => {
    const { synth } = setup(ok);
    const wav = await synth.synthesize({ lang: "en", text: "Hello" });
    expect(wav.readUInt32LE(24)).toBe(22050);
  });

  test("abort kills piper and rejects ABORTED", async () => {
    const { synth, spawned } = setup(() => {});
    const ac = new AbortController();
    const p = synth.synthesize({ lang: "en", text: "Hello" }, ac.signal);
    await new Promise((r) => setImmediate(r));
    ac.abort();
    const err = await rejection(p);
    expect(err.code).toBe("ABORTED");
    expect(spawned[0]?.child.signals).toEqual(["SIGKILL"]);
  });

  test("already-aborted signal does not spawn", async () => {
    const { synth, spawned } = setup(ok);
    const ac = new AbortController();
    ac.abort();
    expect((await rejection(synth.synthesize({ lang: "en", text: "x" }, ac.signal))).code).toBe(
      "ABORTED",
    );
    expect(spawned.length).toBe(0);
  });

  test("no voice configured for the language -> UNAVAILABLE", async () => {
    const synth = createPiperSynth({ voiceFor: () => null, deps: { voicesDir: "/voices" } });
    const err = await rejection(synth.synthesize({ lang: "vi", text: "x" }));
    expect(err.code).toBe("UNAVAILABLE");
    expect(err.message).toBe("No Piper voice for vi — add one to /voices");
    expect(synth.supports("vi")).toBe(false);
  });

  test("voice file missing -> UNAVAILABLE naming the path", async () => {
    const { synth, spawned } = setup(ok, { exists: () => false });
    const err = await rejection(synth.synthesize({ lang: "en", text: "x" }));
    expect(err.code).toBe("UNAVAILABLE");
    expect(err.message).toContain(EN);
    expect(spawned.length).toBe(0);
  });

  test("piper missing on PATH -> UNAVAILABLE", async () => {
    const { synth } = setup((child) => {
      const err = Object.assign(new Error("spawn piper ENOENT"), { code: "ENOENT" });
      child.emit("error", err);
    });
    const err = await rejection(synth.synthesize({ lang: "en", text: "x" }));
    expect(err.code).toBe("UNAVAILABLE");
    expect(err.message).toBe("Piper not found on PATH — install piper-tts");
  });

  test("spawn throwing -> UNAVAILABLE", async () => {
    const synth = createPiperSynth({
      voiceFor: () => EN,
      deps: {
        exists: () => true,
        spawn: () => {
          throw new Error("EMFILE");
        },
      },
    });
    expect((await rejection(synth.synthesize({ lang: "en", text: "x" }))).message).toBe(
      "Piper could not start (EMFILE)",
    );
  });

  test("non-zero exit -> FAILED with stderr tail", async () => {
    const { synth } = setup((child) => {
      child.stderr.emit("data", "Traceback\nRuntimeError: bad model\n");
      child.emit("close", 1, null);
    });
    const err = await rejection(synth.synthesize({ lang: "en", text: "x" }));
    expect(err.code).toBe("FAILED");
    expect(err.message).toBe("Piper failed (code=1): Traceback | RuntimeError: bad model");
  });

  test("no audio -> FAILED", async () => {
    const { synth } = setup((child) => child.emit("close", 0, null));
    expect((await rejection(synth.synthesize({ lang: "en", text: "x" }))).message).toBe(
      "Piper produced no audio",
    );
  });

  test("dispose kills running piper; the pending call resolves ABORTED", async () => {
    const { synth, spawned } = setup(() => {});
    const p = synth.synthesize({ lang: "en", text: "x" });
    await new Promise((r) => setImmediate(r));
    await synth.dispose();
    const child = spawned[0]?.child;
    expect(child?.signals).toEqual(["SIGKILL"]);
    child?.emit("close", null, "SIGKILL");
    expect((await rejection(p)).code).toBe("ABORTED");
  });

  test("never logs speech text", async () => {
    const logs: string[] = [];
    const synth = createPiperSynth({
      voiceFor: () => EN,
      logger: { log: (_s, m) => logs.push(m) },
      deps: {
        exists: () => true,
        readFile: () => "{}",
        spawn: () => {
          const child = new FakePiper();
          setImmediate(() => ok(child));
          return child;
        },
      },
    });
    await synth.synthesize({ lang: "en", text: "secret words" });
    expect(logs.join("\n")).not.toContain("secret");
  });
});

describe("voices", () => {
  const files = [
    "en_US-ryan-high.onnx",
    "en_US-ryan-high.onnx.json",
    "vi_VN-vivos-x_low.onnx",
    "vi_VN-vais1000-medium.onnx",
    "de_DE-thorsten-low.onnx",
  ];
  const deps = { voicesDir: "/v", readdir: () => files };

  test("findPiperVoices lists onnx models with language", () => {
    expect(findPiperVoices(deps)).toEqual([
      { path: "/v/de_DE-thorsten-low.onnx", lang: null, name: "de_DE-thorsten-low" },
      { path: "/v/en_US-ryan-high.onnx", lang: "en", name: "en_US-ryan-high" },
      { path: "/v/vi_VN-vais1000-medium.onnx", lang: "vi", name: "vi_VN-vais1000-medium" },
      { path: "/v/vi_VN-vivos-x_low.onnx", lang: "vi", name: "vi_VN-vivos-x_low" },
    ]);
  });

  test("missing voices dir -> empty list, no default", () => {
    const missing = {
      voicesDir: "/nope",
      readdir: (): string[] => {
        throw new Error("ENOENT");
      },
    };
    expect(findPiperVoices(missing)).toEqual([]);
    expect(defaultPiperVoice("vi", missing)).toBeNull();
  });

  test("defaultPiperVoice prefers known voices, else any for the language", () => {
    expect(defaultPiperVoice("vi", deps)).toBe("/v/vi_VN-vais1000-medium.onnx");
    expect(defaultPiperVoice("en", deps)).toBe("/v/en_US-ryan-high.onnx");
    expect(
      defaultPiperVoice("en", { voicesDir: "/v", readdir: () => ["en_GB-alan-low.onnx"] }),
    ).toBe("/v/en_GB-alan-low.onnx");
  });
});

test("pcmToWav writes a 44-byte PCM header", () => {
  const wav = pcmToWav(Buffer.alloc(10), 24000);
  expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
  expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
  expect(wav.readUInt32LE(40)).toBe(10);
  expect(wav.readUInt32LE(28)).toBe(48000);
});
