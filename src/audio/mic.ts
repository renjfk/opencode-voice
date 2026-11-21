// Microphone capture: local sox or a remote command (ssh to a phone), both
// producing raw s16le mono PCM on stdout.

import { spawn as nodeSpawn } from "node:child_process";
import type { Logger, MicConfig, MicError, MicStream } from "../types.ts";
import { defaultRun, ensureUsbForward, loopbackSshPort } from "./usb.ts";
import type { RunFn, UsbForwardResult } from "./usb.ts";

// ---------------------------------------------------------------- process seam

/** The subset of a Node ChildProcess this module uses. */
export interface ChildProc {
  readonly pid?: number | undefined;
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "spawn", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export type StdioKind = "pipe" | "ignore";
export type SpawnFn = (
  cmd: string,
  args: readonly string[],
  opts: { stdio: [StdioKind, StdioKind, StdioKind] },
) => ChildProc;

export const defaultSpawn: SpawnFn = (cmd, args, opts) => nodeSpawn(cmd, [...args], opts);

/** Run fn after ms; returns a cancel function. */
export type ScheduleFn = (fn: () => void, ms: number) => () => void;

export const defaultSchedule: ScheduleFn = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

function errnoCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const c = (err as { code: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

function lastLine(s: string): string {
  return s.trim().split("\n").pop()?.trim() ?? "";
}

// ---------------------------------------------------------------- mic

export interface MicDeps {
  readonly spawn?: SpawnFn;
  readonly schedule?: ScheduleFn;
  readonly run?: RunFn;
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Linux: is PulseAudio/PipeWire-pulse available? Default probes `pactl --version`. */
  readonly hasPulse?: () => Promise<boolean>;
  readonly ensureUsbForward?: (port: number) => Promise<UsbForwardResult>;
  readonly noAudioTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly logger?: Logger;
}

export const PHONE_UNREACHABLE_HINT =
  "Phone not reachable: check USB cable / adb forward tcp:8022 tcp:8022 and that sshd runs in Termux";

const SOX_MISSING_HINT = "Install sox: brew install sox";

class MicFailure extends Error implements MicError {
  constructor(
    readonly code: MicError["code"],
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "MicError";
  }
}

type LocalBackend = "coreaudio" | "pulseaudio" | "default";

async function localBackend(deps: MicDeps): Promise<LocalBackend> {
  const platform = deps.platform ?? process.platform;
  if (platform === "darwin") return "coreaudio";
  const hasPulse =
    deps.hasPulse ??
    (async () => (await (deps.run ?? defaultRun)("pactl", ["--version"], 3000)).code === 0);
  return (await hasPulse()) ? "pulseaudio" : "default";
}

/** sox input args for the backend (ported from lib/stt/audio.js buildRecordArgs). */
export function soxInputArgs(backend: LocalBackend, device: string | undefined): string[] {
  if (backend === "pulseaudio") return ["-t", "pulseaudio", device || "default"];
  if (backend === "coreaudio" && device) return ["-t", "coreaudio", device];
  return ["-d"];
}

function localHint(backend: LocalBackend, env: MicDeps["env"]): string {
  if (backend === "pulseaudio") {
    const wsl = Boolean(env?.WSL_DISTRO_NAME || env?.WSL_INTEROP);
    return wsl
      ? 'Audio server unreachable on WSL: run "wsl --shutdown" on Windows, then reopen Ubuntu'
      : "Check that PipeWire/PulseAudio is running and the input source is set";
  }
  return "Check the input device and that your terminal has microphone permission";
}

/** Open a capture stream. Rejects with a MicError when it cannot start. */
export async function openMic(cfg: MicConfig, deps: MicDeps = {}): Promise<MicStream> {
  const spawn = deps.spawn ?? defaultSpawn;
  const schedule = deps.schedule ?? defaultSchedule;
  const env = deps.env ?? process.env;
  const remote = cfg.kind === "remote";

  let cmd: string;
  let args: readonly string[];
  let label: string;
  let hint: string;
  if (remote) {
    const command = cfg.command;
    const bin = command?.[0];
    if (!command || bin === undefined) {
      throw new MicFailure(
        "SPAWN_FAILED",
        "Remote mic has no capture command",
        "Set the remote capture command, or switch the mic to local",
      );
    }
    if (cfg.usbAutoForward) {
      const port = loopbackSshPort(command);
      if (port !== null) {
        const fwd = await (
          deps.ensureUsbForward ?? ((p) => ensureUsbForward(p, { run: deps.run }))
        )(port);
        if (!fwd.ok) throw new MicFailure("CONNECTION", fwd.message, fwd.hint);
      }
    }
    cmd = bin;
    args = command.slice(1);
    label = `${cfg.label ?? "Phone"} capture`;
    hint = cfg.label
      ? `Check the microphone on ${cfg.label}`
      : "Check the capture script on the phone";
  } else {
    const backend = await localBackend(deps);
    cmd = "sox";
    args = [
      ...soxInputArgs(backend, cfg.device),
      "-r",
      String(cfg.sampleRate),
      "-c",
      "1",
      "-b",
      "16",
      "-e",
      "signed-integer",
      "-t",
      "raw",
      "-",
    ];
    label = "sox";
    hint = localHint(backend, env);
  }

  let child: ChildProc;
  try {
    child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    throw spawnFailure(cmd, err, remote);
  }
  // Wait for the OS to confirm the spawn: ENOENT arrives as an async event.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: unknown): void => {
      if (settled) return;
      settled = true;
      if (err === undefined) resolve();
      else reject(spawnFailure(cmd, err, remote));
    };
    child.on("spawn", () => done());
    child.on("error", (err) => done(err));
  });

