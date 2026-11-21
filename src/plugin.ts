// Composition root: builds every module from the host context, wires the two
// state machines to the status line and commands, and tears it all down.
import { createHost, type HostContext, type SelectOption } from "./host.ts";
import { createSettings, parseOptions, type Options, type Settings } from "./config.ts";
import { createFileLogger, defaultLogPath } from "./log.ts";
import { createLlm } from "./llm/client.ts";
import { resolveLlmConfig } from "./llm/config.ts";
import {
  CORRECTION_PROMPT,
  STT_NORMALIZE_PROMPT,
  TTS_NORMALIZE_PROMPT,
  buildCorrectionUser,
  buildSttUser,
  cleanNormalizerOutput,
  needsContext,
} from "./llm/prompts.ts";
import { listInputDevices, openMic } from "./audio/mic.ts";
import { createPlayer } from "./audio/player.ts";
import { pcmRms, wavDurationSec, wrapPcm } from "./audio/wav.ts";
import { createWhisperTranscriber, defaultWhisperModel, findWhisperModels } from "./stt/whisper.ts";
import { createApiTranscriber } from "./stt/api-transcriber.ts";
import { transcribeLong } from "./stt/long.ts";
import { cleanTranscript, isLikelyHallucination } from "./stt/filter.ts";
import { createStreamingSession } from "./stt/streaming.ts";
import { createSttMachine, type SttMachine } from "./stt/session.ts";
import { createTtsMachine, type TtsMachine } from "./tts/session.ts";
import { mergeForEngine, prepareSpeech, splitSegments } from "./tts/text.ts";
import { createVieneuSynth } from "./tts/vieneu.ts";
import { createPiperSynth, defaultPiperVoice } from "./tts/piper.ts";
import { mountStatus, type Action, type StatusMount } from "./ui/status.ts";
import {
  LANGUAGE_OPTIONS,
  NORMALIZE_OPTIONS,
  RATE_OPTIONS,
  STT_MODE_OPTIONS,
  TTS_ENGINE_OPTIONS,
  buildCommands,
  type CommandActions,
} from "./commands.ts";
import type { Logger, Synth, SynthName, Transcriber } from "./types.ts";
import { PLAYBACK_RATES, errorMessage } from "./types.ts";

const IDLE_RELEASE_MS = 10 * 60_000;

/** Next preset speed up (+1) or down (-1), stopping at the ends. */
export function nextRate(cur: number, dir: 1 | -1): number {
  const rates = [...PLAYBACK_RATES];
  if (dir > 0) return rates.find((r) => r > cur + 0.001) ?? (rates[rates.length - 1] as number);
  return [...rates].reverse().find((r) => r < cur - 0.001) ?? (rates[0] as number);
}

export interface PluginHandle {
  readonly stt: SttMachine;
  readonly tts: TtsMachine;
  readonly settings: Settings;
  readonly options: Options;
  dispose(): Promise<void>;
}

