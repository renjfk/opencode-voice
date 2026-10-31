// opencode-voice: Speech-to-text and text-to-speech for OpenCode.
//
// STT: Record voice via sox, transcribe with whisper-cpp, normalize with
//      an OpenAI-compatible LLM, submit to the session.
//
// TTS: Auto-speak assistant responses (or read on demand) via Piper,
//      with LLM normalization for natural speech.
//
// Prerequisites:
//   STT: brew install whisper-cpp sox
//   TTS: Piper binary on PATH, voice models at ~/.local/share/piper-voices/
//
// Configuration via cli.json plugin options:
//   { "package": "@renjfk/opencode-voice", "options": { "endpoint": "...", "model": "...", "apiKeyEnv": "..." } }
//
// Runtime state (model, mic, voice, tts mode) persisted via context.storage.
//
// Commands:
//   /stt-record (ctrl+r)  - start/stop recording, transcribe and submit
//   /stt-submit (leader+r)- stop recording, transcribe, and submit
//   /stt-stop             - cancel recording
//   /stt-model            - select whisper model
//   /stt-language         - select transcription language
//   /stt-mic              - select microphone
//   /tts-speak (leader+s)- read last response aloud
//   /tts-mode (leader+v) - toggle auto TTS on/off
//   /tts-stop (escape)   - stop playback
//   /tts-voice            - select TTS voice
//
// V2 notes:
//   - This is the `./tui` entry of the package. Import it from cli.json plugins.
//   - V2 2.2 has no API to write the composer text (the V1
//     `client.tui.appendPrompt` producer was removed; `tui.prompt.append` has a
//     consumer but no producer). /stt-submit sends the transcript directly;
//     /stt-record opens an editable review dialog (`context.ui.dialog.prompt`)
//     prefilled with the text: the user reviews/edits and Enter sends it.

import fs from "node:fs";
import os from "node:os";
import { Plugin } from "@opencode/plugin/tui";
import { registerSTT } from "./lib/stt.js";
import { registerTTS } from "./lib/tts.js";
import { createClient } from "./lib/llm-client.js";
import { createLogger } from "./lib/logger.js";

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

// Map a V2 form (the replacement for V1 `question.asked`) into the V1 question
// shape the STT/TTS message helpers and command logic expect.
function formToQuestion(form) {
  return {
    sessionID: form.sessionID,
    id: form.id,
    questions: (form.fields ?? []).map((field) => ({
      question: field.description ?? field.title ?? field.key,
      header: field.title ?? field.key,
      options: (field.options ?? []).map((option) => ({
        label: option.label,
        description: option.description ?? "",
      })),
      multiple: field.type === "multiselect",
      custom: field.custom !== false,
    })),
  };
}

// A key/value store over V2 durable storage, matching the V1 `api.kv` shape so
// the STT/TTS command modules stay unchanged.
function createStorage(context) {
  const [store, update] = context.storage.store("state", { initial: {} });
  return {
    ready: true,
    get: (key, fallback) => (key in store ? store[key] : fallback),
    set: (key, value) => {
      void update((draft) => {
        draft[key] = value;
      });
    },
  };
}

// Adapt V2 dialogs to the V1 `api.ui.dialog.replace(() => api.ui.DialogSelect(...))`
// shape used by the command modules. The returned descriptor is consumed by
// `replace`, which opens the promise-based V2 select dialog.
function createDialog(context) {
  return {
    DialogSelect: (options) => ({ __select: options }),
    replace(render) {
      const descriptor = render();
      if (!descriptor || !descriptor.__select) return;
      const { title, current, options = [] } = descriptor.__select;
      context.ui.dialog
        .select({
          title,
          current,
          options: options.map((option) => ({
            title: option.title,
            value: option.value,
            description: option.description,
          })),
        })
        .then((value) => {
          if (value === undefined) return;
          options.find((option) => option.value === value)?.onSelect?.();
        })
        .catch(() => {});
    },
    clear: () => context.ui.dialog.clear(),
  };
}

// Map V2 server events onto the V1 `api.event.on(type, { type, properties })`
// shape. `question.asked` is the V2 `form.created` event. Every subscription's
// unsubscribe function is collected so setup's cleanup can remove them: the
// TUI host does not scope `context.data` listeners to the plugin, and a hot
// reload would otherwise leave the old instance handling events forever.
function createEvent(context) {
  const unsubscribers = [];
  return {
    on(type, handler) {
      const unsubscribe =
        type === "question.asked"
          ? context.data.on("form.created", (event) =>
              handler({ type, properties: formToQuestion(event.data.form) }),
            )
          : context.data.on(type, (event) => handler({ type, properties: event.data }));
      unsubscribers.push(unsubscribe);
      return unsubscribe;
    },
    dispose() {
      while (unsubscribers.length > 0) {
        try {
          unsubscribers.pop()();
        } catch {
          // A dead listener must not block the rest of the cleanup.
        }
      }
    },
  };
}