  deps.logger?.log("mic", `capture started kind=${cfg.kind} pid=${child.pid ?? "?"}`, "debug");
  const killCommand = cfg.killCommand;
  const cleanup =
    remote && killCommand && killCommand[0] !== undefined
      ? (): void => {
          const [kbin, ...kargs] = killCommand;
          void (deps.run ?? defaultRun)(kbin as string, kargs, 5000).catch(() => {});
        }
      : null;
  const stopCommand = cfg.stopCommand;
  const gracefulStop =
    remote && stopCommand && stopCommand[0] !== undefined
      ? (): void => {
          const [sbin, ...sargs] = stopCommand;
          void (deps.run ?? defaultRun)(sbin as string, sargs, 8000).catch(() => {});
        }
      : null;
  return createStream(child, {
    remote,
    gracefulStop,
    zeroHint:
      cfg.zeroHint ??
      (remote
        ? `Unmute the microphone on ${cfg.label ?? "the device"}`
        : "Check that the input is not muted and the terminal has microphone permission"),
    label,
    hint,
    device: cfg.label ?? "the phone",
    unreachableHint: cfg.unreachableHint ?? PHONE_UNREACHABLE_HINT,
    cleanup,
    sampleRate: cfg.sampleRate,
    schedule,
    noAudioTimeoutMs: deps.noAudioTimeoutMs ?? (remote ? 8000 : 4000),
    stopTimeoutMs: deps.stopTimeoutMs ?? (gracefulStop ? 6000 : 3000),
    logger: deps.logger,
  });
}

