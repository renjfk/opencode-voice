// VieNeu-TTS engine: a managed Python sidecar serving an OpenAI-compatible
// POST /v1/audio/speech (see https://github.com/pnnbao97/VieNeu-TTS).
// VieNeu speaks Vietnamese with English code-switching in one pass.
//
// Ported from lib/sidecars/vieneu-server.js + lib/tts-engines/vieneu.js with
// these fixes: fixed-base port scan, start timeout + failure cooldown with one
// background retry, voice read per request (no client reset), AbortSignal on
// every request, 429/503 retried with backoff instead of disposing, private
// working directory for the sidecar, adopted sidecars verified as VieNeu.

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SynthError,
  errorMessage,
  type Logger,
  type SpeechLang,
  type SpeechSegment,
  type Synth,
} from "../types.ts";

export const DEFAULT_VIENEU_VOICE = "Mai Anh";

/** Preset voices shipped with VieNeu 3.x (used when the server is not up). */
export const VIENEU_VOICES: readonly string[] = [
  "Adam bựa",
  "Trúc Ly",
  "Thiện Minh",
  "Mai Anh",
  "Hải Đăng",
  "Thùy Dung",
  "Thiền Tâm Đức",
  "Ngọc Huyền",
  "Quang Sơn",
  "Ngọc Trân",
  "Minh Đức",
  "Phạm Tuyên",
  "Thái Sơn",
  "Xuân Vĩnh",
  "Thanh Bình",
  "Ngọc Linh",
  "Đoan Trang",
  "Thục Đoan",
  "Minh Triết",
  "Mỹ Duyên",
  "Quỳnh Anh",
  "Đức Trí",
  "Kim Thanh",
  "Adam",
  "Quốc Tuấn",
];

const SERVER_SCRIPT = fileURLToPath(new URL("./vieneu_server.py", import.meta.url));
const MODEL_ID = "vieneu-v3-turbo";
const BUSY_TRIES = 3;
const KILL_GRACE_MS = 3000;
const STDERR_KEEP = 4000;

// ---------------------------------------------------------------- deps

