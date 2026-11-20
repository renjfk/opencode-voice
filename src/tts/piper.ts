// Piper engine: offline fallback TTS, one voice model per language.
// Ported from the Piper parts of lib/tts.js (synthPiperToPcm, getVoiceModel,
// getVoiceRate, resolveVoiceOrWarn) and lib/tts-engines/piper.js.

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SynthError,
  errorMessage,
  type Logger,
  type SpeechLang,
  type SpeechSegment,
  type Synth,
} from "../types.ts";

export const PIPER_VOICES_DIR = path.join(os.homedir(), ".local", "share", "piper-voices");
const DEFAULT_RATE = 22050;
/** Preferred voice per language when several are installed. */
const PREFERRED: Record<SpeechLang, readonly string[]> = {
  vi: ["vi_VN-vais1000-medium", "vi_VN-vivos-x_low"],
  en: ["en_US-ryan-high", "en_US-bryce-medium"],
};

// ---------------------------------------------------------------- deps

interface Stream {
  on(event: "data", cb: (chunk: Buffer) => void): unknown;
}

export interface PiperChild {
  readonly stdin: {
    write(data: string): unknown;
    end(): unknown;
    on(event: "error", cb: (err: Error) => void): unknown;
  } | null;
  readonly stdout: Stream | null;
  readonly stderr: Stream | null;
  on(event: "close" | "error", listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface PiperDeps {
  spawn(cmd: string, args: readonly string[], opts: SpawnOptions): PiperChild;
  exists(file: string): boolean;
  readFile(file: string): string;
  readdir(dir: string): string[];
  voicesDir: string;
}

const defaultDeps: PiperDeps = {
  spawn: (cmd, args, opts) => nodeSpawn(cmd, args, opts),
  exists: (file) => fs.existsSync(file),
  readFile: (file) => fs.readFileSync(file, "utf8"),
  readdir: (dir) => fs.readdirSync(dir),
  voicesDir: PIPER_VOICES_DIR,
};

// ---------------------------------------------------------------- voices

export interface PiperVoice {
  readonly path: string;
  readonly lang: SpeechLang | null;
  readonly name: string;
}

function langOf(name: string): SpeechLang | null {
  const prefix = name.split(/[_-]/)[0]?.toLowerCase();
  return prefix === "vi" || prefix === "en" ? prefix : null;
}

/** Installed *.onnx voices in the Piper voices dir, sorted by name. */
export function findPiperVoices(deps?: Partial<PiperDeps>): PiperVoice[] {
  const d = { ...defaultDeps, ...deps };
  let files: string[];
  try {
    files = d.readdir(d.voicesDir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith(".onnx"))
    .sort()
    .map((f) => {
      const name = f.slice(0, -".onnx".length);
      return { path: path.join(d.voicesDir, f), lang: langOf(name), name };
    });
}

/** Preferred installed voice for lang, else any installed one, else null. */
export function defaultPiperVoice(lang: SpeechLang, deps?: Partial<PiperDeps>): string | null {
  const voices = findPiperVoices(deps).filter((v) => v.lang === lang);
  for (const name of PREFERRED[lang]) {
    const hit = voices.find((v) => v.name === name);
    if (hit) return hit.path;
  }
  return voices[0]?.path ?? null;
}

// ---------------------------------------------------------------- wav

export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function voiceRate(voice: string, d: PiperDeps): number {
  try {
    const cfg: unknown = JSON.parse(d.readFile(`${voice}.json`));
    if (typeof cfg === "object" && cfg !== null && "audio" in cfg) {
      const audio = cfg.audio;
      if (typeof audio === "object" && audio !== null && "sample_rate" in audio) {
        const rate = audio.sample_rate;
        if (typeof rate === "number" && rate > 0) return rate;
      }
    }
  } catch {
    // missing or broken config: Piper's common rate
  }
  return DEFAULT_RATE;
}

// ---------------------------------------------------------------- engine

export interface PiperOptions {
  /** Voice model path for a language, or null when none is configured. */
  readonly voiceFor: (lang: SpeechLang) => string | null;
  readonly logger?: Logger;
  readonly deps?: Partial<PiperDeps>;
}

export function createPiperSynth(opts: PiperOptions): Synth {
  const d: PiperDeps = { ...defaultDeps, ...opts.deps };
  const running = new Set<PiperChild>();
  const log = (message: string, level: "debug" | "warn" | "error" = "debug"): void =>
    opts.logger?.log("TTS", message, level);

  function run(voice: string, text: string, signal?: AbortSignal): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      let child: PiperChild;
      try {
        child = d.spawn("piper", ["-m", voice, "--output-raw"], {
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        reject(new SynthError(`Piper could not start (${errorMessage(err)})`, "UNAVAILABLE"));
        return;
      }
      running.add(child);
      const chunks: Buffer[] = [];
      let stderr = "";
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        running.delete(child);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = (): void => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        finish(() => reject(new SynthError("Piper synthesis stopped", "ABORTED")));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk) => chunks.push(chunk));
      child.stderr?.on("data", (chunk) => {
        stderr = (stderr + String(chunk)).slice(-2000);
      });
      child.on("error", (err) => {
        const code = err instanceof Error && "code" in err ? err.code : undefined;
        const message =
          code === "ENOENT"
            ? "Piper not found on PATH — install piper-tts"
            : `Piper could not start (${errorMessage(err)})`;
        finish(() => reject(new SynthError(message, "UNAVAILABLE")));
      });
      child.on("close", (code, sig) => {
        if (code === null && typeof sig === "string") {
          // Killed (dispose or external): treat as a stop, not a failure.
          finish(() => reject(new SynthError("Piper synthesis stopped", "ABORTED")));
          return;
        }
        if (typeof code === "number" && code !== 0) {
          const tail = stderr.trim().split(/\r?\n/).slice(-2).join(" | ").slice(-240);
          log(`piper exited code=${code}`, "warn");
          finish(() =>
            reject(
              new SynthError(`Piper failed (code=${code})${tail ? `: ${tail}` : ""}`, "FAILED"),
            ),
          );
          return;
        }
        const pcm = Buffer.concat(chunks);
        if (pcm.length === 0) {
          finish(() => reject(new SynthError("Piper produced no audio", "FAILED")));
          return;
        }
        finish(() => resolve(pcmToWav(pcm, voiceRate(voice, d))));
      });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      child.stdin?.on("error", () => {
        // piper died before reading stdin; reported by close/error
      });
      try {
        child.stdin?.write(`${text.replace(/\s+/g, " ").trim()}\n`);
        child.stdin?.end();
      } catch {
        // reported by close/error
      }
    });
  }

  return {
    name: "piper",

    supports(lang: SpeechLang): boolean {
      return opts.voiceFor(lang) !== null;
    },

    async synthesize(seg: SpeechSegment, signal?: AbortSignal): Promise<Buffer> {
      if (signal?.aborted) throw new SynthError("Piper synthesis stopped", "ABORTED");
      const voice = opts.voiceFor(seg.lang);
      if (!voice) {
        throw new SynthError(
          `No Piper voice for ${seg.lang} — add one to ${d.voicesDir}`,
          "UNAVAILABLE",
        );
      }
      if (!d.exists(voice)) {
        throw new SynthError(
          `Piper voice not found: ${voice} — check the voice setting`,
          "UNAVAILABLE",
        );
      }
      log(`piper synth lang=${seg.lang} chars=${seg.text.length}`);
      return run(voice, seg.text, signal);
    },

    warm(): void {},

    async dispose(): Promise<void> {
      for (const child of running) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
      running.clear();
    },
  };
}
