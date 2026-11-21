// Voice node core (runs on the engine host). Knows every audio device, keeps
// track of which one a human is using right now ("home"), and serves:
//   - one microphone session at a time from the home device,
//   - one shared player that speaks on the home device,
//   - transcription (whisper) and speech synthesis (VieNeu / Piper).
// Network transport lives in server.ts; this file has no sockets.
import type {
  Logger,
  MicConfig,
  MicStream,
  Player,
  PlayerOutput,
  SpeechSegment,
  Synth,
  Transcriber,
} from "../types.ts";
import { errorMessage } from "../types.ts";
import {
  ANDROID_PRESENCE_SCRIPT,
  hasAdbForward,
  parseAndroidSshd,
  LINUX_PRESENCE_SCRIPT,
  MAC_PRESENCE_ARGV,
  inputInterruptCount,
  micConfigFor,
  parseAndroidIdle,
  parseLinuxAudio,
  parseMacIdle,
  playerOutputFor,
  sshArgv,
  type CommandContext,
  type DeviceConfig,
  type Presence,
} from "./devices.ts";

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
export type RunFn = (cmd: string, args: readonly string[], timeoutMs: number) => Promise<RunResult>;

export interface DeviceStatus {
  readonly id: string;
  readonly label: string;
  readonly kind: DeviceConfig["kind"];
  readonly online: boolean;
  /** Seconds since last human input; null when unknown. */
  readonly idleSec: number | null;
  /** Has a working microphone / speaker (false = never chosen as home). */
  readonly mic: boolean;
  readonly speaker: boolean;
}

export interface HubDeps {
  readonly devices: readonly DeviceConfig[];
  readonly ctx: CommandContext;
  readonly run: RunFn;
  readonly openMic: (cfg: MicConfig) => Promise<MicStream>;
  readonly createPlayer: (getOutput: () => PlayerOutput) => Player;
  readonly transcriber: (model: string | null) => Transcriber;
  readonly synth: (name: "vieneu" | "piper") => Synth;
  /** VieNeu voice for the next request (set inside the VieNeu queue). */
  readonly setVieneuVoice?: (voice: string) => void;
  /** Load/save the pinned home across restarts. */
  readonly loadPin?: () => string | null;
  readonly savePin?: (id: string | null) => void;
  readonly now?: () => number;
  readonly logger?: Logger;
}

export interface MicLease {
  readonly mic: MicStream;
  readonly device: DeviceStatus;
}

export class HubError extends Error {
  constructor(
    message: string,
    readonly code: "BUSY" | "NO_DEVICE" | "MIC" | "BAD_REQUEST",
    readonly hint?: string,
  ) {
    super(message);
    this.name = "HubError";
  }
}

export interface Hub {
  /** Poll every device once (also runs on a timer via start()). */
  refresh(): Promise<void>;
  start(intervalMs?: number): void;
  devices(): DeviceStatus[];
  /** The device a human is using right now (pinned wins). */
  home(): DeviceStatus;
  pinned(): string | null;
  pin(id: string | null): void;
  /** Open the home microphone. One session at a time. */
  openMic(owner: string): Promise<MicLease>;
  micOwner(): string | null;
  readonly player: Player;
  /** Device the player last spoke on. */
  playerDevice(): string | null;
  transcribe(
    wav: Buffer,
    opts: {
      language: "auto" | "vi" | "en";
      model: string | null;
      prompt?: string;
      signal?: AbortSignal;
    },
  ): Promise<string>;
  synthesize(
    engine: "vieneu" | "piper",
    seg: SpeechSegment,
    signal?: AbortSignal,
    voice?: string,
  ): Promise<Buffer>;
  warm(what: "stt" | "tts", model?: string | null): void;
  dispose(): Promise<void>;
}

const PRESENCE_TIMEOUT_MS = 4000;
/**
 * A device that keeps failing is probed less often: every failed ssh login
 * counts against the box's sshd (OpenSSH PerSourcePenalties), and probing a
 * misconfigured host every 3 s would lock this machine out of it entirely.
 */
