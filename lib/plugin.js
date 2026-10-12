// V2 CLI plugin definition.
//
// Kept free of the `@opencode/plugin/tui` import so the definition can be
// built and tested without the host runtime; index.js wraps it with
// Plugin.define for OpenCode.

import fs from "node:fs";
import os from "node:os";
import { registerSTT } from "./stt.js";
import { registerTTS } from "./tts.js";
import { createClient } from "./llm-client.js";
import { createLogger } from "./logger.js";
import { createKV } from "./kv.js";

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

export function createPluginDefinition() {
  return {
    id: "opencode-voice",
    async setup(context) {
      const logger = createLogger();
      const kv = createKV(context.storage);
      const { complete } = createClient(context.options, logger);
      logger.log("plugin", "Initializing", "debug");

      const prompts = {
        stt: loadPromptFile(context.options?.sttPrompt, logger, "STT"),
        ttsAuto: loadPromptFile(context.options?.ttsAutoPrompt, logger, "TTS auto"),
        ttsManual: loadPromptFile(context.options?.ttsManualPrompt, logger, "TTS manual"),
      };

      const stt = registerSTT(context, kv, complete, prompts, context.options, logger);
      const tts = registerTTS(context, kv, complete, prompts, context.options, logger);

      context.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [...stt.commands, ...tts.commands],
      }));

      return () => {
        stt.dispose?.();
        tts.dispose?.();
      };
    },
  };
}