export interface VieneuChild {
  readonly pid?: number | undefined;
  readonly stderr: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "exit" | "error", listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface VieneuFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface VieneuResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface VieneuDeps {
  spawn(cmd: string, args: readonly string[], opts: SpawnOptions): VieneuChild;
  fetch(url: string, init: VieneuFetchInit): Promise<VieneuResponse>;
  now(): number;
  /** Resolves after ms; rejects when signal aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Run fn after ms (must not keep the process alive). Returns cancel. */
  schedule(fn: () => void, ms: number): () => void;
  /** Private, empty working directory for the sidecar process. */
  workDir(): string;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SynthError("aborted", "ABORTED"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new SynthError("aborted", "ABORTED"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const defaultDeps: VieneuDeps = {
  spawn: (cmd, args, opts) => nodeSpawn(cmd, args, opts),
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  sleep: defaultSleep,
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
  workDir: () => {
    const dir = path.join(os.tmpdir(), "opencode-voice-vieneu");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  },
};

// ---------------------------------------------------------------- options

export interface VieneuOptions {
  /** Python interpreter of the VieNeu venv. */
  readonly python: string;
  /** Read at every request, so a voice change applies to the next segment. */
  readonly voice: () => string;
  readonly logger?: Logger;
  readonly host?: string;
  readonly basePort?: number;
  readonly portScanMax?: number;
  readonly startTimeoutMs?: number;
  readonly cooldownMs?: number;
  readonly pollMs?: number;
  readonly synthTimeoutMs?: number;
  readonly busyBackoffMs?: number;
  readonly deps?: Partial<VieneuDeps>;
}

export type VieneuSynth = Synth & { voices(): Promise<string[]> };

interface Server {
  readonly port: number;
  /** null when adopted: a VieNeu sidecar we did not spawn. Never killed. */
  readonly proc: VieneuChild | null;
}

class StartFailure extends Error {
  constructor(
    message: string,
    readonly portInUse = false,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- helpers

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** /health of apps.openai_speech: { status: "ok", max_streams, sample_rate, ... }. */
function isVieneuHealth(body: unknown): boolean {
  return (
    isRecord(body) &&
    body["status"] === "ok" &&
    typeof body["max_streams"] === "number" &&
    typeof body["sample_rate"] === "number"
  );
}

/** Last few non-empty stderr lines, one line, bounded. */
export function stderrTail(stderr: string, maxChars = 240): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3);
  const tail = lines.join(" | ");
  return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail;
}

function withTail(message: string, stderr: string): string {
  const tail = stderrTail(stderr);
  return tail ? `${message}: ${tail}` : message;
}

/** OpenAI-style error bodies are objects; never render "[object Object]". */
function errorBodyText(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const err = body["error"];
  if (typeof err === "string" && err) return err;
  if (isRecord(err) && typeof err["message"] === "string") return err["message"];
  if (typeof body["detail"] === "string") return body["detail"];
  return null;
}

/**
 * The server streams WAV with placeholder sizes (0xFFFFFFFF). The body is
 * fully buffered here, so write the real RIFF and data sizes.
 */
export function fixStreamedWav(wav: Buffer): Buffer {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF") return wav;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    if (id === "data") {
      wav.writeUInt32LE(wav.length - 8, 4);
      wav.writeUInt32LE(wav.length - offset - 8, offset + 4);
      return wav;
    }
    offset += 8 + wav.readUInt32LE(offset + 4);
  }
  return wav;
}

function aborted(): SynthError {
  return new SynthError("VieNeu synthesis stopped", "ABORTED");
}

/** Reject with ABORTED as soon as signal aborts; p keeps running. */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(aborted());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

// ---------------------------------------------------------------- engine

export function createVieneuSynth(opts: VieneuOptions): VieneuSynth {
  const deps: VieneuDeps = { ...defaultDeps, ...opts.deps };
  const host = opts.host ?? "127.0.0.1";
  const basePort = opts.basePort ?? 8000;
  const portScanMax = Math.max(1, Math.floor(opts.portScanMax ?? 4));
  const startTimeoutMs = opts.startTimeoutMs ?? 180_000;
  const cooldownMs = opts.cooldownMs ?? 120_000;
  const pollMs = opts.pollMs ?? 1000;
  const synthTimeoutMs = opts.synthTimeoutMs ?? 120_000;
  const busyBackoffMs = opts.busyBackoffMs ?? 500;
  const log = (message: string, level: "debug" | "info" | "warn" | "error" = "debug"): void =>
    opts.logger?.log("TTS", message, level);

  let server: Server | null = null;
  let starting: Promise<Server> | null = null;
  let failure: { reason: string; until: number } | null = null;
  let cancelRetry: (() => void) | null = null;
  let disposed = false;
  const lifetime = new AbortController();
  /** Spawned processes that have not exited yet (killed on dispose). */
  const alive = new Set<VieneuChild>();

  const baseUrl = (port: number): string => `http://${host}:${port}`;
  const unavailable = (reason: string): SynthError =>
    new SynthError(`VieNeu unavailable (${reason}) — using Piper`, "UNAVAILABLE");

  function kill(child: VieneuChild): void {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    deps.schedule(() => {
      if (!alive.has(child)) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, KILL_GRACE_MS);
  }

  function markFailed(reason: string, scheduleRetry: boolean): void {
    failure = { reason, until: deps.now() + cooldownMs };
    log(`VieNeu start failed: ${reason}`, "warn");
    cancelRetry?.();
    cancelRetry = null;
    if (!scheduleRetry || disposed) return;
    cancelRetry = deps.schedule(() => {
      cancelRetry = null;
      if (disposed || server) return;
      log("VieNeu background retry", "info");
      ensureServer(true).catch(() => {});
    }, cooldownMs);
  }

  async function probe(port: number): Promise<"vieneu" | "other" | "down"> {
    let resp: VieneuResponse;
    try {
      resp = await deps.fetch(`${baseUrl(port)}/health`, { signal: AbortSignal.timeout(2000) });
    } catch {
      return "down";
    }
    if (!resp.ok) return "other";
    try {
      return isVieneuHealth(await resp.json()) ? "vieneu" : "other";
    } catch {
      return "other";
    }
  }

  async function spawnOn(port: number, deadline: number): Promise<Server> {
    let child: VieneuChild;
    try {
      child = deps.spawn(opts.python, [SERVER_SCRIPT], {
        cwd: deps.workDir(),
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, HOST: host, PORT: String(port) },
      });
    } catch (err) {
      throw new StartFailure(`cannot run ${opts.python}: ${errorMessage(err)}`);
    }
    alive.add(child);
    log(`VieNeu sidecar spawned pid=${child.pid ?? "?"} port=${port}`);
    let stderr = "";
    let exited: string | null = null;
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-STDERR_KEEP);
    });
    child.on("exit", (code, signal) => {
      alive.delete(child);
      const how = typeof code === "number" ? `code=${code}` : `signal=${String(signal)}`;
      exited ??= `sidecar exited (${how})`;
      if (server?.proc !== child) return;
      server = null;
      if (!disposed) markFailed(withTail(exited, stderr), true);
    });
    child.on("error", (err) => {
      alive.delete(child);
      exited ??= `cannot run ${opts.python}: ${errorMessage(err)}`;
    });

