// Client side of the voice node: MicStream / Player / Transcriber / Synth
// implementations that talk to a node over HTTP + WebSocket, plus discovery
// (local or on the tailnet) and starting the node daemon on the engine host.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wavDurationSec } from "../audio/wav.ts";
import type {
  Logger,
  MicError,
  MicStream,
  PlayEnd,
  Player,
  PlayerStatus,
  SpeechLang,
  SpeechSegment,
  Synth,
  Transcriber,
  TranscribeOptions,
} from "../types.ts";
import { SynthError, clampRate, errorMessage } from "../types.ts";
import { stateDir } from "./config.ts";
import type { DeviceStatus } from "./hub.ts";
export type { DeviceStatus };

export const DEFAULT_NODE_PORT = 47800;

export interface NodeInfo {
  readonly protocol: number;
  readonly host: string;
  readonly devices: DeviceStatus[];
  readonly home: DeviceStatus;
  readonly pinned: string | null;
  readonly micOwner: string | null;
  readonly models: string[];
  readonly defaultModel: string | null;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface ClientDeps {
  readonly fetch?: FetchFn;
  readonly WebSocket?: typeof WebSocket;
  readonly now?: () => number;
  readonly logger?: Logger;
  /** Name shown to other clients ("duy:opencode"). */
  readonly clientName?: string;
}

function wsUrl(base: string, p: string, client: string): string {
  const u = new URL(p, base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("client", client);
  return u.toString();
}

export async function fetchInfo(
  base: string,
  deps: ClientDeps = {},
  timeoutMs = 1500,
): Promise<NodeInfo | null> {
  try {
    const r = await (deps.fetch ?? fetch)(new URL("/v1/info", base).toString(), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const info = (await r.json()) as NodeInfo;
    return info.protocol === 1 ? info : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ mic

class RemoteMicError extends Error implements MicError {
  constructor(
    readonly code: MicError["code"],
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

function toMicCode(code: unknown): MicError["code"] {
  return code === "CONNECTION" ||
    code === "EXITED" ||
    code === "NO_AUDIO" ||
    code === "SPAWN_FAILED"
    ? code
    : "CONNECTION";
}

/** Open the node's home microphone. Resolves once the device streams. */
export function openRemoteMic(
  base: string,
  deps: ClientDeps = {},
): Promise<MicStream & { device: string }> {
  const WS = deps.WebSocket ?? WebSocket;
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WS(wsUrl(base, "/v1/mic", deps.clientName ?? "opencode"));
    } catch (err) {
      reject(
        new RemoteMicError(
          "CONNECTION",
          `Voice node unreachable: ${errorMessage(err)}`,
          "Check that the node runs on the engine host",
        ),
      );
      return;
    }
    ws.binaryType = "arraybuffer";
    const dataCbs = new Set<(c: Buffer) => void>();
    const errCbs = new Set<(e: MicError) => void>();
    let opened = false;
    let paused = false;
    let error: MicError | null = null;
    let endWaiters: Array<() => void> = [];
    let closed = false;
    let stopping = false;
    let rate = 16000;
    let device = "";

    const emitError = (e: MicError): void => {
      if (error) return;
      error = e;
      for (const cb of errCbs) {
        try {
          cb(e);
        } catch {}
      }
    };
    const finishWaiters = (): void => {
      for (const w of endWaiters.splice(0)) w();
    };

    const stream = {
      get format() {
        return { sampleRate: rate };
      },
      get device() {
        return device;
      },
      get paused() {
        return paused;
      },
      onData(cb: (c: Buffer) => void) {
        dataCbs.add(cb);
        return () => dataCbs.delete(cb);
      },
      onError(cb: (e: MicError) => void) {
        errCbs.add(cb);
        if (error) cb(error);
        return () => errCbs.delete(cb);
      },
      pause() {
        paused = true;
        if (ws.readyState === 1) ws.send('{"op":"pause"}');
      },
      resume() {
        paused = false;
        if (ws.readyState === 1) ws.send('{"op":"resume"}');
      },
      stop() {
        if (closed) return Promise.resolve();
        stopping = true;
        return new Promise<void>((res) => {
          endWaiters.push(res);
          const t = setTimeout(() => {
            try {
              ws.close();
            } catch {}
            finishWaiters();
          }, 9000);
          t.unref?.();
          endWaiters.push(() => clearTimeout(t));
          if (ws.readyState === 1) ws.send('{"op":"stop"}');
        });
      },
      kill() {
        closed = true;
        try {
          ws.close();
        } catch {}
        finishWaiters();
      },
    };

    ws.onmessage = (ev: MessageEvent) => {
      const d = ev.data as unknown;
      if (typeof d === "string") {
        let m: {
          t?: string;
          code?: unknown;
          message?: string;
          hint?: string;
          rate?: number;
          device?: { label?: string };
        };
        try {
          m = JSON.parse(d) as typeof m;
        } catch {
          return;
        }
        if (m.t === "open") {
          opened = true;
          rate = typeof m.rate === "number" ? m.rate : rate;
          device = m.device?.label ?? "";
          deps.logger?.log("node-client", `mic open on ${device}`);
          resolve(stream);
        } else if (m.t === "error") {
          const e = new RemoteMicError(
            toMicCode(m.code === "BUSY" ? "CONNECTION" : m.code),
            m.message ?? "Microphone failed",
            m.hint,
          );
          if (!opened) reject(e);
          else emitError(e);
        } else if (m.t === "end") {
          finishWaiters();
        }
        return;
      }
      if (paused || closed) return;
      const buf = Buffer.from(d instanceof ArrayBuffer ? new Uint8Array(d) : (d as Uint8Array));
      for (const cb of dataCbs) {
        try {
          cb(buf);
        } catch {}
      }
    };
    ws.onerror = () => {
      if (!opened)
        reject(
          new RemoteMicError(
            "CONNECTION",
            "Voice node unreachable",
            "Check that the node runs on the engine host and Tailscale is up",
          ),
        );
    };
    ws.onclose = () => {
      const wasClosed = closed;
      closed = true;
      finishWaiters();
      if (opened && !wasClosed && !stopping && !error) {
        // Dropped without a stop: the node or the network went away.
        emitError(
          new RemoteMicError(
            "CONNECTION",
            "Lost the connection to the voice node",
            "Check Tailscale on both machines",
          ),
        );
      }
      if (!opened)
        reject(
          new RemoteMicError(
            "CONNECTION",
            "Voice node closed the microphone",
            "Check the node log on the engine host",
          ),
        );
    };
  });
}

// ------------------------------------------------------------------ player

interface Pending {
  resolve: (e: PlayEnd) => void;
  reject: (e: Error) => void;
}

/** The node's shared speaker, mirrored locally so reads stay synchronous. */
export function createRemotePlayer(base: string, deps: ClientDeps = {}): Player {
  const WS = deps.WebSocket ?? WebSocket;
  const now = deps.now ?? (() => Date.now());
  let ws: WebSocket | null = null;
  let queue: Array<string | Uint8Array> = [];
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let st: { status: PlayerStatus; pos: number; dur: number; rate: number; at: number } = {
    status: "idle",
    pos: 0,
    dur: 0,
    rate: 1,
    at: now(),
  };
  let disposed = false;

  function settleAll(e: PlayEnd): void {
    for (const p of pending.values()) p.resolve(e);
    pending.clear();
  }

  function connect(): WebSocket {
    if (ws && ws.readyState <= 1) return ws;
    const sock = new WS(wsUrl(base, "/v1/player", deps.clientName ?? "opencode"));
    sock.binaryType = "arraybuffer";
    sock.onopen = () => {
      const q = queue;
      queue = [];
      for (const m of q) sock.send(m);
    };
    sock.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      let m: {
        t?: string;
        id?: number;
        result?: string;
        message?: string;
        status?: PlayerStatus;
        pos?: number;
        dur?: number;
        rate?: number;
        state?: Record<string, unknown>;
      };
      try {
        m = JSON.parse(ev.data) as typeof m;
      } catch {
        return;
      }
      const s = (m.t === "ack" ? m.state : m) as typeof m | undefined;
      if (s && (m.t === "state" || m.t === "ack") && s.status) {
        st = {
          status: s.status,
          pos: s.pos ?? 0,
          dur: s.dur ?? st.dur,
          rate: s.rate ?? st.rate,
          at: now(),
        };
      }
      if (m.t === "end" && typeof m.id === "number") {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (!p) return;
        if (m.result === "error")
          p.reject(new Error(m.message ?? "Playback failed on the voice node"));
        else p.resolve(m.result === "ended" ? "ended" : "stopped");
      }
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      st = { ...st, status: "idle", at: now() };
      settleAll("stopped");
    };
    ws = sock;
    return sock;
  }

  function send(m: string | Uint8Array): void {
    const sock = connect();
    if (sock.readyState === 1) sock.send(m);
    else queue.push(m);
  }

  function position(): number {
    if (st.status !== "playing") return Math.min(st.pos, st.dur || st.pos);
    return Math.min(st.dur, st.pos + ((now() - st.at) / 1000) * st.rate);
  }

  return {
    play(wav) {
      if (disposed) return Promise.resolve("stopped");
      const dur = wavDurationSec(wav);
      if (dur === null) return Promise.reject(new Error("Cannot play: audio is not a valid WAV"));
      const id = nextId++;
      st = { ...st, status: "playing", pos: 0, dur, at: now() };
      const p = new Promise<PlayEnd>((resolve, reject) => pending.set(id, { resolve, reject }));
      send(JSON.stringify({ op: "play", id }));
      send(new Uint8Array(wav));
      return p;
    },
    pause() {
      if (st.status !== "playing") return false;
      st = { ...st, status: "paused", pos: position(), at: now() };
      send('{"op":"pause"}');
      return true;
    },
    resume() {
      if (st.status !== "paused") return false;
      st = { ...st, status: "playing", at: now() };
      send('{"op":"resume"}');
      return true;
    },
    stop() {
      st = { ...st, status: "idle", at: now() };
      send('{"op":"stop"}');
    },
    status: () => st.status,
    positionSec: position,
    durationSec: () => st.dur,
    seek(sec) {
      if (st.status === "idle") return false;
      st = { ...st, pos: Math.max(0, Math.min(sec, st.dur)), at: now() };
      // JSON has no Infinity (it becomes null): "past the end" must stay a number.
      send(
        JSON.stringify({ op: "seek", sec: Number.isFinite(sec) ? sec : Number.MAX_SAFE_INTEGER }),
      );
      return true;
    },
    setRate(rate) {
      const r = clampRate(rate);
      st = { ...st, pos: position(), rate: r, at: now() };
      send(JSON.stringify({ op: "rate", rate: r }));
    },
    rate: () => st.rate,
    dispose() {
      disposed = true;
      settleAll("stopped");
      try {
        ws?.close();
      } catch {}
      ws = null;
    },
  };
}

// ------------------------------------------------------------ engines

export function createRemoteTranscriber(
  base: string,
  model: () => string | null,
  deps: ClientDeps = {},
): Transcriber {
  const f = deps.fetch ?? fetch;
  return {
    async transcribe(wav: Buffer, opts: TranscribeOptions) {
      const u = new URL("/v1/transcribe", base);
      u.searchParams.set("lang", opts.language);
      const m = model();
      if (m) u.searchParams.set("model", m);
      if (opts.prompt) u.searchParams.set("prompt", opts.prompt);
      const r = await f(u.toString(), {
        method: "POST",
        body: new Uint8Array(wav),
        headers: { "content-type": "audio/wav" },
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      const body = (await r.json().catch(() => ({}))) as { text?: unknown; message?: unknown };
      if (!r.ok)
        throw new Error(
          typeof body.message === "string"
            ? body.message
            : `Voice node transcription failed (HTTP ${r.status})`,
        );
      return typeof body.text === "string" ? body.text : "";
    },
    async warm() {
      const u = new URL("/v1/warm", base);
      u.searchParams.set("what", "stt");
      const m = model();
      if (m) u.searchParams.set("model", m);
      await f(u.toString(), { method: "POST", signal: AbortSignal.timeout(3000) }).catch(() => {});
    },
    describe: () => `whisper on ${new URL(base).hostname}`,
    async dispose() {},
  };
}

export function createRemoteSynth(
  base: string,
  name: "vieneu" | "piper",
  voice: () => string,
  deps: ClientDeps = {},
): Synth {
  const f = deps.fetch ?? fetch;
  return {
    name,
    async synthesize(seg: SpeechSegment, signal?: AbortSignal) {
      let r: Response;
      try {
        r = await f(new URL("/v1/synth", base).toString(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ engine: name, lang: seg.lang, text: seg.text, voice: voice() }),
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        if (signal?.aborted) throw new SynthError("aborted", "ABORTED");
        throw new SynthError(`voice node unreachable (${errorMessage(err)})`, "UNAVAILABLE");
      }
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      const body = (await r.json().catch(() => ({}))) as { code?: unknown; message?: unknown };
      const message = typeof body.message === "string" ? body.message : `HTTP ${r.status}`;
      const code =
        body.code === "UNAVAILABLE" || r.status === 503
          ? "UNAVAILABLE"
          : body.code === "ABORTED"
            ? "ABORTED"
            : "FAILED";
      throw new SynthError(message, code);
    },
    supports: (_lang: SpeechLang) => true,
    warm() {
      if (name !== "vieneu") return;
      void f(new URL("/v1/warm?what=tts", base).toString(), {
        method: "POST",
        signal: AbortSignal.timeout(3000),
      }).catch(() => {});
    },
    async dispose() {},
  };
}

// ----------------------------------------------------------- discovery

export type NodeMode = "off" | "auto" | "host" | string;

export interface DiscoverDeps extends ClientDeps {
  /** `tailscale status --json` output, or null when unavailable. */
  readonly tailscaleStatus?: () => Promise<string | null>;
  readonly startDaemon?: () => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Online tailnet peers that could run a node (computers, not phones). */
export function tailnetCandidates(statusJson: string): string[] {
  try {
    const s = JSON.parse(statusJson) as {
      Peer?: Record<string, { Online?: boolean; OS?: string; TailscaleIPs?: string[] }>;
    };
    const out: string[] = [];
    for (const p of Object.values(s.Peer ?? {})) {
      if (!p.Online || !/^(macOS|linux|windows)$/i.test(p.OS ?? "")) continue;
      const ip = p.TailscaleIPs?.find((x) => x.includes("."));
      if (ip) out.push(ip);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Find the voice node to use. "off" → none; a URL → that node; "host" →
 * this machine (starting the daemon if needed); "auto" → this machine, else
 * the first node that answers on the tailnet, else none (local engines).
 */
export async function discoverNode(
  mode: NodeMode,
  deps: DiscoverDeps = {},
): Promise<string | null> {
  if (mode === "off") return null;
  if (/^https?:\/\//.test(mode)) return mode.replace(/\/+$/, "");
  const local = `http://127.0.0.1:${DEFAULT_NODE_PORT}`;
  if (await fetchInfo(local, deps, 800)) return local;
  if (mode === "host") {
    deps.startDaemon?.();
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      if (await fetchInfo(local, deps, 800)) return local;
    }
    return null;
  }
  const status = await deps.tailscaleStatus?.();
  if (!status) return null;
  const candidates = tailnetCandidates(status).map((ip) => `http://${ip}:${DEFAULT_NODE_PORT}`);
  const found = await Promise.all(
    candidates.map(async (u) => ((await fetchInfo(u, deps, 1200)) ? u : null)),
  );
  return found.find((u) => u !== null) ?? null;
}

/** Start `bun src/node/main.ts` detached (survives OpenCode exiting). */
export function startNodeDaemon(logger?: Logger): void {
  const main = fileURLToPath(new URL("./main.ts", import.meta.url));
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = fs.openSync(path.join(dir, "node.out"), "a", 0o600);
  const bun = typeof Bun !== "undefined" ? Bun.which("bun") : null;
  // Inside OpenCode (a compiled Bun binary) BUN_BE_BUN=1 turns it into the bun CLI.
  const cmd = bun ?? process.execPath;
  const env = bun ? process.env : { ...process.env, BUN_BE_BUN: "1" };
  const child = spawn(cmd, [main], { detached: true, stdio: ["ignore", out, out], env });
  child.unref();
  fs.closeSync(out);
  logger?.log("node-client", `started voice node pid=${child.pid ?? "?"} via ${cmd}`, "info");
}
