// WAV playback on local speakers (sox) or a remote command (ssh to a phone).
//
// One owned process at a time. Every action that replaces or kills the
// process bumps `gen`; a process's close event only counts when its token
// still equals `gen`, so a killed/stale process can never end the current
// utterance. Position is clock-based (elapsed wall time x speed).

import { clampRate } from "../types.ts";
import type { Logger, PlayEnd, Player, PlayerOutput, PlayerStatus } from "../types.ts";
import { defaultSpawn } from "./mic.ts";
import type { ChildProc, SpawnFn } from "./mic.ts";
import { defaultRun, parseSshArgv } from "./usb.ts";
import type { RunFn } from "./usb.ts";
import { wavDurationSec } from "./wav.ts";

export interface PlayerDeps {
  readonly spawn?: SpawnFn;
  readonly now?: () => number;
  readonly run?: RunFn;
  /**
   * Silence the remote player (audio already streamed to the phone keeps
   * playing after the local ssh dies). Must not reject. Default: ssh to the
   * same host and kill the phone-side player.
   */
  readonly remoteKill?: (command: readonly string[]) => Promise<void>;
  /** Remote PCM rate when the command's last arg is not a rate. Default 16000. */
  readonly remoteSampleRate?: number;
  readonly logger?: Logger;
}

const REMOTE_KILL_SCRIPT =
  "killall play 2>/dev/null; killall mpv 2>/dev/null; pkill -f '[p]layback.sh' 2>/dev/null; true";

/** argv that kills the phone-side player via the same ssh target, or null if not ssh. */
export function remoteKillArgv(command: readonly string[]): string[] | null {
  const t = parseSshArgv(command);
  const bin = command[0];
  if (!t || bin === undefined) return null;
  return [
    bin,
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=3",
    ...command.slice(1, t.destIndex + 1),
    REMOTE_KILL_SCRIPT,
  ];
}

/** Rate the remote expects: the command's last arg (e.g. playback.sh 16000) when numeric. */
export function remoteRate(command: readonly string[], fallback: number): number {
  const n = Number(command[command.length - 1]);
  return Number.isInteger(n) && n >= 8000 && n <= 192000 ? n : fallback;
}

export function localPlayArgs(offsetSec: number, speed = 1): string[] {
  // Small buffer so SIGSTOP lands close to the audible position.
  const argv = ["-q", "--buffer", "1024", "-t", "wav", "-", "-d"];
  if (offsetSec > 0) argv.push("trim", offsetSec.toFixed(3));
  // tempo -s: speech-tuned time stretch that keeps the voice's pitch.
  if (speed !== 1) argv.push("tempo", "-s", String(speed));
  return argv;
}

export function ffmpegArgs(offsetSec: number, rate: number, speed = 1): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    ...(offsetSec > 0 ? ["-ss", offsetSec.toFixed(3)] : []),
    "-i",
    "pipe:0",
    ...(speed !== 1 ? ["-af", `atempo=${speed}`] : []),
    "-f",
    "s16le",
    "-acodec",
    "pcm_s16le",
    "-ar",
    String(rate),
    "-ac",
    "1",
    "pipe:1",
  ];
}

interface Owned {
  readonly kind: "local" | "remote";
  readonly child: ChildProc;
  ff: ChildProc | null;
}

interface Pending {
  readonly resolve: (end: PlayEnd) => void;
  readonly reject: (err: Error) => void;
}

function lastLine(s: string): string {
  return s.trim().split("\n").pop()?.trim() ?? "";
}

function errnoCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const c = (err as { code: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

function hardKill(p: ChildProc | null): void {
  if (!p) return;
  try {
    p.kill("SIGKILL");
  } catch {}
}

export function createPlayer(getOutput: () => PlayerOutput, deps: PlayerDeps = {}): Player {
  const spawn = deps.spawn ?? defaultSpawn;
  const now = deps.now ?? (() => Date.now());
  const run = deps.run ?? defaultRun;
  const log = (msg: string, level: "debug" | "warn" = "debug"): void =>
    deps.logger?.log("player", msg, level);
  const remoteKill =
    deps.remoteKill ??
    (async (command: readonly string[]): Promise<void> => {
      const argv = remoteKillArgv(command);
      const bin = argv?.[0];
      if (!argv || bin === undefined) return;
      const r = await run(bin, argv.slice(1), 4000);
      if (r.code !== 0) log(`remote kill exit=${r.code}`, "warn");
    });

  let wav: Buffer | null = null;
  let totalSec = 0;
  let status: PlayerStatus = "idle";
  let baseSec = 0;
  let anchorMs = 0;
  let speed = 1;
  let gen = 0;
  let proc: Owned | null = null;
  let pending: Pending | null = null;
  let disposed = false;
  /** Remote audio may still be sounding on the phone (needs a remote kill). */
  let remoteLive: readonly string[] | null = null;
  /** In-flight remote kill; any respawn waits for it. Never rejects. */
  let killing: Promise<void> | null = null;

  function positionSec(): number {
    if (status === "playing" && proc) {
      return Math.min(totalSec, baseSec + (Math.max(0, now() - anchorMs) / 1000) * speed);
    }
    return Math.min(totalSec, baseSec);
  }

  function settle(result: PlayEnd | Error): void {
    const p = pending;
    pending = null;
    if (!p) return;
    if (result instanceof Error) p.reject(result);
    else p.resolve(result);
  }

  function killRemote(): void {
    const command = remoteLive;
    remoteLive = null;
    if (!command) return;
    const p = remoteKill(command).catch(() => {});
    const chained = killing ? Promise.all([killing, p]).then(() => {}) : p;
    killing = chained;
    void chained.then(() => {
      if (killing === chained) killing = null;
    });
  }

  function killLocal(): void {
    const owned = proc;
    proc = null;
    if (!owned) return;
    hardKill(owned.ff);
    hardKill(owned.child);
  }

  function stop(): void {
    gen += 1;
    if (status !== "idle") baseSec = positionSec();
    killLocal();
    killRemote();
    status = "idle";
    settle("stopped");
  }

  /** Spawn at offset once any in-flight remote kill finished, if still current. */
  function startAt(offsetSec: number): void {
    gen += 1;
    const token = gen;
    status = "playing";
    baseSec = offsetSec;
    const wait = killing;
    if (!wait) {
      spawnAt(offsetSec, token);
      return;
    }
    void wait.then(() => {
      if (token === gen && status === "playing" && !proc) spawnAt(offsetSec, token);
    });
  }

  function onEnd(token: number, err: Error | null): void {
    if (token !== gen) return; // stale: killed/superseded process
    const owned = proc;
    proc = null;
    if (owned?.kind === "remote") remoteLive = null;
    status = "idle";
    baseSec = totalSec;
    if (err) log(`playback failed: ${err.message}`, "warn");
    settle(err ?? "ended");
  }

  function spawnAt(offsetSec: number, token: number): void {
    const audio = wav;
    if (!audio) return;
    const out = getOutput();
    let stderrTail = "";
    let failed: Error | null = null;
    const binOf = (out.kind === "remote" ? out.command[0] : "sox") ?? "remote command";

    const spawnErr = (bin: string, err: unknown): Error => {
      if (errnoCode(err) === "ENOENT") {
        return new Error(
          bin === "sox"
            ? "sox not found: install it with brew install sox"
            : `${bin} not found: install it or fix the playback command`,
        );
      }
      return new Error(
        `Could not start ${bin}: ${err instanceof Error ? err.message : String(err)}`,
      );
    };

    let child: ChildProc;
    let ff: ChildProc | null = null;
    try {
      if (out.kind === "remote") {
        const [bin, ...rest] = out.command;
        if (bin === undefined) throw new Error("empty remote playback command");
        child = spawn(bin, rest, { stdio: ["pipe", "ignore", "pipe"] });
      } else {
        child = spawn("sox", localPlayArgs(offsetSec, speed), {
          stdio: ["pipe", "ignore", "pipe"],
        });
      }
    } catch (err) {
      queueMicrotask(() => onEnd(token, spawnErr(binOf, err)));
      return;
    }

    anchorMs = now();
    baseSec = offsetSec;
    const owned: Owned = { kind: out.kind, child, ff: null };
    proc = owned;
    if (out.kind === "remote") remoteLive = out.command;
    log(
      `spawn kind=${out.kind} offset=${offsetSec.toFixed(2)} speed=${speed} bytes=${audio.length}`,
    );

    child.stderr?.on("data", (c: Buffer | string) => {
      stderrTail = (stderrTail + c.toString()).slice(-400);
    });
    child.stdin?.on("error", () => {}); // EPIPE when the player dies early
    child.on("error", (err) => {
      failed ??= spawnErr(binOf, err);
    });
    child.on("close", (code, sig) => {
      if (token === gen) hardKill(ff);
      if (!failed && code !== 0 && code !== null) {
        const detail = lastLine(stderrTail);
        failed = new Error(`Playback failed (${binOf} exit ${code})${detail ? `: ${detail}` : ""}`);
      }
      if (!failed && code === null && sig !== null && token === gen) {
        failed = new Error(`Playback interrupted (${sig})`);
      }
      onEnd(token, failed);
    });

    if (out.kind === "local") {
      child.stdin?.end(audio);
      return;
    }

    // Remote: convert to raw s16le at the remote's rate, seeking with -ss.
    const rate = remoteRate(out.command, deps.remoteSampleRate ?? 16000);
    try {
      ff = spawn("ffmpeg", ffmpegArgs(offsetSec, rate, speed), {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      failed = spawnErr("ffmpeg", err);
      hardKill(child);
      return;
    }
    owned.ff = ff;
    const stdin = child.stdin;
    ff.on("error", (err) => {
      failed ??= spawnErr("ffmpeg", err);
      try {
        stdin?.end();
      } catch {}
    });
    ff.stdin?.on("error", () => {});
    ff.stderr?.resume();
    if (ff.stdout && stdin) ff.stdout.pipe(stdin);
    else stdin?.end();
    ff.stdin?.end(audio);
  }

  /**
   * Restart output at `offsetSec` with the current speed, keeping the state:
   * playing respawns now, paused drops the frozen process so resume
   * respawns at the new offset (a SIGSTOPped sox cannot change speed/offset).
   */
  function restartAt(offsetSec: number): void {
    if (status === "playing") {
      killLocal();
      killRemote();
      startAt(offsetSec);
      return;
    }
    gen += 1;
    killLocal();
    killRemote();
    baseSec = offsetSec;
  }

  return {
    seek(sec) {
      if (disposed || !wav || status === "idle") return false;
      if (!(sec < totalSec)) {
        // Past the end: finish this clip so the caller moves on.
        gen += 1;
        killLocal();
        killRemote();
        status = "idle";
        baseSec = totalSec;
        settle("ended");
        return true;
      }
      restartAt(Math.max(0, sec));
      return true;
    },

    setRate(next) {
      const r = clampRate(next);
      if (r === speed) return;
      const at = positionSec();
      speed = r;
      if (!disposed && wav && status !== "idle") restartAt(at);
    },

    rate: () => speed,

    play(input) {
      if (disposed) return Promise.resolve("stopped");
      const dur = wavDurationSec(input);
      if (dur === null) return Promise.reject(new Error("Cannot play: audio is not a valid WAV"));
      // Supersede: previous promise resolves "stopped", phone gets silenced.
      settle("stopped");
      killLocal();
      killRemote();
      wav = input;
      totalSec = dur;
      const promise = new Promise<PlayEnd>((resolve, reject) => {
        pending = { resolve, reject };
      });
      startAt(0);
      return promise;
    },

    pause() {
      if (disposed || status !== "playing") return false;
      baseSec = positionSec();
      status = "paused";
      const owned = proc;
      if (owned?.kind === "local") {
        try {
          owned.child.kill("SIGSTOP");
        } catch {}
        return true;
      }
      // Remote (or still waiting to respawn): SIGSTOP on ssh does not pause
      // the phone, so kill both ends and respawn at the offset on resume.
      gen += 1;
      killLocal();
      killRemote();
      return true;
    },

    resume() {
      if (disposed || status !== "paused") return false;
      const owned = proc;
      if (owned?.kind === "local") {
        status = "playing";
        anchorMs = now();
        try {
          owned.child.kill("SIGCONT");
        } catch {}
        return true;
      }
      startAt(baseSec);
      return true;
    },

    stop,

    status: () => status,
    positionSec,
    durationSec: () => totalSec,

    dispose() {
      if (disposed) return;
      stop();
      disposed = true;
      wav = null;
    },
  };
}