    for (;;) {
      if (disposed) {
        kill(child);
        throw new StartFailure("stopped");
      }
      if (exited !== null) {
        throw new StartFailure(
          withTail(exited, stderr),
          /address already in use|errno 48|errno 98/i.test(stderr),
        );
      }
      if (deps.now() >= deadline) {
        kill(child);
        throw new StartFailure(
          withTail(`did not start within ${Math.round(startTimeoutMs / 1000)}s`, stderr),
        );
      }
      if ((await probe(port)) === "vieneu" && exited === null) return { port, proc: child };
      try {
        await deps.sleep(pollMs, lifetime.signal);
      } catch {
        // disposed; handled at the top of the loop
      }
    }
  }

  async function start(): Promise<Server> {
    const deadline = deps.now() + startTimeoutMs;
    for (let i = 0; i < portScanMax; i++) {
      const port = basePort + i;
      const state = await probe(port);
      if (disposed) throw new StartFailure("stopped");
      if (state === "vieneu") {
        log(`VieNeu adopted existing sidecar on port ${port}`, "info");
        return { port, proc: null };
      }
      if (state === "other") {
        log(`port ${port} is used by another program`, "warn");
        continue;
      }
      try {
        return await spawnOn(port, deadline);
      } catch (err) {
        if (err instanceof StartFailure && err.portInUse) {
          log(`port ${port} is taken`, "warn");
          continue;
        }
        throw err;
      }
    }
    throw new StartFailure(`no free port in ${basePort}-${basePort + portScanMax - 1}`);
  }

  function ensureServer(background = false): Promise<Server> {
    if (server) return Promise.resolve(server);
    if (starting) return starting;
    const p = start().then(
      (s) => {
        if (disposed) {
          if (s.proc) kill(s.proc);
          throw unavailable("stopped");
        }
        server = s;
        failure = null;
        log(`VieNeu ready at ${baseUrl(s.port)}`, "info");
        return s;
      },
      (err: unknown) => {
        const reason = errorMessage(err);
        if (!disposed) markFailed(reason, !background);
        throw unavailable(reason);
      },
    );
    starting = p;
    p.then(
      () => {
        if (starting === p) starting = null;
      },
      () => {
        if (starting === p) starting = null;
      },
    );
    return p;
  }

  async function request(s: Server, text: string, signal?: AbortSignal): Promise<Buffer> {
    for (let attempt = 1; ; attempt++) {
      const timeout = AbortSignal.timeout(synthTimeoutMs);
      const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let resp: VieneuResponse;
      let wav: Buffer | null = null;
      try {
        resp = await deps.fetch(`${baseUrl(s.port)}/v1/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: MODEL_ID,
            input: text,
            voice: opts.voice() || DEFAULT_VIENEU_VOICE,
            response_format: "wav",
          }),
          signal: sig,
        });
        if (resp.ok) wav = Buffer.from(await resp.arrayBuffer());
      } catch (err) {
        if (signal?.aborted) throw aborted();
        if (timeout.aborted) {
          throw new SynthError(
            `VieNeu timed out after ${Math.round(synthTimeoutMs / 1000)}s — try a shorter text`,
            "FAILED",
          );
        }
        // An adopted sidecar went away: forget it so the next call starts one.
        // An owned one is forgotten by its exit handler.
        if (server === s && s.proc === null) server = null;
        throw new SynthError(`VieNeu request failed (${errorMessage(err)})`, "FAILED");
      }
      if (wav) {
        if (wav.length === 0) throw new SynthError("VieNeu returned no audio", "FAILED");
        return fixStreamedWav(wav);
      }
      if ((resp.status === 429 || resp.status === 503) && attempt < BUSY_TRIES) {
        log(`VieNeu busy (HTTP ${resp.status}), retry ${attempt}/${BUSY_TRIES - 1}`, "warn");
        try {
          await deps.sleep(busyBackoffMs * 2 ** (attempt - 1), signal);
        } catch {
          throw aborted();
        }
        if (signal?.aborted) throw aborted();
        continue;
      }
      let detail: string | null = null;
      try {
        detail = errorBodyText(await resp.json());
      } catch {
        // keep the status-only message
      }
      const busy = resp.status === 429 || resp.status === 503;
      const what = busy ? `busy after ${BUSY_TRIES} tries` : "failed";
      throw new SynthError(
        `VieNeu ${what} (HTTP ${resp.status}${detail ? `: ${detail}` : ""})`,
        "FAILED",
      );
    }
  }

  return {
    name: "vieneu",

    supports(lang: SpeechLang): boolean {
      return lang === "vi" || lang === "en";
    },

    async synthesize(seg: SpeechSegment, signal?: AbortSignal): Promise<Buffer> {
      if (signal?.aborted) throw aborted();
      if (disposed) throw unavailable("stopped");
      // Fail fast during the cooldown and while the background retry runs,
      // so speech falls back to Piper instead of waiting on a slow start.
      if (failure && (deps.now() < failure.until || starting)) throw unavailable(failure.reason);
      const s = await abortable(ensureServer(), signal);
      return request(s, seg.text, signal);
    },

    warm(): void {
      if (disposed || server || starting) return;
      if (failure && deps.now() < failure.until) return;
      ensureServer().catch(() => {});
    },

    async voices(): Promise<string[]> {
      const s = server;
      if (!s) return [...VIENEU_VOICES];
      try {
        const resp = await deps.fetch(`${baseUrl(s.port)}/v1/voices`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!resp.ok) return [...VIENEU_VOICES];
        const body = await resp.json();
        const data = isRecord(body) && Array.isArray(body["data"]) ? body["data"] : [];
        const names = data
          .map((v: unknown) => (isRecord(v) && typeof v["id"] === "string" ? v["id"] : null))
          .filter((v): v is string => v !== null);
        return names.length > 0 ? names : [...VIENEU_VOICES];
      } catch {
        return [...VIENEU_VOICES];
      }
    },

    async dispose(): Promise<void> {
      disposed = true;
      lifetime.abort();
      cancelRetry?.();
      cancelRetry = null;
      server = null;
      for (const child of alive) kill(child);
    },
  };
}
