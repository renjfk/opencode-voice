// Static plugin options (tui.jsonc / cli.json) and persistent runtime
// settings (host storage). Settings keep the old kv key names so existing
// choices survive the rewrite.
import os from "node:os";
import path from "node:path";
import type { SttLanguage } from "./types.ts";

// ------------------------------------------------------------------ options

export interface Options {
  readonly sttMode: SttMode;
  readonly sttAutoSubmit: boolean;
  readonly sttLanguage: SttLanguage;
  readonly sttModel: string | null;
  /** Remote mic argv (ssh ... capture.sh RATE). */
  readonly sttCaptureCmd: readonly string[] | null;
  readonly sttEndpoint: string | null;
  readonly sttApiModel: string | null;
  readonly sttApiKeyEnv: string | null;
  readonly sttPrompt: string | null;
  readonly audioSampleRate: number;
  readonly ttsEngine: TtsEngine;
  readonly ttsVieneuPython: string;
  readonly ttsVieneuVoice: string;
  /** Remote speaker argv (ssh ... playback.sh RATE). */
  readonly ttsPlayCmd: readonly string[] | null;
  readonly ttsPrompt: string | null;
  readonly keybinds: Readonly<Record<string, string>>;
  /** Raw options, for the LLM resolver (endpoint/model/apiKeyEnv...). */
  readonly raw: Readonly<Record<string, unknown>>;
}

export type SttMode = "batch" | "streaming";
export type TtsEngine = "vieneu" | "piper";
export type NormalizeMode = "off" | "batch" | "all";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function argv(v: unknown): readonly string[] | null {
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) {
    return v as string[];
  }
  if (typeof v === "string" && v.trim()) return ["sh", "-c", v];
  return null;
}

export function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, os.homedir());
}

export function parseOptions(raw: Readonly<Record<string, unknown>> | undefined): Options {
  const o = raw ?? {};
  const rate = Number(o.audioSampleRate);
  const lang = str(o.sttLanguage);
  const keybinds: Record<string, string> = {};
  if (o.keybinds && typeof o.keybinds === "object") {
    for (const [k, v] of Object.entries(o.keybinds as Record<string, unknown>)) {
      if (typeof v === "string") keybinds[k] = v;
    }
  }
  return {
    sttMode: o.sttMode === "batch" ? "batch" : o.sttMode === "streaming" ? "streaming" : "batch",
    sttAutoSubmit: o.sttAutoSubmit === true,
    sttLanguage: lang === "vi" || lang === "en" ? lang : "auto",
    sttModel: str(o.sttModel) ? expandHome(str(o.sttModel) as string) : null,
    sttCaptureCmd: argv(o.sttCaptureCmd),
    sttEndpoint: str(o.sttEndpoint),
    sttApiModel: str(o.sttApiModel) ?? str(o.sttModel),
    sttApiKeyEnv: str(o.sttApiKeyEnv),
    sttPrompt: str(o.sttPrompt),
    audioSampleRate: Number.isFinite(rate) && rate >= 8000 && rate <= 48000 ? rate : 16000,
    ttsEngine: o.ttsEngine === "piper" ? "piper" : "vieneu",
    ttsVieneuPython: expandHome(
      str(o.ttsVieneuPython) ??
        path.join(os.homedir(), ".local/share/opencode-voice/vieneu-venv/bin/python"),
    ),
    ttsVieneuVoice: str(o.ttsVieneuVoice) ?? "",
    ttsPlayCmd: argv(o.ttsPlayCmd),
    ttsPrompt: str(o.ttsManualPrompt) ?? str(o.ttsPrompt),
    keybinds,
    raw: o,
  };
}

// ----------------------------------------------------------------- settings

