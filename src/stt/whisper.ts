// Local whisper.cpp transcription. Prefers a persistent whisper-server
// sidecar (model loaded once, shared per modelPath between batch and
// streaming via a refcounted registry); falls back to one-shot whisper-cli
// when whisper-server is not installed.

import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Logger, TranscribeOptions, Transcriber } from "../types.ts";
import { errorMessage } from "../types.ts";
import { cleanTranscript } from "./filter.ts";
import { abortError, wavDurationSec } from "./long.ts";

export const WHISPER_HOST = "127.0.0.1";
export const WHISPER_BASE_PORT = 8178;
export const WHISPER_PORT_SCAN = 10;
const START_TIMEOUT_MS = 60_000;
const POLL_MS = 250;

// ---------------------------------------------------------------- deps

interface DataSource {
  on(event: "data", cb: (chunk: Buffer) => void): unknown;
}

/** The subset of ChildProcess used here (lets tests pass a fake). */
export interface ChildLike {
  readonly stdout: DataSource | null;
  readonly stderr: DataSource | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", cb: (code: number | null) => void): unknown;
  once(event: "error", cb: (err: Error) => void): unknown;
}

export interface WhisperDeps {
  spawn(cmd: string, args: readonly string[]): ChildLike;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  isPortFree(port: number): Promise<boolean>;
  onPath(cmd: string): boolean;
  existsSync(p: string): boolean;
  writeFile(p: string, data: Buffer): Promise<void>;
  rm(p: string): Promise<void>;
  tmpdir(): string;
  now(): number;
  sleep(ms: number): Promise<void>;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

function onPathReal(cmd: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return dirs.some((d) => fs.existsSync(path.join(d, cmd)));
}

function isPortFreeReal(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, WHISPER_HOST, () => srv.close(() => resolve(true)));
  });
}