const PROBE_BACKOFF_BASE_MS = 3000;
const PROBE_BACKOFF_MAX_MS = 5 * 60_000;

export function createHub(deps: HubDeps): Hub {
  const now = deps.now ?? (() => Date.now());
  const log = (m: string, level: "debug" | "info" | "warn" = "debug"): void =>
    deps.logger?.log("node", m, level);
  if (deps.devices.length === 0) throw new Error("voice node: no audio devices configured");
  const status = new Map<string, Presence>();
  /** Linux: interrupt counter + when it last changed. */
  const counters = new Map<string, { count: number; changedAt: number }>();
  let pinnedId: string | null = deps.loadPin?.() ?? null;
  let micOwnerName: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let refreshing: Promise<void> | null = null;
  /** Per device: consecutive failed probes and when to probe again. */
  const backoff = new Map<string, { failures: number; nextAt: number }>();
  let playDevice: DeviceConfig = deps.devices[0] as DeviceConfig;

  /** Last state per device + check, so transitions are logged once. */
  const notes = new Map<string, boolean>();
  function note(id: string, what: string, ok: boolean, downMsg: string): void {
    const key = `${id}:${what}`;
    const prev = notes.get(key);
    notes.set(key, ok);
    if (prev === ok) return;
    if (!ok) log(`${id}: ${downMsg}`, "warn");
    else if (prev === false) log(`${id}: ${what} ok again`, "info");
  }

  /**
   * The USB forward to the phone's sshd vanishes when the cable is replugged
   * or the adb server restarts; ssh then gets "connection refused". Restore it.
   */
  async function keepAdbForward(d: DeviceConfig, serial: string[]): Promise<boolean> {
    const port = d.adbForwardPort as number;
    const list = await deps.run("adb", [...serial, "forward", "--list"], PRESENCE_TIMEOUT_MS);
    if (list.code === 0 && hasAdbForward(list.stdout, port)) {
      note(d.id, "adb forward", true, "");
      return true;
    }
    const spec = `tcp:${port}`;
    const r = await deps.run("adb", [...serial, "forward", spec, spec], PRESENCE_TIMEOUT_MS);
    const ok = r.code === 0;
    if (ok) log(`${d.id}: restored adb forward ${spec}`, "info");
    note(
      d.id,
      "adb forward",
      ok,
      `adb forward ${spec} failed: ${r.stderr.trim() || `exit ${r.code}`}`,
    );
    return ok;
  }

  async function probe(d: DeviceConfig): Promise<Presence> {
    try {
      if (d.kind === "local") {
        const r = await deps.run(
          MAC_PRESENCE_ARGV[0] as string,
          MAC_PRESENCE_ARGV.slice(1),
          PRESENCE_TIMEOUT_MS,
        );
        const idle = r.code === 0 ? parseMacIdle(r.stdout) : null;
        return { online: true, idleSec: idle ?? Number.POSITIVE_INFINITY };
      }
      if (d.kind === "termux") {
        // Presence through adb (USB): screen, focus, and whether sshd runs.
        const serial = d.adb && d.adb !== "auto" ? ["-s", d.adb] : [];
        const r = await deps.run(
          "adb",
          [...serial, "shell", ANDROID_PRESENCE_SCRIPT],
          PRESENCE_TIMEOUT_MS,
        );
        const idle = r.code === 0 ? parseAndroidIdle(r.stdout) : null;
        if (idle === null) return { online: false };
        let ok = parseAndroidSshd(r.stdout) !== false;
        note(d.id, "sshd", ok, "Termux sshd not running — skipping the phone until it runs");
        if (ok && d.adbForwardPort !== undefined) ok = await keepAdbForward(d, serial);
        return { online: true, idleSec: idle, caps: { mic: ok, speaker: ok } };
      }
      const [cmd, ...args] = sshArgv(deps.ctx, d.ssh ?? d.id, LINUX_PRESENCE_SCRIPT);
      const r = await deps.run(cmd as string, args, PRESENCE_TIMEOUT_MS);
      if (r.code !== 0) {
        const why = r.stderr.trim().split("\n").pop() ?? "";
        log(`presence ${d.id}: ssh exit ${r.code}${why ? `: ${why}` : ""}`);
        return { online: false };
      }
      const caps = parseLinuxAudio(r.stdout);
      const count = inputInterruptCount(r.stdout);
      const t = now();
      const prev = counters.get(d.id);
      if (count === null) return { online: true, idleSec: Number.POSITIVE_INFINITY, caps };
      if (!prev) {
        // First sample: no change seen yet.
        counters.set(d.id, { count, changedAt: Number.NEGATIVE_INFINITY });
      } else if (count !== prev.count) {
        counters.set(d.id, { count, changedAt: t });
      }
      const changedAt = counters.get(d.id)?.changedAt ?? Number.NEGATIVE_INFINITY;
      return {
        online: true,
        idleSec: Number.isFinite(changedAt) ? (t - changedAt) / 1000 : Number.POSITIVE_INFINITY,
        caps,
      };
    } catch (err) {
      log(`presence ${d.id} failed: ${errorMessage(err)}`, "warn");
      return { online: false };
    }
  }

  function statusOf(d: DeviceConfig): DeviceStatus {
    const p = status.get(d.id);
    // Unknown yet: assume the local machine is online (it is where the node runs).
    const online = p ? p.online : d.kind === "local";
    const idle =
      p && p.online && Number.isFinite(p.idleSec) ? Math.round(p.idleSec * 10) / 10 : null;
    const caps = p && p.online ? p.caps : undefined;
    return {
      id: d.id,
      label: d.label,
      kind: d.kind,
      online,
      idleSec: idle,
      mic: caps ? caps.mic : true,
      speaker: caps ? caps.speaker : true,
    };
  }

  /** Online and able to both listen and speak. */
  function usable(d: DeviceConfig): boolean {
    const st = statusOf(d);
    return st.online && st.mic && st.speaker;
  }

  function homeDevice(): DeviceConfig {
    const online = deps.devices.filter(usable);
    if (pinnedId) {
      const p = online.find((d) => d.id === pinnedId);
      if (p) return p;
    }
    let best: DeviceConfig | null = null;
    let bestIdle = Number.POSITIVE_INFINITY;
    for (const d of online) {
      const p = status.get(d.id);
      const idle = p && p.online ? p.idleSec : Number.POSITIVE_INFINITY;
      if (idle < bestIdle) {
        best = d;
        bestIdle = idle;
      }
    }
    return (
      best ??
      online.find((d) => d.kind === "local") ??
      online[0] ??
      (deps.devices[0] as DeviceConfig)
    );
  }

  const player = deps.createPlayer(() => playerOutputFor(playDevice, deps.ctx));
  // Pick the speaker when a clip starts (not mid-clip).
  const rawPlay = player.play.bind(player);
  player.play = (wav: Buffer) => {
    const d = homeDevice();
    if (d.id !== playDevice.id) log(`speaker → ${d.id}`, "info");
    playDevice = d;
    return rawPlay(wav);
  };

  let vieneuQueue: Promise<unknown> = Promise.resolve();

  const hub: Hub = {
    async refresh() {
      if (refreshing) return refreshing;
      refreshing = (async () => {
        const t = now();
        const due = deps.devices.filter((d) => (backoff.get(d.id)?.nextAt ?? 0) <= t);
        const results = await Promise.all(due.map(async (d) => [d, await probe(d)] as const));
        for (const [d, p] of results) {
          status.set(d.id, p);
          const prev = backoff.get(d.id);
          if (p.online || d.kind === "local") {
            if (prev) log(`${d.id}: online again`, "info");
            backoff.delete(d.id);
            continue;
          }
          const failures = (prev?.failures ?? 0) + 1;
          const wait = Math.min(PROBE_BACKOFF_MAX_MS, PROBE_BACKOFF_BASE_MS * 2 ** (failures - 1));
          backoff.set(d.id, { failures, nextAt: now() + wait });
          if (failures === 1 || wait === PROBE_BACKOFF_MAX_MS)
            log(
              `${d.id}: offline (probe failed ${failures}x), next probe in ${Math.round(wait / 1000)}s`,
              failures === 1 ? "info" : "debug",
            );
        }
      })().finally(() => {
        refreshing = null;
      });
      return refreshing;
    },
    start(intervalMs = 3000) {
      if (timer) return;
      void hub.refresh();
      timer = setInterval(() => void hub.refresh(), intervalMs);
      timer.unref?.();
    },
    devices: () => deps.devices.map(statusOf),
    home: () => statusOf(homeDevice()),
    pinned: () => pinnedId,
    pin(id) {
      const dev = id === null ? null : deps.devices.find((d) => d.id === id);
      if (id !== null && !dev) throw new HubError(`Unknown device "${id}"`, "BAD_REQUEST");
      if (dev && !usable(dev)) {
        const st = statusOf(dev);
        throw new HubError(
          st.online
            ? `${dev.label} has no working microphone or speaker`
            : `${dev.label} is offline`,
          "NO_DEVICE",
        );
      }
      pinnedId = id;
      deps.savePin?.(id);
      log(`home pinned → ${id ?? "auto"}`, "info");
    },
    async openMic(owner) {
      if (micOwnerName) {
        throw new HubError(
          `Microphone is in use by ${micOwnerName}`,
          "BUSY",
          "Finish or cancel that dictation first",
        );
      }
      micOwnerName = owner;
      const d = homeDevice();
      try {
        const mic = await deps.openMic(micConfigFor(d, deps.ctx));
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          if (micOwnerName === owner) micOwnerName = null;
        };
        mic.onError(() => release());
        const lease: MicStream = {
          format: mic.format,
          get paused() {
            return mic.paused;
          },
          onData: (cb) => mic.onData(cb),
          onError: (cb) => mic.onError(cb),
          pause: () => mic.pause(),
          resume: () => mic.resume(),
          // Release the lock whenever the session ends, however it ends.
          stop: () => mic.stop().finally(release),
          kill: () => {
            mic.kill();
            release();
          },
        };
        log(`mic open device=${d.id} owner=${owner}`, "info");
        return { mic: lease, device: statusOf(d) };
      } catch (err) {
        if (micOwnerName === owner) micOwnerName = null;
        const e = err as { message?: string; hint?: string };
        throw new HubError(e.message ?? errorMessage(err), "MIC", e.hint);
      }
    },
    micOwner: () => micOwnerName,
    player,
    playerDevice: () => playDevice.id,
    transcribe(wav, opts) {
      return deps.transcriber(opts.model).transcribe(wav, {
        language: opts.language,
        ...(opts.prompt ? { prompt: opts.prompt } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    },
    synthesize(engine, seg, signal, voice) {
      const s = deps.synth(engine);
      if (engine === "piper") return s.synthesize(seg, signal);
      // VieNeu serves one stream at a time: queue requests from all clients,
      // each with its own voice.
      const run = (): Promise<Buffer> => {
        if (voice) deps.setVieneuVoice?.(voice);
        return s.synthesize(seg, signal);
      };
      const job = vieneuQueue.then(run, run);
      vieneuQueue = job.catch(() => {});
      return job;
    },
    warm(what, model) {
      if (what === "stt")
        void deps
          .transcriber(model ?? null)
          .warm()
          .catch(() => {});
      else deps.synth("vieneu").warm();
    },
    async dispose() {
      if (timer) clearInterval(timer);
      timer = null;
      player.dispose();
    },
  };
  return hub;
}
