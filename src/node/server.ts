// HTTP + WebSocket front of the voice node (Bun.serve).
//
//   GET  /v1/info                 devices, home, engines, models
//   POST /v1/home      {id|null}  pin the audio device (null = follow me)
//   POST /v1/transcribe?lang&model&prompt   body: WAV → {text}
//   POST /v1/synth     {engine,lang,text,voice} → audio/wav
//   POST /v1/warm?what=stt|tts&model
//   WS   /v1/mic?client=name      home mic as binary PCM frames
//   WS   /v1/player?client=name   shared speaker on the home device
//
// Only loopback and same-owner Tailscale peers are accepted.
import type { Server, ServerWebSocket } from "bun";
import type { Logger, PlayEnd, SpeechLang } from "../types.ts";
import { SynthError, clampRate, errorMessage, isAbortError } from "../types.ts";
import { HubError, type Hub, type MicLease } from "./hub.ts";

export const NODE_PORT = 47800;
export const PROTOCOL = 1;

export interface ServerDeps {
  readonly hub: Hub;
  readonly hostnames: readonly string[];
  readonly port?: number;
  /** Is this peer allowed? (loopback is always allowed) */
  readonly authorize: (ip: string) => Promise<boolean>;
  readonly info: () => Record<string, unknown>;
  readonly logger?: Logger;
}

interface MicData {
  kind: "mic";
  client: string;
  lease: MicLease | null;
  closed: boolean;
}
interface PlayerData {
  kind: "player";
  client: string;
  /** Next binary frame is the WAV for this play id. */
  awaiting: number | null;
}
type WsData = MicData | PlayerData;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/** 100.64.0.0/10 (CGNAT range Tailscale uses) or its fd7a:115c:a1e0::/48 IPv6. */
export function isTailnetIp(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/, "");
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(v4);
  if (m) {
    const b = Number(m[1]);
    return b >= 64 && b <= 127;
  }
  return /^fd7a:115c:a1e0:/i.test(ip);
}