function spawnFailure(cmd: string, err: unknown, remote: boolean): MicFailure {
  if (errnoCode(err) === "ENOENT") {
    return new MicFailure(
      "SPAWN_FAILED",
      `${cmd} not found`,
      remote ? `Install ${cmd} or fix the remote capture command` : SOX_MISSING_HINT,
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new MicFailure(
    "SPAWN_FAILED",
    `Could not start ${cmd}: ${msg}`,
    remote ? "Check the remote capture command" : SOX_MISSING_HINT,
  );
}

interface StreamOpts {
  readonly remote: boolean;
  readonly label: string;
  readonly hint: string;
  readonly sampleRate: number;
  readonly schedule: ScheduleFn;
  readonly noAudioTimeoutMs: number;
  readonly stopTimeoutMs: number;
  readonly logger: Logger | undefined;
  readonly device: string;
  readonly unreachableHint: string;
  /** Remote cleanup after stop/kill (runs once). */
  readonly cleanup: (() => void) | null;
  /** Ask the device to finish and flush; the process then exits by itself. */
  readonly gracefulStop: (() => void) | null;
  /** What to do when the device only streams zeros. */
  readonly zeroHint: string;
}

function createStream(child: ChildProc, o: StreamOpts): MicStream {
  let cleaned = false;
  const cleanupOnce = (): void => {
    if (cleaned || !o.cleanup) return;
    cleaned = true;
    o.cleanup();
  };
  const dataCbs = new Set<(chunk: Buffer) => void>();
  const errorCbs = new Set<(err: MicError) => void>();
  let paused = false;
  let gotBytes = false;
  let closed = false;
  /** Set by stop()/kill()/our own NO_AUDIO kill: exit is not an error. */
  let expected = false;
  /** kill() drops everything; stop() still flushes trailing output. */
  let dropAll = false;
  let error: MicError | null = null;
  let stderrTail = "";
  let cancelNoAudio: (() => void) | null = null;
  const closeWaiters: (() => void)[] = [];

  function emitError(err: MicError): void {
    if (error) return;
    error = err;
    o.logger?.log("mic", `capture error ${err.code}: ${err.message}`, "warn");
    for (const cb of errorCbs) {
      try {
        cb(err);
      } catch {}
    }
  }

  // A device that streams pure digital silence is being blocked (Android
  // silences background apps' microphones; a muted input does the same).
  let zeroBytes = 0;
  let sawSignal = false;
  const ZERO_LIMIT = o.sampleRate * 2 * 3; // 3 s
  function checkZeros(buf: Buffer): void {
    if (sawSignal || error) return;
    for (let i = 0; i + 1 < buf.length; i += 2) {
      if (buf.readInt16LE(i) !== 0) {
        sawSignal = true;
        return;
      }
    }
    zeroBytes += buf.length;
    if (zeroBytes >= ZERO_LIMIT) {
      const who = o.remote ? o.device.replace(/^the p/, "P") : "The microphone";
      emitError({
        code: "NO_AUDIO",
        message: `${who} sends only silence (microphone blocked or muted)`,
        hint: o.zeroHint,
      });
    }
  }

  function signal(sig: NodeJS.Signals): void {
    if (closed) return;
    try {
      child.kill(sig);
    } catch {}
  }

  child.stdout?.on("data", (chunk: Buffer | string) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buf.length === 0) return;
    if (!gotBytes) {
      gotBytes = true;
      cancelNoAudio?.();
      cancelNoAudio = null;
    }
    checkZeros(buf);
    // Paused audio is drained and dropped: the process keeps running so a
    // remote pipe never buffers paused speech and replays it on resume.
    if (paused || dropAll) return;
    for (const cb of dataCbs) {
      try {
        cb(buf);
      } catch {}
    }
  });
  child.stdout?.on("error", () => {});
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-400);
  });

  child.on("error", (err) => {
    if (expected || closed) return;
    emitError({
      code: "EXITED",
      message: `${o.label} failed: ${err.message}`,
      hint: o.hint,
    });
  });

  child.on("close", (code, sig) => {
    closed = true;
    cancelNoAudio?.();
    cancelNoAudio = null;
    o.logger?.log("mic", `capture closed code=${code} signal=${sig} expected=${expected}`, "debug");
    if (!expected) {
      const detail = lastLine(stderrTail);
      const suffix = detail ? `: ${detail}` : "";
      if (o.remote && code === 255) {
        emitError({
          code: "CONNECTION",
          message: `${o.device === "the phone" ? "Phone" : o.device} connection failed (ssh exit 255)${suffix}`,
          hint: o.unreachableHint,
        });
      } else {
        const how = code !== null ? `code ${code}` : `signal ${sig ?? "?"}`;
        emitError({
          code: "EXITED",
          message: `${o.label} exited unexpectedly (${how})${suffix}`,
          hint: o.hint,
        });
      }
    }
    for (const w of closeWaiters.splice(0)) w();
  });

  cancelNoAudio = o.schedule(() => {
    cancelNoAudio = null;
    if (gotBytes || closed || expected) return;
    expected = true;
    dropAll = true;
    signal("SIGKILL");
    const secs = Math.round(o.noAudioTimeoutMs / 1000);
    emitError({
      code: "NO_AUDIO",
      message: o.remote
        ? `No audio from ${o.device} in ${secs}s`
        : `No audio from the microphone in ${secs}s`,
      hint: o.remote ? `Check that the microphone on ${o.device} is free` : o.hint,
    });
    cleanupOnce();
  }, o.noAudioTimeoutMs);

  let stopping: Promise<void> | null = null;

  return {
    format: { sampleRate: o.sampleRate },
    get paused() {
      return paused;
    },
    onData(cb) {
      dataCbs.add(cb);
      return () => dataCbs.delete(cb);
    },
    onError(cb) {
      errorCbs.add(cb);
      // Late subscribers still learn about an error that already happened.
      if (error) {
        const e = error;
        try {
          cb(e);
        } catch {}
      }
      return () => errorCbs.delete(cb);
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    stop() {
      if (stopping) return stopping;
      expected = true;
      cancelNoAudio?.();
      cancelNoAudio = null;
      if (closed) {
        stopping = Promise.resolve();
        return stopping;
      }
      stopping = new Promise<void>((resolve) => {
        let cancelTimer: (() => void) | null = null;
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          cancelTimer?.();
          resolve();
        };
        closeWaiters.push(finish);
        cancelTimer = o.schedule(() => {
          dropAll = true;
          signal("SIGKILL");
          cleanupOnce();
          finish();
        }, o.stopTimeoutMs);
        if (o.gracefulStop) {
          // The device drains its buffered tail and the stream closes itself;
          // the timer above hard-kills it if that never happens.
          o.gracefulStop();
          return;
        }
        // Local sox flushes and exits cleanly on SIGINT; for ssh, SIGTERM.
        signal(o.remote ? "SIGTERM" : "SIGINT");
        cleanupOnce();
      });
      return stopping;
    },
    kill() {
      expected = true;
      dropAll = true;
      cancelNoAudio?.();
      cancelNoAudio = null;
      signal("SIGKILL");
      cleanupOnce();
    },
  };
}

