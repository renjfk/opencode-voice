// Palette / slash / keybind commands. Ids keep the JS plugin's names so
// existing `keybinds` overrides still apply.
import type { KeymapCommand, SelectOption } from "./host.ts";
import type { NormalizeMode, SttMode, TtsEngine } from "./config.ts";
import type { SttLanguage } from "./types.ts";

export interface CommandActions {
  sttToggle(): void;
  sttCorrect(): void;
  sttPause(): void;
  cancelAll(): void;
  ttsToggle(): void;
  ttsPause(): void;
  ttsStop(): void;
  ttsReplay(): void;
  toggleAutoSubmit(): void;
  toggleAutoEnd(): void;
  toggleTtsAuto(): void;
  pickSttMode(): Promise<void>;
  pickNormalize(): Promise<void>;
  pickLanguage(): Promise<void>;
  pickWhisperModel(): Promise<void>;
  pickSttEngine(): Promise<void>;
  pickMic(): Promise<void>;
  pickTtsEngine(): Promise<void>;
  pickVoice(): Promise<void>;
  pickTtsOutput(): Promise<void>;
  pickVoiceModel(): Promise<void>;
  showStatus(): void;
}

const DEFAULT_BINDS: Record<string, string> = {
  "stt.record": "<leader>[",
  "tts.speak-last": "<leader>]",
  "voice.cancel": "<leader>.",
  "tts.replay": "<leader>0",
};

export function buildCommands(
  a: CommandActions,
  overrides: Readonly<Record<string, string>>,
): KeymapCommand[] {
  const bind = (id: string): false | string => {
    const v = overrides[id] ?? DEFAULT_BINDS[id];
    return v && v !== "none" ? v : false;
  };
  const cmd = (
    id: string,
    title: string,
    slash: string,
    run: () => void | Promise<void>,
    description?: string,
  ): KeymapCommand => ({
    id,
    title,
    group: "Voice",
    palette: true,
    slash: { name: slash },
    bind: bind(id),
    ...(description ? { description } : {}),
    run: () => {
      void Promise.resolve(run()).catch(() => {});
    },
  });
  return [
    cmd("stt.record", "Voice: speak (start / finish dictation)", "stt", a.sttToggle),
    cmd("stt.correct", "Voice: fix — re-speak to correct the text", "stt-fix", a.sttCorrect),
    cmd("stt.pause", "Voice: pause / resume live dictation", "stt-pause", a.sttPause),
    cmd("voice.cancel", "Voice: cancel everything", "voice-cancel", a.cancelAll),
    cmd("tts.speak-last", "Voice: read the last reply (or stop)", "tts-speak", a.ttsToggle),
    cmd("tts.pause", "Voice: pause / resume reading", "tts-pause", a.ttsPause),
    cmd("tts.stop", "Voice: stop reading", "tts-stop", a.ttsStop),
    cmd("tts.replay", "Voice: replay the last reading", "tts-replay", a.ttsReplay),
    cmd(
      "stt.autosubmit",
      "Voice: toggle auto-submit after dictation",
      "stt-autosubmit",
      a.toggleAutoSubmit,
    ),
    cmd("stt.autoend", "Voice: toggle auto-finish on silence", "stt-auto-end", a.toggleAutoEnd),
    cmd("tts.mode", "Voice: toggle auto-read replies", "tts-mode", a.toggleTtsAuto),
    cmd("stt.mode", "Voice: dictation mode (live / batch)", "stt-mode", a.pickSttMode),
    cmd("stt.normalize", "Voice: LLM clean-up of dictation", "stt-normalize", a.pickNormalize),
    cmd("stt.language", "Voice: dictation language", "stt-language", a.pickLanguage),
    cmd("stt.model", "Voice: whisper model", "stt-model", a.pickWhisperModel),
    cmd("stt.engine", "Voice: transcription engine (local / API)", "stt-engine", a.pickSttEngine),
    cmd("stt.mic", "Voice: microphone (Mac / phone)", "stt-mic", a.pickMic),
    cmd("tts.engine", "Voice: speech engine (VieNeu / Piper)", "tts-engine", a.pickTtsEngine),
    cmd("tts.voice", "Voice: VieNeu voice", "tts-voice", a.pickVoice),
    cmd("tts.output", "Voice: speaker (Mac / phone)", "tts-output", a.pickTtsOutput),
    cmd("voice.model", "Voice: LLM model for clean-up and fix", "voice-model", a.pickVoiceModel),
    cmd("voice.status", "Voice: status and diagnostics", "voice-status", a.showStatus),
  ];
}

// Static option lists used by the pickers.

export const STT_MODE_OPTIONS: readonly SelectOption<SttMode>[] = [
  { title: "Live", value: "streaming", description: "Text appears while you speak" },
  { title: "Batch", value: "batch", description: "Speak, then the whole recording is transcribed" },
];

export const NORMALIZE_OPTIONS: readonly SelectOption<NormalizeMode>[] = [
  {
    title: "Batch only",
    value: "batch",
    description: "Clean up batch dictation; live text stays as heard",
  },
  {
    title: "Always",
    value: "all",
    description: "Also clean up live dictation (adds a short wait)",
  },
  { title: "Off", value: "off", description: "Insert exactly what whisper heard" },
];

export const LANGUAGE_OPTIONS: readonly SelectOption<SttLanguage>[] = [
  {
    title: "Auto",
    value: "auto",
    description: "Detect per recording (Vietnamese / English mixed)",
  },
  { title: "Tiếng Việt", value: "vi" },
  { title: "English", value: "en" },
];

export const TTS_ENGINE_OPTIONS: readonly SelectOption<TtsEngine>[] = [
  {
    title: "VieNeu",
    value: "vieneu",
    description: "Natural Vietnamese + English voice (falls back to Piper)",
  },
  { title: "Piper", value: "piper", description: "Fast, lightweight, more robotic" },
];