const realDeps: WhisperDeps = {
  spawn: (cmd, args) => nodeSpawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"] }),
  fetch: (url, init) => fetch(url, init),
  isPortFree: isPortFreeReal,
  onPath: onPathReal,
  existsSync: (p) => fs.existsSync(p),
  writeFile: (p, data) => fs.promises.writeFile(p, data),
  rm: (p) => fs.promises.rm(p, { force: true }),
  tmpdir: () => os.tmpdir(),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

// ---------------------------------------------------------------- errors

function modelMissing(modelPath: string): Error {
  return new Error(`Whisper model not found: ${modelPath} — pick one with /stt-model`);
}

function timeoutError(ms: number): Error {
  return new Error(
    `Whisper timed out after ${Math.round(ms / 1000)}s — try a smaller model with /stt-model`,
  );
}

function lastLine(text: string): string {
  return text.trim().split("\n").pop()?.trim() ?? "";
}

function isAddressInUse(stderr: string): boolean {
  return /address already in use|EADDRINUSE|failed to bind|bind.*fail/i.test(stderr);
}

/** Audio-scaled request budget: 20s + 2x the audio duration. */
export function whisperTimeoutMs(wav: Buffer): number {
  return 20_000 + Math.ceil(2 * wavDurationSec(wav) * 1000);
}

// ---------------------------------------------------------------- registry

interface ServerEntry {
  readonly modelPath: string;
  readonly threads: number | undefined;
  readonly deps: WhisperDeps;
  readonly logger: Logger | undefined;
  refs: number;
  proc: ChildLike | null;
  port: number | null;
  ready: boolean;
  starting: Promise<number> | null;
  disposed: boolean;
}

const registry = new Map<string, ServerEntry>();

/** Test helper: kill and forget every shared server. */
export function resetWhisperServersForTests(): void {
  for (const e of registry.values()) killEntry(e);
  registry.clear();
}

function killEntry(e: ServerEntry): void {
  e.disposed = true;
  e.ready = false;
  const proc = e.proc;
  e.proc = null;
  e.port = null;
  if (proc) {
    try {
      proc.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
}

function log(e: ServerEntry, msg: string, level: "debug" | "info" | "warn" = "debug"): void {
  e.logger?.log("STT", msg, level);
}

export function buildServerArgs(modelPath: string, port: number, threads?: number): string[] {
  const args = ["-m", modelPath, "--host", WHISPER_HOST, "--port", String(port)];
  if (threads) args.push("-t", String(threads));
  return args;
}

type Probe = "ready" | "loading" | "down";

async function probe(e: ServerEntry, port: number): Promise<Probe> {
  try {
    const resp = await e.deps.fetch(`http://${WHISPER_HOST}:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    // 404: build predates /health. The port was free before our spawn and
    // our process is still alive, so the responder is ours.
    if (resp.ok || resp.status === 404) return "ready";
    return "loading";
  } catch {
    return "down";
  }
}

type StartResult = { ok: true } | { ok: false; inUse: true };

async function startOnPort(e: ServerEntry, port: number): Promise<StartResult> {
  const args = buildServerArgs(e.modelPath, port, e.threads);
  log(e, `starting whisper-server port=${port}`);
  let proc: ChildLike;
  try {
    proc = e.deps.spawn("whisper-server", args);
  } catch (err) {
    throw new Error(
      `Could not start whisper-server: ${errorMessage(err)} — reinstall whisper.cpp and retry`,
    );
  }
  let exited = false;
  let exitCode: number | null = null;
  let stderr = "";
  proc.stderr?.on("data", (c) => {
    stderr = (stderr + c.toString()).slice(-4000);
  });
  const onGone = (): void => {
    exited = true;
    if (e.proc !== proc) return;
    if (e.ready) log(e, `whisper-server exited code=${exitCode}`, "warn");
    e.proc = null;
    e.port = null;
    e.ready = false;
  };
  proc.once("exit", (code) => {
    exitCode = code;
    onGone();
  });
  proc.once("error", (err) => {
    stderr += `\n${err.message}`;
    onGone();
  });
  e.proc = proc;
  e.port = port;
  e.ready = false;

  const deadline = e.deps.now() + START_TIMEOUT_MS;
  while (!exited && !e.disposed && e.deps.now() < deadline) {
    const state = await probe(e, port);
    if (exited || e.disposed) break;
    if (state === "ready") {
      e.ready = true;
      log(e, `whisper-server ready port=${port}`);
      return { ok: true };
    }
    await e.deps.sleep(POLL_MS);
  }
  if (e.disposed) {
    // Disposed mid-start: never leave an orphan server behind.
    try {
      proc.kill("SIGTERM");
    } catch {
      // already gone
    }
    throw new Error("Whisper transcriber was disposed");
  }
  if (exited) {
    if (isAddressInUse(stderr)) {
      log(e, `whisper-server port ${port} lost bind race, trying next`, "warn");
      return { ok: false, inUse: true };
    }
    const why = lastLine(stderr) || `exit code ${exitCode}`;
    log(e, `whisper-server exited before ready: ${why}`, "warn");
    throw new Error(
      `whisper-server failed to start: ${why} — check the model or pick another with /stt-model`,
    );
  }
  if (e.proc === proc) killEntryProc(e);
  throw new Error(
    `whisper-server did not start within ${START_TIMEOUT_MS / 1000}s — try a smaller model with /stt-model`,
  );
}

function killEntryProc(e: ServerEntry): void {
  const proc = e.proc;
  e.proc = null;
  e.port = null;
  e.ready = false;
  try {
    proc?.kill("SIGTERM");
  } catch {
    // already gone
  }
}

async function startServer(e: ServerEntry): Promise<number> {
  // Always scan from the FIXED base so ports never drift across restarts.
  for (let i = 0; i < WHISPER_PORT_SCAN; i++) {
    const port = WHISPER_BASE_PORT + i;
    if (e.disposed) throw new Error("Whisper transcriber was disposed");
    if (!(await e.deps.isPortFree(port))) {
      log(e, `port ${port} busy, trying next`);
      continue;
    }
    const r = await startOnPort(e, port);
    if (r.ok) return port;
  }
  const last = WHISPER_BASE_PORT + WHISPER_PORT_SCAN - 1;
  throw new Error(
    `No free port for whisper-server in ${WHISPER_BASE_PORT}-${last} — close other whisper-server processes and retry`,
  );
}

/** Running server port; concurrent callers share one start. */
function ensureServer(e: ServerEntry): Promise<number> {
  if (e.proc && e.ready && e.port !== null) return Promise.resolve(e.port);
  if (!e.starting) {
    e.starting = startServer(e).finally(() => {
      e.starting = null;
    });
  }
  return e.starting;
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

// ---------------------------------------------------------------- transcriber

export interface WhisperTranscriberOptions {
  readonly modelPath: string;
  readonly threads?: number;
  readonly logger?: Logger;
  readonly deps?: Partial<WhisperDeps>;
}

let tmpCounter = 0;

export function createWhisperTranscriber(opts: WhisperTranscriberOptions): Transcriber {
  const deps: WhisperDeps = { ...realDeps, ...opts.deps };
  const { modelPath } = opts;
  let entry = registry.get(modelPath);
  if (!entry) {
    entry = {
      modelPath,
      threads: opts.threads,
      deps,
      logger: opts.logger,
      refs: 0,
      proc: null,
      port: null,
      ready: false,
      starting: null,
      disposed: false,
    };
    registry.set(modelPath, entry);
  }
  entry.refs += 1;
  const e = entry;
  let released = false;

  function mode(): "server" | "cli" {
    if (released) throw new Error("Whisper transcriber was disposed");
    if (!deps.existsSync(modelPath)) throw modelMissing(modelPath);
    if (deps.onPath("whisper-server")) return "server";
    if (deps.onPath("whisper-cli")) return "cli";
    throw new Error(
      "whisper.cpp is not installed — install whisper-cpp (e.g. brew install whisper-cpp) and retry",
    );
  }

  async function viaServer(wav: Buffer, o: TranscribeOptions, retried: boolean): Promise<string> {
    const port = await raceAbort(ensureServer(e), o.signal);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
    form.append("response_format", "json");
    form.append("temperature", "0");
    form.append("language", o.language);
    if (o.prompt) form.append("prompt", o.prompt);

    const budget = whisperTimeoutMs(wav);
    const ctl = new AbortController();
    let timedOut = false;
    const timer = deps.setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, budget);
    const onAbort = (): void => ctl.abort();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const resp = await deps.fetch(`http://${WHISPER_HOST}:${port}/inference`, {
        method: "POST",
        body: form,
        signal: ctl.signal,
      });
      if (!resp.ok) {
        throw new Error(
          `whisper-server responded ${resp.status} — retry, or pick another model with /stt-model`,
        );
      }
      const data: unknown = await resp.json();
      const text =
        typeof data === "object" && data !== null && "text" in data && typeof data.text === "string"
          ? data.text
          : "";
      return cleanTranscript(text);
    } catch (err) {
      if (o.signal?.aborted) throw abortError();
      if (timedOut) throw timeoutError(budget);
      if (err instanceof Error && err.message.startsWith("whisper-server responded")) throw err;
      // Server died mid-request: restart it once and retry.
      if (!retried && e.proc === null && !e.disposed) {
        log(e, "whisper-server gone during request, restarting once", "warn");
        return viaServer(wav, o, true);
      }
      throw new Error(
        `Whisper request failed: ${errorMessage(err)} — retry, or restart OpenCode if it persists`,
      );
    } finally {
      deps.clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
    }
  }

  async function viaCli(wav: Buffer, o: TranscribeOptions): Promise<string> {
    if (o.signal?.aborted) throw abortError();
    tmpCounter += 1;
    const file = path.join(
      deps.tmpdir(),
      `opencode-voice-whisper-${process.pid}-${tmpCounter}.wav`,
    );
    await deps.writeFile(file, wav);
    try {
      return await runCli(file, wav, o);
    } finally {
      await deps.rm(file).catch(() => undefined);
    }
  }

  function runCli(file: string, wav: Buffer, o: TranscribeOptions): Promise<string> {
    const args = ["-m", modelPath, "-f", file, "-l", o.language, "-np", "-nt"];
    if (opts.threads) args.push("-t", String(opts.threads));
    if (o.prompt) args.push("--prompt", o.prompt);
    const budget = whisperTimeoutMs(wav);
    return new Promise<string>((resolve, reject) => {
      let proc: ChildLike;
      try {
        proc = deps.spawn("whisper-cli", args);
      } catch (err) {
        reject(
          new Error(`Could not start whisper-cli: ${errorMessage(err)} — reinstall whisper.cpp`),
        );
        return;
      }
      let stdout = "";
      let stderr = "";
      let done = false;
      const finish = (fn: () => void): void => {
        if (done) return;
        done = true;
        deps.clearTimeout(timer);
        o.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const kill = (): void => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
      };
      const timer = deps.setTimeout(() => {
        kill();
        finish(() => reject(timeoutError(budget)));
      }, budget);
      const onAbort = (): void => {
        kill();
        finish(() => reject(abortError()));
      };
      o.signal?.addEventListener("abort", onAbort, { once: true });
      proc.stdout?.on("data", (c) => {
        stdout += c.toString();
      });
      proc.stderr?.on("data", (c) => {
        stderr = (stderr + c.toString()).slice(-4000);
      });
      proc.once("error", (err) => {
        finish(() =>
          reject(new Error(`whisper-cli failed: ${err.message} — reinstall whisper.cpp`)),
        );
      });
      proc.once("exit", (code) => {
        finish(() => {
          // whisper-cli exits 0 on an unknown language; surface it.
          const lang = stderr.match(/error: unknown language '([^']+)'/);
          if (lang) {
            reject(
              new Error(`Unknown whisper language: ${lang[1]} — pick another with /stt-language`),
            );
            return;
          }
          if (code !== 0) {
            const why = lastLine(stderr) || `exit code ${code}`;
            log(e, `whisper-cli exited code=${code}`, "warn");
            reject(new Error(`whisper-cli failed: ${why} — check the recording and the model`));
            return;
          }
          resolve(cleanTranscript(stdout));
        });
      });
    });
  }

  return {
    async transcribe(wav, o) {
      if (o.signal?.aborted) throw abortError();
      const m = mode();
      log(e, `transcribe mode=${m} bytes=${wav.length}`);
      return m === "server" ? viaServer(wav, o, false) : viaCli(wav, o);
    },
    async warm() {
      if (mode() === "server") await ensureServer(e);
    },
    describe() {
      const name = path
        .basename(modelPath)
        .replace(/^ggml-/, "")
        .replace(/\.bin$/, "");
      return `whisper ${name}`;
    },
    async dispose() {
      if (released) return;
      released = true;
      e.refs -= 1;
      if (e.refs <= 0) {
        if (registry.get(modelPath) === e) registry.delete(modelPath);
        killEntry(e);
      }
    },
  };
}