// The V1-era api surface the command modules are written against, adapted to
// the V2 plugin context. Exported for tests.
export function createApi(context, kv) {
  const dialogApi = createDialog(context);
  return {
    client: context.client,
    kv,
    // V1 shape: `api.ui.DialogSelect` (the descriptor factory) lives next to
    // toast, while `api.ui.dialog.replace/clear` consume it. The command
    // modules call both paths; each must exist at its V1 location.
    ui: {
      toast: (toast) => context.ui.toast.show(toast),
      dialog: dialogApi,
      DialogSelect: dialogApi.DialogSelect,
    },
    event: createEvent(context),
    route: {
      get current() {
        const route = context.ui.router.current();
        return route.type === "session"
          ? { name: "session", params: { sessionID: route.sessionID } }
          : { name: route.type, params: {} };
      },
    },
    state: {
      session: {
        messages: (sessionID) => context.data.session.message.list(sessionID) ?? [],
        // Family root of a session (its top-level ancestor); subagent
        // sessions share their parent's root.
        root: (sessionID) => context.data.session.root(sessionID),
      },
    },
    activeSessionTitle() {
      const sessions = context.data.session.list();
      if (!sessions || sessions.length === 0) return "";
      const active = [...sessions].sort((a, b) => b.time.updated - a.time.updated)[0];
      return active?.title || "";
    },
    session: {
      // V2 2.2 has no API to write the composer text (the V1
      // `client.tui.appendPrompt` producer was removed; the `tui.prompt.append`
      // event it used has a consumer but no producer). Voice input therefore
      // either sends directly (/stt-submit) or opens an editable review dialog
      // prefilled with the transcript (/stt-record): the user reviews/edits
      // and Enter sends it to the session.
      async deliverTranscription(text, submit = false) {
        const route = context.ui.router.current();
        if (route.type !== "session") {
          context.ui.toast.show({
            message: "Open a session before using voice input",
            variant: "warning",
          });
          return;
        }
        const draft = String(text ?? "").trim();
        if (!draft) {
          context.ui.toast.show({ message: "No speech detected", variant: "warning" });
          return;
        }
        let finalText = draft;
        if (!submit) {
          const edited = await context.ui.dialog.prompt({
            title: "Voice prompt",
            description: "Review and edit, then Enter to send (Esc to cancel)",
            value: draft,
          });
          if (edited === undefined) return;
          finalText = edited.trim();
        }
        if (!finalText) {
          context.ui.toast.show({ message: "Empty prompt, nothing sent", variant: "warning" });
          return;
        }
        await context.client.session.prompt({ sessionID: route.sessionID, text: finalText });
        context.ui.toast.show({ message: "Voice prompt sent", variant: "success" });
      },
    },
  };
}

function toCommand(command) {
  return {
    id: command.value,
    title: command.title,
    description: command.description,
    bind: command.keybind || undefined,
    palette: true,
    slash: command.slash,
    run: () => command.onSelect(),
  };
}

export default Plugin.define({
  id: "opencode-voice",
  setup(context) {
    const options = context.options;
    const logger = createLogger();
    logger.log("plugin", "Initializing", "debug");
    const { complete } = createClient(options, logger);

    const prompts = {
      stt: loadPromptFile(options?.sttPrompt, logger, "STT"),
      ttsAuto: loadPromptFile(options?.ttsAutoPrompt, logger, "TTS auto"),
      ttsManual: loadPromptFile(options?.ttsManualPrompt, logger, "TTS manual"),
    };

    const kv = createStorage(context);
    const api = createApi(context, kv);

    const sttCommands = registerSTT(api, kv, complete, prompts, options, logger);
    const ttsCommands = registerTTS(api, kv, complete, prompts, options, logger);

    context.keymap.layer(() => ({
      mode: "global",
      commands: [...sttCommands, ...ttsCommands].map(toCommand),
    }));

    // The keymap layer is removed with the plugin; data listeners are not
    // scoped by the host, so they are detached here (hot reloads, TUI close).
    return () => api.event.dispose();
  },
});
