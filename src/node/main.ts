// Voice node daemon: `bun src/node/main.ts`
// Runs on the engine host (the strongest machine). Started on demand by the
// plugin there; keeps running after OpenCode exits so other machines can use it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMic } from "../audio/mic.ts";
import { createPlayer } from "../audio/player.ts";
import { defaultRun } from "../audio/usb.ts";
import { createFileLogger } from "../log.ts";
import {
  createWhisperTranscriber,
  defaultWhisperModel,
  findWhisperModels,
} from "../stt/whisper.ts";
import { createPiperSynth, defaultPiperVoice } from "../tts/piper.ts";
import { createVieneuSynth } from "../tts/vieneu.ts";
import type { Synth, Transcriber } from "../types.ts";
import { errorMessage } from "../types.ts";
import { configDir, loadNodeConfig, stateDir } from "./config.ts";
import { createHub } from "./hub.ts";
import { PROTOCOL, startServer } from "./server.ts";

const VERSION = "1";

async function tailnet(): Promise<{ ip: string | null; login: string | null }> {
  const r = await defaultRun("tailscale", ["status", "--json"], 5000);
  if (r.code !== 0) return { ip: null, login: null };
  try {
    const s = JSON.parse(r.stdout) as {
      Self?: { TailscaleIPs?: string[]; UserID?: number };
      User?: Record<string, { LoginName?: string }>;
    };
    const ip = s.Self?.TailscaleIPs?.find((x) => x.includes(".")) ?? null;
    const login =
      s.Self?.UserID !== undefined ? (s.User?.[String(s.Self.UserID)]?.LoginName ?? null) : null;
    return { ip, login };
  } catch {
    return { ip: null, login: null };
  }
}

export async function main(): Promise<void> {
  const logger = createFileLogger(path.join(stateDir(), "node.log"));
  const cfg = loadNodeConfig();
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const pinFile = path.join(stateDir(), "node-pin.json");

  const transcribers = new Map<string, Transcriber>();
  const models = (): string[] => findWhisperModels();
  const transcriber = (model: string | null): Transcriber => {
    const available = models();
    const pick =
      (model && available.includes(model) ? model : null) ??
      cfg.whisperModel ??
      defaultWhisperModel();
    if (!pick)
      throw new Error(
        "No whisper model on the voice node — download one to ~/.local/share/whisper-cpp",
      );
    let t = transcribers.get(pick);
    if (!t) {
      t = createWhisperTranscriber({ modelPath: pick, logger });
      transcribers.set(pick, t);
    }
    return t;
  };

  let vieneuVoice = cfg.vieneuVoice;
  const synths = new Map<string, Synth>();
  const synth = (name: "vieneu" | "piper"): Synth => {
    let s = synths.get(name);
    if (!s) {
      s =
        name === "vieneu"
          ? createVieneuSynth({ python: cfg.vieneuPython, voice: () => vieneuVoice, logger })
          : createPiperSynth({ voiceFor: (lang) => defaultPiperVoice(lang), logger });
      synths.set(name, s);
    }
    return s;
  };

  const hub = createHub({
    devices: cfg.devices,
    ctx: { sshConfig: cfg.sshConfig, sampleRate: cfg.sampleRate },
    run: defaultRun,
    openMic: (mc) => openMic(mc, { logger }),
    createPlayer: (getOutput) => createPlayer(getOutput, { logger }),
    transcriber,
    synth,
    setVieneuVoice: (v) => {
      vieneuVoice = v;
    },
    loadPin: () => {
      try {
        const v = (JSON.parse(fs.readFileSync(pinFile, "utf8")) as { id?: unknown }).id;
        return typeof v === "string" ? v : null;
      } catch {
        return null;
      }
    },
    savePin: (id) => fs.writeFileSync(pinFile, JSON.stringify({ id }), { mode: 0o600 }),
    logger,
  });
  hub.start(3000);

  const net = await tailnet();
  const whoisCache = new Map<string, { ok: boolean; at: number }>();
  const authorize = async (ip: string): Promise<boolean> => {
    if (!net.login) return false;
    const hit = whoisCache.get(ip);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.ok;
    const r = await defaultRun("tailscale", ["whois", "--json", ip], 4000);
    let ok = false;
    try {
      const w = JSON.parse(r.stdout) as { UserProfile?: { LoginName?: string } };
      ok = w.UserProfile?.LoginName === net.login;
    } catch {}
    whoisCache.set(ip, { ok, at: Date.now() });
    logger.log("node", `whois ${ip} → ${ok ? "allowed" : "denied"}`, ok ? "debug" : "warn");
    return ok;
  };

  const hostnames = ["127.0.0.1", ...(net.ip ? [net.ip] : [])];
  const server = startServer({
    hub,
    hostnames,
    port: cfg.port,
    authorize,
    logger,
    info: () => ({
      version: VERSION,
      protocol: PROTOCOL,
      host: os.hostname().split(".")[0],
      pid: process.pid,
      devices: hub.devices(),
      home: hub.home(),
      pinned: hub.pinned(),
      micOwner: hub.micOwner(),
      models: models(),
      defaultModel: cfg.whisperModel ?? defaultWhisperModel(),
      engines: { stt: "whisper", tts: ["vieneu", "piper"] },
    }),
  });
  fs.writeFileSync(path.join(stateDir(), "node.pid"), String(process.pid), { mode: 0o600 });
  logger.log(
    "node",
    `started pid=${process.pid} config=${configDir()} devices=${cfg.devices.map((d) => d.id).join(",")}`,
    "info",
  );

  const shutdown = async (): Promise<void> => {
    server.stop();
    await hub.dispose();
    await Promise.all([...transcribers.values()].map((t) => t.dispose().catch(() => {})));
    await Promise.all([...synths.values()].map((s) => s.dispose().catch(() => {})));
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    process.stderr.write(`voice node failed: ${errorMessage(err)}\n`);
    process.exit(1);
  });
}