export async function setupPlugin(
  ctx: HostContext,
  logger: Logger = createFileLogger(),
): Promise<PluginHandle> {
  const host = createHost(ctx);
  const options = parseOptions(ctx.options);
  const settings = createSettings(host.kv, options);
  logger.log("plugin", `setup host=${ctx.app?.version ?? "?"}`, "info");

  const llm = createLlm(
    () =>
      resolveLlmConfig({
        options: { ...options.raw },
        selection: settings.voiceModel(),
        sessionModel: host.sessionModel(),
        providers: host.providers(),
        models: host.models(),
      }),
    { logger },
  );

  // ------------------------------------------------ engines (lazy, released when idle)

  let trans: { key: string; t: Transcriber; usedAt: number } | null = null;
  function transcriber(): Transcriber {
    const api = settings.sttEngine() === "api" && options.sttEndpoint && options.sttApiModel;
    const model = settings.whisperModel() ?? defaultWhisperModel();
    const key = api ? `api:${options.sttEndpoint}:${options.sttApiModel}` : `local:${model ?? ""}`;
    if (trans && trans.key === key) {
      trans.usedAt = Date.now();
      return trans.t;
    }
    const old = trans;
    trans = null;
    void old?.t.dispose().catch(() => {});
    let t: Transcriber;
    if (api) {
      const apiKey = options.sttApiKeyEnv ? process.env[options.sttApiKeyEnv] : undefined;
      t = createApiTranscriber({
        endpoint: options.sttEndpoint as string,
        model: options.sttApiModel as string,
        ...(apiKey ? { apiKey } : {}),
        logger,
      });
    } else {
      if (!model)
        throw new Error(
          "No whisper model found — download a ggml model, then pick it with /stt-model",
        );
      t = createWhisperTranscriber({ modelPath: model, logger });
    }
    trans = { key, t, usedAt: Date.now() };
    return t;
  }

  const synths = new Map<SynthName, { s: Synth; usedAt: number }>();
  function synth(name: SynthName): Synth {
    const hit = synths.get(name);
    if (hit) {
      hit.usedAt = Date.now();
      return hit.s;
    }
    const s =
      name === "vieneu"
        ? createVieneuSynth({
            python: options.ttsVieneuPython,
            voice: () => settings.vieneuVoice(),
            logger,
          })
        : createPiperSynth({ voiceFor: (lang) => defaultPiperVoice(lang), logger });
    synths.set(name, { s, usedAt: Date.now() });
    return s;
  }

  const player = createPlayer(
    () =>
      settings.ttsOutput() === "remote" && options.ttsPlayCmd
        ? { kind: "remote", command: options.ttsPlayCmd }
        : { kind: "local" },
    { logger },
  );

  // ------------------------------------------------------- machines

  let stt: SttMachine | null = null;
  const tts = createTtsMachine({
    host,
    settings,
    logger,
    llm,
    normalizePrompt: options.ttsPrompt ?? TTS_NORMALIZE_PROMPT,
    prepareSpeech,
    splitSegments: (text) => splitSegments(text),
    mergeForEngine,
    synth,
    player,
    clipDuration: (wav) => wavDurationSec(wav) ?? 0,
    isRecording: () => stt?.isBusy() === true,
  });

  stt = createSttMachine({
    host,
    settings,
    options,
    logger,
    openMic: (cfg) => openMic(cfg, { logger }),
    transcriber,
    transcribeFile: (t, wav, opts) => transcribeLong(t, wav, opts, { logger }),
    createStreaming: (input) =>
      createStreamingSession({
        mic: input.mic,
        transcriber: input.transcriber,
        language: input.language,
        onPartial: input.onPartial,
        onError: input.onError,
        logger,
      }),
    wrapPcm,
    pcmRms,
    cleanTranscript,
    isHallucination: isLikelyHallucination,
    llm,
    prompts: {
      normalize: options.sttPrompt ?? STT_NORMALIZE_PROMPT,
      correction: CORRECTION_PROMPT,
      buildSttUser,
      buildCorrectionUser,
      needsContext,
      cleanOutput: cleanNormalizerOutput,
    },
    onRecordingStart: () => {
      // The mic must not hear the reply being read: pause it, or stop it when
      // it is still preparing / between parts (nothing to pause yet).
      if (tts.isBusy() && !tts.pause()) tts.stop();
    },
  });
  const sttM = stt;

  // ------------------------------------------------------- actions

  const toggleAutoSubmit = (): void => {
    const next = !settings.autoSubmit();
    settings.setAutoSubmit(next);
    host.toast(
      next
        ? "Auto-submit on: dictation is sent right away"
        : "Auto-submit off: dictation is inserted",
      "info",
      2500,
    );
  };

  async function pick<V>(
    title: string,
    opts: readonly SelectOption<V>[],
    current: V,
    apply: (v: V) => void,
  ): Promise<void> {
    const v = await host.select(title, opts, current);
    if (v === undefined) return;
    apply(v);
    status?.refresh();
  }

  const actions: CommandActions = {
    sttToggle: () => sttM.toggle(),
    sttCorrect: () => sttM.correct(),
    sttPause: () => {
      if (!sttM.pause()) host.toast("Pause works during live dictation only", "info", 2500);
    },
    cancelAll: () => {
      const a = sttM.cancel();
      const b = tts.stop();
      if (!a && !b) host.toast("Nothing to cancel", "info", 1500);
    },
    ttsToggle: () => tts.toggle(),
    ttsPause: () => {
      if (!tts.pause()) host.toast("Nothing is being read", "info", 1500);
    },
    ttsStop: () => void tts.stop(),
    ttsReplay: () => {
      if (!tts.replay()) host.toast("Nothing to replay yet", "info", 1500);
    },
    ttsBack: () => {
      if (!tts.seekBy(-5)) host.toast("Nothing is being read", "info", 1500);
    },
    ttsForward: () => {
      if (!tts.seekBy(5)) host.toast("Nothing is being read", "info", 1500);
    },
    ttsFaster: () => {
      const r = nextRate(tts.view().rate, +1);
      tts.setRate(r);
      host.toast(`Reading speed ${r}x`, "info", 1200);
    },
    ttsSlower: () => {
      const r = nextRate(tts.view().rate, -1);
      tts.setRate(r);
      host.toast(`Reading speed ${r}x`, "info", 1200);
    },
    pickRate: () => pick("Reading speed", RATE_OPTIONS, tts.view().rate, (v) => tts.setRate(v)),
    toggleAutoSubmit,
    toggleAutoEnd: () => {
      const next = !settings.autoEnd();
      settings.setAutoEnd(next);
      host.toast(
        next ? "Auto-finish on: 2.5s of silence finishes dictation" : "Auto-finish off",
        "info",
        2500,
      );
    },
    toggleTtsAuto: () => {
      const next = !settings.ttsAuto();
      settings.setTtsAuto(next);
      host.toast(next ? "Auto-read on: replies are read aloud" : "Auto-read off", "info", 2500);
      if (next && settings.ttsEngine() === "vieneu") synth("vieneu").warm();
    },
    pickSttMode: () =>
      pick("Dictation mode", STT_MODE_OPTIONS, settings.sttMode(), (v) => settings.setSttMode(v)),
    pickNormalize: () =>
      pick("LLM clean-up of dictation", NORMALIZE_OPTIONS, settings.normalize(), (v) =>
        settings.setNormalize(v),
      ),
    pickLanguage: () =>
      pick("Dictation language", LANGUAGE_OPTIONS, settings.language(), (v) =>
        settings.setLanguage(v),
      ),
    pickWhisperModel: async () => {
      const models = findWhisperModels();
      if (models.length === 0) {
        host.toast("No whisper models found in ~/.local/share/whisper-cpp", "warning");
        return;
      }
      const opts = models.map((p) => ({
        title: p.split("/").pop() ?? p,
        value: p,
        description: p,
      }));
      await pick(
        "Whisper model",
        opts,
        settings.whisperModel() ?? defaultWhisperModel() ?? "",
        (v) => settings.setWhisperModel(v),
      );
    },
    pickSttEngine: async () => {
      if (!options.sttEndpoint) {
        host.toast(
          "API transcription needs sttEndpoint + sttApiModel in the plugin options",
          "info",
          4000,
        );
        return;
      }
      await pick(
        "Transcription engine",
        [
          { title: "Local whisper", value: "local" as const },
          { title: `API (${options.sttApiModel ?? "?"})`, value: "api" as const },
        ],
        settings.sttEngine(),
        (v) => settings.setSttEngine(v),
      );
    },
    pickMic: async () => {
      const devices = await listInputDevices().catch(() => [] as string[]);
      const opts: SelectOption<string>[] = [
        { title: "Mac — default input", value: "" },
        ...devices.map((d) => ({ title: d, value: d })),
      ];
      if (options.sttCaptureCmd)
        opts.push({
          title: "Phone (USB / ssh)",
          value: "remote",
          description: "Uses sttCaptureCmd",
        });
      await pick("Microphone", opts, settings.mic(), (v) => settings.setMic(v));
    },
    pickTtsEngine: () =>
      pick("Speech engine", TTS_ENGINE_OPTIONS, settings.ttsEngine(), (v) => {
        settings.setTtsEngine(v);
        if (v === "vieneu") synth("vieneu").warm();
      }),
    pickVoice: async () => {
      const s = synth("vieneu") as Synth & { voices?: () => Promise<string[]> };
      const voices = await (s.voices?.() ?? Promise.resolve([] as string[])).catch(
        () => [] as string[],
      );
      if (voices.length === 0) {
        host.toast("Could not list VieNeu voices (is the VieNeu sidecar running?)", "warning");
        return;
      }
      await pick(
        "VieNeu voice",
        voices.map((v) => ({ title: v, value: v })),
        settings.vieneuVoice(),
        (v) => settings.setVieneuVoice(v),
      );
    },
    pickTtsOutput: async () => {
      if (!options.ttsPlayCmd) {
        host.toast("Phone speaker needs ttsPlayCmd in the plugin options", "info", 4000);
        return;
      }
      await pick(
        "Speaker",
        [
          { title: "Mac speakers", value: "local" as const },
          { title: "Phone (USB / ssh)", value: "remote" as const },
        ],
        settings.ttsOutput(),
        (v) => settings.setTtsOutput(v),
      );
    },
    pickVoiceModel: async () => {
      const opts: SelectOption<string>[] = [{ title: "Same as the session model", value: "" }];
      for (const m of host.models()) {
        if (!m || typeof m !== "object") continue;
        const r = m as Record<string, unknown>;
        const prov = r.providerID ?? (r.provider as Record<string, unknown> | undefined)?.id;
        const id = r.id ?? r.modelID;
        if (typeof prov === "string" && typeof id === "string") {
          opts.push({ title: `${prov}/${id}`, value: `${prov}\u0000${id}`, category: prov });
        }
      }
      const cur = settings.voiceModel();
      await pick(
        "LLM for clean-up and fix",
        opts,
        cur ? `${cur.providerID}\u0000${cur.modelID}` : "",
        (v) => {
          const [p, id] = v.split("\u0000");
          settings.setVoiceModel(p && id ? { providerID: p, modelID: id } : null);
        },
      );
    },
    showStatus: () => {
      const lines = [
        `Dictation: ${settings.sttMode() === "streaming" ? "live" : "batch"}, language ${settings.language()}, clean-up ${settings.normalize()}`,
        `Mic: ${settings.mic() === "remote" ? "phone" : settings.mic() || "Mac default"}`,
        `Transcription: ${settings.sttEngine() === "api" ? `API ${options.sttApiModel}` : `whisper ${(settings.whisperModel() ?? defaultWhisperModel() ?? "none").split("/").pop()}`}`,
        `LLM: ${llm.describe()}`,
        `Auto-submit: ${settings.autoSubmit() ? "on" : "off"}, auto-finish: ${settings.autoEnd() ? "on" : "off"}`,
        `Speech: ${settings.ttsEngine()}${settings.ttsEngine() === "vieneu" ? ` (${settings.vieneuVoice() || "default voice"})` : ""}, speaker ${settings.ttsOutput() === "remote" ? "phone" : "Mac"}, auto-read ${settings.ttsAuto() ? "on" : "off"}, speed ${tts.view().rate}x`,
        `Log: ${defaultLogPath()}`,
      ];
      host.alert("Voice status", lines.join("\n"));
    },
  };

  const onAction = (a: Action): void => {
    switch (a) {
      case "stt.toggle":
        return actions.sttToggle();
      case "stt.finish":
        return sttM.finish();
      case "stt.correct":
        return actions.sttCorrect();
      case "stt.pause":
        return actions.sttPause();
      case "stt.cancel":
        void sttM.cancel();
        return;
      case "stt.autoSubmit":
        toggleAutoSubmit();
        status?.refresh();
        return;
      case "stt.mode": {
        const next = settings.sttMode() === "streaming" ? "batch" : "streaming";
        settings.setSttMode(next);
        host.toast(next === "streaming" ? "Live dictation" : "Batch dictation", "info", 1500);
        status?.refresh();
        return;
      }
      case "tts.toggle":
        return actions.ttsToggle();
      case "tts.pause":
        return actions.ttsPause();
      case "tts.stop":
        return actions.ttsStop();
      case "tts.replay":
        return actions.ttsReplay();
      case "tts.back":
        return actions.ttsBack();
      case "tts.forward":
        return actions.ttsForward();
      case "tts.rate":
        tts.cycleRate();
        status?.refresh();
        return;
      case "tts.auto":
        actions.toggleTtsAuto();
        status?.refresh();
        return;
    }
  };

  // ------------------------------------------------------- UI + commands

  let status: StatusMount | null = null;
  try {
    status = await mountStatus({
      slot: (target, render) => host.slot(target, render),
      read: () => ({
        stt: sttM.view(),
        tts: tts.view(),
        autoSubmit: settings.autoSubmit(),
        sttMode: settings.sttMode(),
        ttsAuto: settings.ttsAuto(),
        now: Date.now(),
      }),
      onAction,
      theme: host.theme,
      onError: (m) => host.toast(`Voice status line failed: ${m}`, "error"),
    });
  } catch (err) {
    logger.log("plugin", `status line unavailable: ${errorMessage(err)}`, "error");
    host.toast(`Voice status line unavailable: ${errorMessage(err)}`, "warning");
  }
  const offStt = sttM.onChange(() => status?.refresh());
  const offTts = tts.onChange(() => status?.refresh());

  host.registerCommands(buildCommands(actions, options.keybinds));

  // Release heavy sidecars after a quiet period.
  const reaper = setInterval(() => {
    const now = Date.now();
    if (trans && !sttM.isBusy() && now - trans.usedAt > IDLE_RELEASE_MS) {
      const t = trans.t;
      trans = null;
      void t.dispose().catch(() => {});
      logger.log("plugin", "released idle transcriber");
    }
    for (const [name, entry] of synths) {
      if (
        !tts.isBusy() &&
        now - entry.usedAt > IDLE_RELEASE_MS &&
        !(name === "vieneu" && settings.ttsAuto())
      ) {
        synths.delete(name);
        void entry.s.dispose().catch(() => {});
        logger.log("plugin", `released idle ${name}`);
      }
    }
  }, 60_000);
  reaper.unref?.();

  if (settings.ttsAuto() && settings.ttsEngine() === "vieneu") {
    setTimeout(() => synth("vieneu").warm(), 3000).unref?.();
  }

  return {
    stt: sttM,
    tts,
    settings,
    options,
    async dispose() {
      clearInterval(reaper);
      offStt();
      offTts();
      sttM.dispose();
      tts.dispose();
      status?.dispose();
      player.dispose();
      const pending: Promise<void>[] = [];
      if (trans) pending.push(trans.t.dispose().catch(() => {}));
      for (const { s } of synths.values()) pending.push(s.dispose().catch(() => {}));
      trans = null;
      synths.clear();
      host.dispose();
      await Promise.all(pending);
      logger.log("plugin", "disposed", "info");
    },
  };
}