// ---------------------------------------------------------------- models

export interface ModelScanDeps {
  homedir(): string;
  existsSync(p: string): boolean;
  readdirSync(dir: string): string[];
  statSync(p: string): { size: number; isFile(): boolean };
}

const realScanDeps: ModelScanDeps = {
  homedir: () => os.homedir(),
  existsSync: (p) => fs.existsSync(p),
  readdirSync: (d) => fs.readdirSync(d),
  statSync: (p) => fs.statSync(p),
};

export function whisperModelDirs(home: string): string[] {
  return [
    path.join(home, ".local", "share", "whisper-cpp"),
    path.join(home, ".local", "share", "whisper-cpp", "models"),
    "/opt/homebrew/share/whisper-cpp/models",
    "/opt/homebrew/share/whisper-cpp",
    "/usr/local/share/whisper-cpp/models",
    "/usr/local/share/whisper-cpp",
    path.join(home, ".cache", "whisper"),
  ];
}

/** ggml whisper models found on disk, largest first. VAD models excluded. */
export function findWhisperModels(deps: Partial<ModelScanDeps> = {}): string[] {
  const d: ModelScanDeps = { ...realScanDeps, ...deps };
  const found = new Map<string, number>();
  for (const dir of whisperModelDirs(d.homedir())) {
    if (!d.existsSync(dir)) continue;
    let names: string[];
    try {
      names = d.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^ggml-.*\.bin$/.test(name) || /silero|vad/i.test(name)) continue;
      const p = path.join(dir, name);
      try {
        const st = d.statSync(p);
        if (st.isFile()) found.set(p, st.size);
      } catch {
        // unreadable entry: skip
      }
    }
  }
  return [...found.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([p]) => p);
}

/** Prefer large-v3-turbo when present, else the largest model, else null. */
export function defaultWhisperModel(deps: Partial<ModelScanDeps> = {}): string | null {
  const models = findWhisperModels(deps);
  return models.find((p) => path.basename(p).includes("large-v3-turbo")) ?? models[0] ?? null;
}

/**
 * Short label for a ggml model file, for the status line:
 * ggml-large-v3-turbo-q5_0.bin → "turbo", ggml-medium.bin → "medium".
 */
export function shortModelName(modelPath: string): string {
  const base = (modelPath.split("/").pop() ?? modelPath)
    .replace(/^ggml-/, "")
    .replace(/\.bin$/, "")
    .replace(/-q\d(_\d)?$/, "")
    .replace(/\.en$/, " en");
  if (/turbo/.test(base)) return base.includes(" en") ? "turbo en" : "turbo";
  return base || "whisper";
}
