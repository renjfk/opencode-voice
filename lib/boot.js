// Shared plugin boot for OpenCode v1 (`tui`) and v2 (`setup`).
//
// WHY this file exists: v1 and v2 entrypoints differ only in how they obtain
// an `api` object (raw v1 `TuiPluginApi` vs the v2-compat adapted `Context`).
// Everything below runs identically on both, so there is exactly one core to
// maintain. The v1 `tui` path calls `bootVoice(api, options)` with no extras
// and behaves exactly as before; the v2 `setup` path passes `{ v2: true }`
// for the first-run notice. No STT/TTS/routing/keybind behavior branches
// live here.

import fs from "node:fs";
import os from "node:os";
import { registerSTT } from "./stt.js";
import { registerTTS } from "./tts.js";
import { registerConversation } from "./conversation.js";
import { registerLiveNotes } from "./live-notes.js";
import { registerVoiceCancel } from "./cancel.js";
import { registerVoiceModel, resolveVoiceProviderModel } from "./voice-model.js";
import { createClient } from "./llm-client.js";
import { createLogger } from "./logger.js";

function loadPromptFile(filePath, logger, name) {
  if (!filePath) return null;
  const resolved = filePath.replace(/^~(?=\/|$)/, os.homedir());
  try {
    const prompt = fs.readFileSync(resolved, "utf-8").trim() || null;
    logger?.log(
      "plugin",
      prompt ? `Loaded ${name} prompt: ${resolved}` : `Ignored empty ${name} prompt: ${resolved}`,
      "debug",
    );
    return prompt;
  } catch (err) {
    logger?.log("Plugin", `Failed to load ${name} prompt ${resolved}: ${err.message}`, "warn");
    return null;
  }
}

export async function bootVoice(api, options, extras = {}) {
  const { kv } = api;
  const logger = createLogger(api.client);
  logger.log("plugin", "Initializing", "debug");
  // Session-scoped gateways (opencode.ai/zen/go) require x-opencode-session.
  // Read the live route at call time so normalize works in any session.
  // The voice-selected provider (/voice-model) fills endpoint/model only
  // when the explicit options leave them out.
  const { complete } = createClient(
    options,
    logger,
    () => {
      const route = api?.route?.current;
      return route?.name === "session" ? route?.params?.sessionID : undefined;
    },
    () => resolveVoiceProviderModel(api, kv),
  );

  const prompts = {
    stt: loadPromptFile(options?.sttPrompt, logger, "STT"),
    ttsAuto: loadPromptFile(options?.ttsAutoPrompt, logger, "TTS auto"),
    ttsManual: loadPromptFile(options?.ttsManualPrompt, logger, "TTS manual"),
  };

  const shared = {};
  const stt = registerSTT(api, kv, complete, prompts, options, logger, {
    isConversationActive: () => shared.conversation?.isActive() === true,
    onConversationKey: (source) => shared.conversation?.onKey(source),
    isLiveNotesActive: () => shared.liveNotes?.isActive() === true,
  });
  const tts = registerTTS(api, kv, complete, prompts, options, logger, {
    isConversationActive: () => shared.conversation?.isActive() === true,
    onConversationStopKey: () => shared.conversation?.onTtsStop() === true,
  });
  const conversation = registerConversation(api, options, logger, {
    stt: stt.controller,
    tts: tts.controller,
    isLiveNotesActive: () => shared.liveNotes?.isActive() === true,
  });
  shared.conversation = conversation.controller;
  const liveNotes = registerLiveNotes(api, kv, complete, options, logger, {
    tts: tts.controller,
    isConversationActive: () => shared.conversation?.isActive() === true,
  });
  shared.liveNotes = liveNotes.controller;
  const voiceModel = registerVoiceModel(api, kv, options, logger);
  const cancel = registerVoiceCancel(api, options, logger, {
    stt: stt.controller,
    tts: tts.controller,
    conversation: shared.conversation,
    liveNotes: shared.liveNotes,
  });

  api.command.register(() => [
    ...stt.commands,
    ...tts.commands,
    ...conversation.commands,
    ...liveNotes.commands,
    ...voiceModel.commands,
    ...cancel.commands,
  ]);

  if (extras?.v2 && typeof extras?.onReady === "function") {
    await extras.onReady({ logger, stt, tts, conversation, liveNotes, voiceModel, cancel });
  }

  return { stt, tts, conversation, liveNotes, voiceModel, cancel, logger };
}