/** Minimal synchronous key/value view over host storage. */
export interface KvStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export interface Settings {
  sttMode(): SttMode;
  setSttMode(v: SttMode): void;
  autoSubmit(): boolean;
  setAutoSubmit(v: boolean): void;
  autoEnd(): boolean;
  setAutoEnd(v: boolean): void;
  normalize(): NormalizeMode;
  setNormalize(v: NormalizeMode): void;
  language(): SttLanguage;
  setLanguage(v: SttLanguage): void;
  whisperModel(): string | null;
  setWhisperModel(v: string): void;
  sttEngine(): "local" | "api";
  setSttEngine(v: "local" | "api"): void;
  /** "" = default local device, "remote" = phone, else a device name. */
  mic(): string;
  setMic(v: string): void;
  ttsAuto(): boolean;
  setTtsAuto(v: boolean): void;
  ttsEngine(): TtsEngine;
  setTtsEngine(v: TtsEngine): void;
  vieneuVoice(): string;
  setVieneuVoice(v: string): void;
  ttsOutput(): "local" | "remote";
  setTtsOutput(v: "local" | "remote"): void;
  voiceModel(): { providerID: string; modelID: string } | null;
  setVoiceModel(v: { providerID: string; modelID: string } | null): void;
}

export function createSettings(kv: KvStore, opts: Options): Settings {
  const s = (k: string): string | null => {
    const v = kv.get(k);
    return typeof v === "string" ? v : null;
  };
  const b = (k: string): boolean | null => {
    const v = kv.get(k);
    return typeof v === "boolean" ? v : null;
  };
  return {
    sttMode: () => {
      const v = s("stt.mode");
      return v === "batch" || v === "streaming" ? v : opts.sttMode;
    },
    setSttMode: (v) => kv.set("stt.mode", v),
    autoSubmit: () => b("stt.autoSubmit") ?? opts.sttAutoSubmit,
    setAutoSubmit: (v) => kv.set("stt.autoSubmit", v),
    autoEnd: () => b("stt.autoEndOfSpeech") ?? false,
    setAutoEnd: (v) => kv.set("stt.autoEndOfSpeech", v),
    normalize: () => {
      const v = s("stt.normalize");
      return v === "off" || v === "batch" || v === "all" ? v : "batch";
    },
    setNormalize: (v) => kv.set("stt.normalize", v),
    language: () => {
      const v = s("stt.language");
      return v === "vi" || v === "en" || v === "auto" ? v : opts.sttLanguage;
    },
    setLanguage: (v) => kv.set("stt.language", v),
    whisperModel: () => s("stt.model") || opts.sttModel,
    setWhisperModel: (v) => kv.set("stt.model", v),
    sttEngine: () => (s("stt.engine") === "api" && opts.sttEndpoint ? "api" : "local"),
    setSttEngine: (v) => kv.set("stt.engine", v),
    mic: () => s("stt.mic") ?? (opts.sttCaptureCmd ? "" : ""),
    setMic: (v) => kv.set("stt.mic", v),
    ttsAuto: () => s("tts.mode") === "on",
    setTtsAuto: (v) => kv.set("tts.mode", v ? "on" : "off"),
    ttsEngine: () => {
      const v = s("tts.engine");
      return v === "piper" || v === "vieneu" ? v : opts.ttsEngine;
    },
    setTtsEngine: (v) => kv.set("tts.engine", v),
    vieneuVoice: () => s("tts.vieneuVoice") || opts.ttsVieneuVoice,
    setVieneuVoice: (v) => kv.set("tts.vieneuVoice", v),
    ttsOutput: () => (s("tts.output") === "remote" && opts.ttsPlayCmd ? "remote" : "local"),
    setTtsOutput: (v) => kv.set("tts.output", v),
    voiceModel: () => {
      const p = s("voice.providerID");
      const m = s("voice.modelID");
      return p && m ? { providerID: p, modelID: m } : null;
    },
    setVoiceModel: (v) => {
      kv.set("voice.providerID", v?.providerID ?? "");
      kv.set("voice.modelID", v?.modelID ?? "");
    },
  };
}

export function memoryKv(initial: Record<string, unknown> = {}): KvStore {
  const m = new Map(Object.entries(initial));
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v) };
}