export function startServer(deps: ServerDeps): { stop(): void; port: number } {
  const { hub } = deps;
  const port = deps.port ?? 47800;
  const log = (m: string, level: "debug" | "info" | "warn" = "debug"): void =>
    deps.logger?.log("node", m, level);
  const players = new Set<ServerWebSocket<WsData>>();

  function playerState(): Record<string, unknown> {
    const p = hub.player;
    return {
      t: "state",
      status: p.status(),
      pos: Math.round(p.positionSec() * 1000) / 1000,
      dur: Math.round(p.durationSec() * 1000) / 1000,
      rate: p.rate(),
      device: hub.playerDevice(),
    };
  }
  function broadcastState(): void {
    const msg = JSON.stringify(playerState());
    for (const ws of players) ws.send(msg);
  }

  async function handle(req: Request, server: Server<WsData>): Promise<Response | undefined> {
    const ip = server.requestIP(req)?.address ?? "";
    if (!isLoopback(ip) && !(isTailnetIp(ip) && (await deps.authorize(ip)))) {
      log(`rejected ${ip}`, "warn");
      return json({ error: "forbidden" }, 403);
    }
    const url = new URL(req.url);
    const client = (url.searchParams.get("client") ?? ip).slice(0, 60);
    try {
      switch (url.pathname) {
        case "/v1/info":
          return json({ protocol: PROTOCOL, ...deps.info() });
        case "/v1/home": {
          if (req.method !== "POST") return json({ error: "POST only" }, 405);
          const body = (await req.json()) as { id?: unknown };
          hub.pin(typeof body.id === "string" ? body.id : null);
          return json({ home: hub.home(), pinned: hub.pinned() });
        }
        case "/v1/transcribe": {
          const wav = Buffer.from(await req.arrayBuffer());
          const lang = url.searchParams.get("lang");
          const text = await hub.transcribe(wav, {
            language: lang === "vi" || lang === "en" ? lang : "auto",
            model: url.searchParams.get("model"),
            ...(url.searchParams.get("prompt")
              ? { prompt: url.searchParams.get("prompt") as string }
              : {}),
            signal: req.signal,
          });
          return json({ text });
        }
        case "/v1/synth": {
          const b = (await req.json()) as {
            engine?: unknown;
            lang?: unknown;
            text?: unknown;
            voice?: unknown;
          };
          const engine = b.engine === "piper" ? "piper" : "vieneu";
          const lang: SpeechLang = b.lang === "en" ? "en" : "vi";
          if (typeof b.text !== "string" || !b.text.trim())
            return json({ code: "FAILED", message: "empty text" }, 400);
          const wav = await hub.synthesize(
            engine,
            { lang, text: b.text },
            req.signal,
            typeof b.voice === "string" ? b.voice : undefined,
          );
          return new Response(new Uint8Array(wav), { headers: { "content-type": "audio/wav" } });
        }
        case "/v1/warm":
          hub.warm(
            url.searchParams.get("what") === "tts" ? "tts" : "stt",
            url.searchParams.get("model"),
          );
          return json({ ok: true });
        case "/v1/mic":
          if (server.upgrade(req, { data: { kind: "mic", client, lease: null, closed: false } }))
            return undefined;
          return json({ error: "websocket expected" }, 400);
        case "/v1/player":
          if (server.upgrade(req, { data: { kind: "player", client, awaiting: null } }))
            return undefined;
          return json({ error: "websocket expected" }, 400);
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (err) {
      if (err instanceof SynthError) {
        return json(
          { code: err.code, message: err.message },
          err.code === "UNAVAILABLE" ? 503 : 500,
        );
      }
      if (err instanceof HubError) {
        return json({ code: err.code, message: err.message, hint: err.hint }, 409);
      }
      if (isAbortError(err)) return json({ code: "ABORTED", message: "aborted" }, 499);
      log(`request ${url.pathname} failed: ${errorMessage(err)}`, "warn");
      return json({ code: "FAILED", message: errorMessage(err) }, 500);
    }
  }

  async function openMic(ws: ServerWebSocket<MicData>): Promise<void> {
    try {
      const lease = await hub.openMic(ws.data.client);
      if (ws.data.closed) {
        lease.mic.kill();
        return;
      }
      ws.data.lease = lease;
      ws.send(
        JSON.stringify({ t: "open", device: lease.device, rate: lease.mic.format.sampleRate }),
      );
      lease.mic.onData((chunk) => {
        if (!ws.data.closed) ws.send(chunk);
      });
      lease.mic.onError((e) => {
        if (ws.data.closed) return;
        ws.send(JSON.stringify({ t: "error", code: e.code, message: e.message, hint: e.hint }));
      });
    } catch (err) {
      const e = err instanceof HubError ? err : new HubError(errorMessage(err), "MIC");
      ws.send(JSON.stringify({ t: "error", code: e.code, message: e.message, hint: e.hint }));
      ws.close(1011, "mic failed");
    }
  }

  function onPlayerMessage(ws: ServerWebSocket<PlayerData>, msg: string | Buffer): void {
    if (typeof msg !== "string") {
      const id = ws.data.awaiting;
      ws.data.awaiting = null;
      if (id === null) return;
      const wav = Buffer.from(msg);
      hub.player.play(wav).then(
        (end: PlayEnd) => {
          ws.send(JSON.stringify({ t: "end", id, result: end }));
          broadcastState();
        },
        (err: unknown) => {
          ws.send(JSON.stringify({ t: "end", id, result: "error", message: errorMessage(err) }));
          broadcastState();
        },
      );
      broadcastState();
      return;
    }
    let op: { op?: unknown; id?: unknown; sec?: unknown; rate?: unknown };
    try {
      op = JSON.parse(msg) as typeof op;
    } catch {
      return;
    }
    const p = hub.player;
    let ok = true;
    switch (op.op) {
      case "play":
        ws.data.awaiting = typeof op.id === "number" ? op.id : null;
        return;
      case "pause":
        ok = p.pause();
        break;
      case "resume":
        ok = p.resume();
        break;
      case "stop":
        p.stop();
        break;
      case "seek":
        ok = typeof op.sec === "number" ? p.seek(op.sec) : false;
        break;
      case "rate":
        if (typeof op.rate === "number") p.setRate(clampRate(op.rate));
        break;
      case "state":
        break;
      default:
        return;
    }
    ws.send(JSON.stringify({ t: "ack", op: op.op, ok, state: playerState() }));
    broadcastState();
  }

  const handlers = {
    fetch: handle,
    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        if (ws.data.kind === "mic") void openMic(ws as ServerWebSocket<MicData>);
        else {
          players.add(ws);
          ws.send(JSON.stringify(playerState()));
        }
      },
      message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
        if (ws.data.kind === "player") {
          onPlayerMessage(ws as ServerWebSocket<PlayerData>, msg);
          return;
        }
        const data = ws.data;
        if (typeof msg !== "string" || !data.lease) return;
        const lease = data.lease;
        if (msg === '{"op":"pause"}') lease.mic.pause();
        else if (msg === '{"op":"resume"}') lease.mic.resume();
        else if (msg === '{"op":"stop"}') {
          void lease.mic.stop().then(() => {
            if (!data.closed) {
              ws.send(JSON.stringify({ t: "end" }));
              ws.close(1000, "stopped");
            }
          });
        }
      },
      close(ws: ServerWebSocket<WsData>) {
        if (ws.data.kind === "player") {
          players.delete(ws);
          return;
        }
        ws.data.closed = true;
        ws.data.lease?.mic.kill();
      },
    },
  };

  const servers = deps.hostnames.map((hostname) =>
    Bun.serve<WsData>({ hostname, port, ...handlers, idleTimeout: 120 }),
  );
  log(`listening on ${deps.hostnames.map((h) => `${h}:${port}`).join(", ")}`, "info");
  return {
    port,
    stop() {
      for (const s of servers) s.stop(true);
    },
  };
}
