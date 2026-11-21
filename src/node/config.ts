// Voice node configuration: ~/.config/opencode-voice/node.json
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DeviceConfig, DeviceKind } from "./devices.ts";

export interface NodeConfig {
  readonly port: number;
  readonly sampleRate: number;
  readonly sshConfig: string;
  readonly devices: readonly DeviceConfig[];
  readonly whisperModel: string | null;
  readonly vieneuPython: string;
  readonly vieneuVoice: string;
}

export function configDir(env: Record<string, string | undefined> = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode-voice");
}

export function stateDir(env: Record<string, string | undefined> = process.env): string {
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "opencode-voice");
}

const expand = (p: string): string => p.replace(/^~(?=\/|$)/, os.homedir());

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function parseNodeConfig(raw: unknown, dir = configDir()): NodeConfig {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const devices: DeviceConfig[] = [];
  const seen = new Set<string>();
  if (Array.isArray(o.devices)) {
    for (const d of o.devices) {
      if (!d || typeof d !== "object") continue;
      const r = d as Record<string, unknown>;
      const id = str(r.id);
      const kind = r.kind;
      if (!id || seen.has(id) || (kind !== "local" && kind !== "linux" && kind !== "termux"))
        continue;
      seen.add(id);
      const port = Number(r.adbForwardPort);
      devices.push({
        id,
        label: str(r.label) ?? id,
        kind: kind as DeviceKind,
        ...(str(r.ssh) ? { ssh: str(r.ssh) as string } : {}),
        ...(str(r.adb) ? { adb: str(r.adb) as string } : {}),
        ...(Number.isInteger(port) && port > 0 ? { adbForwardPort: port } : {}),
      });
    }
  }
  if (!devices.some((d) => d.kind === "local")) {
    devices.unshift({
      id: "local",
      label: os.hostname().split(".")[0] || "this machine",
      kind: "local",
    });
  }
  const port = Number(o.port);
  const rate = Number(o.sampleRate);
  return {
    port: Number.isInteger(port) && port > 1024 ? port : 47800,
    sampleRate: Number.isInteger(rate) && rate >= 8000 && rate <= 48000 ? rate : 16000,
    sshConfig: expand(str(o.sshConfig) ?? path.join(dir, "ssh_config")),
    devices,
    whisperModel: str(o.whisperModel) ? expand(str(o.whisperModel) as string) : null,
    vieneuPython: expand(
      str(o.vieneuPython) ??
        path.join(os.homedir(), ".local/share/opencode-voice/vieneu-venv/bin/python"),
    ),
    vieneuVoice: str(o.vieneuVoice) ?? "Mai Anh",
  };
}

export function loadNodeConfig(dir = configDir()): NodeConfig {
  let raw: unknown = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, "node.json"), "utf8"));
  } catch {
    // missing or invalid: defaults (this machine only)
  }
  return parseNodeConfig(raw, dir);
}