// ---------------------------------------------------------------- devices

export interface ListDevicesDeps {
  readonly run?: RunFn;
  readonly platform?: NodeJS.Platform;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse `system_profiler SPAudioDataType -json` into input device names. */
export function parseCoreAudioDevices(json: string): string[] {
  const data: unknown = JSON.parse(json);
  if (!isRecord(data)) return [];
  const groups = data.SPAudioDataType;
  if (!Array.isArray(groups)) return [];
  const first: unknown = groups[0];
  if (!isRecord(first) || !Array.isArray(first._items)) return [];
  const names: string[] = [];
  for (const d of first._items as unknown[]) {
    if (!isRecord(d) || d.coreaudio_input_source == null) continue;
    const name = d.coreaudio_device_name ?? d._name;
    if (typeof name === "string" && name) names.push(name);
  }
  return names;
}

/** Parse `pactl -f json list sources`, skipping monitor sources. */
export function parsePactlSources(json: string): string[] {
  const data: unknown = JSON.parse(json);
  if (!Array.isArray(data)) return [];
  const names: string[] = [];
  for (const s of data as unknown[]) {
    if (!isRecord(s) || typeof s.name !== "string") continue;
    if (s.name && !s.name.endsWith(".monitor")) names.push(s.name);
  }
  return names;
}

/** Parse `pactl list sources short`, skipping monitor sources. */
export function parsePactlSourcesShort(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((name): name is string => !!name && !name.endsWith(".monitor"));
}

/** Local input device names usable as MicConfig.device. [] on failure. */
export async function listInputDevices(deps: ListDevicesDeps = {}): Promise<string[]> {
  const run = deps.run ?? defaultRun;
  const platform = deps.platform ?? process.platform;
  try {
    if (platform === "darwin") {
      const r = await run("system_profiler", ["SPAudioDataType", "-json"], 5000);
      return r.code === 0 ? parseCoreAudioDevices(r.stdout) : [];
    }
    const j = await run("pactl", ["-f", "json", "list", "sources"], 5000);
    if (j.code === 0) {
      try {
        return parsePactlSources(j.stdout);
      } catch {}
    }
    const s = await run("pactl", ["list", "sources", "short"], 5000);
    return s.code === 0 ? parsePactlSourcesShort(s.stdout) : [];
  } catch {
    return [];
  }
}
