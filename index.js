// opencode-voice: Speech-to-text and text-to-speech for OpenCode.
//
// STT: Record voice via sox, transcribe with whisper-cpp, normalize with
//      an OpenAI-compatible LLM, and insert the text at the cursor of the
//      focused input (composer, dialog search, or plugin field) on both
//      hosts. Explicit submits only: /stt-submit, sttAutoSubmit, conversation.
//
// TTS: Auto-speak assistant responses (or read on demand) via Piper,
//      with LLM normalization for natural speech.
//
// Prerequisites:
//   STT: brew install whisper-cpp sox
//   TTS: Piper binary on PATH, voice models at ~/.local/share/piper-voices/
//
// Configuration via tui.json plugin options:
//   ["opencode-voice", { "endpoint": "...", "model": "...", "apiKeyEnv": "..." }]
//
// Runtime state (model, mic, voice, tts mode) persisted via api.kv.
//
// Commands (palette + slash; default shortcuts use rare leader combos to avoid collisions):
//   /stt-record          - start/stop recording + transcribe  (default: <leader>[ = ctrl+x, [)
//   /stt-submit          - stop recording + transcribe + submit (palette-only)
//   /stt-stop            - cancel recording (palette-only)
//   /stt-pause           - pause/resume live dictation, mic frozen (palette-only)
//   /stt-model           - select whisper model
//   /stt-language        - select transcription language
//   /stt-mic             - select microphone
//   /tts-speak           - read last response aloud        (default: <leader>] = ctrl+x, ])
//   /tts-mode            - toggle auto TTS on/off (palette-only)
//   /tts-stop            - stop playback (palette-only; global <leader>. also stops TTS)
//   /tts-voice           - select TTS voice
//   /tts-engine          - select TTS engine (piper/chatterbox/vieneu) (palette-only)
//   /tts-pause           - pause/resume TTS playback (palette-only)
//   /tts-replay          - replay from start (default: <leader>0)
//   /tts-rewind          - rewind 5s (default: <leader>-)
//   /tts-forward         - forward 5s (default: <leader>=)
//   /tts-rate            - cycle/select playback speed 0.75x-2x (palette-only)
//   /voice-conversation  - toggle hands-free voice conversation (default: <leader>v = ctrl+x, v)
//   /voice-conversation-stop - exit voice conversation mode (palette-only)
//   /voice-notes-start   - start continuous live-notes recording (palette-only)
//   /voice-notes-stop    - stop live notes, flush, and save (palette-only)
//   /voice-notes-cancel  - stop live notes immediately, save in background (palette-only)
//   /voice-notes-status  - show live-notes recording status (palette-only)
//   /voice-cancel        - cancel everything in flight            (default: <leader>.)
//   All also palette-accessible via Ctrl+P or /slash. Override via plugin options `keybinds`:
//   { "keybinds": { "stt.record": "ctrl+r", "tts.speak-last": "none", "voice.conversation": "none" } }
//   Weird keys [ ] ; were chosen because opencode doesn't use them and shift variants were ignored in terminals.
//   <leader>v is free in opencode defaults (c/e/s/m/a/y/u/r/h etc. are taken) and mnemonic for voice.

import { bootVoice } from "./lib/boot.js";
import { adaptV2Context } from "./lib/v2-compat.js";

// Dual-compat export: v1's loader reads `tui`, v2's reads `setup`
// (`Plugin.define` is an identity wrapper, so a plain object carries both).
// Each host ignores the other's key. The core (`bootVoice`) is shared; v2
// runs it over the v2-compat adapted api, which forwards the live renderer
// so dictation lands in whatever input currently has focus.
export default {
  id: "opencode-voice",
  tui: async (api, options) => {
    await bootVoice(api, options);
  },
  setup: async (ctx) => {
    const adapted = adaptV2Context(ctx);
    await bootVoice(adapted.api, ctx.options, {
      v2: true,
      onReady: async ({ logger }) => {
        // First-run v2 notice (required UX disclosure): text is typed into
        // the focused field and is never sent automatically.
        const notice =
          "Voice on OpenCode v2: transcripts are inserted at the cursor of the focused text field " +
          "(prompt, search, or dialog input) and are not sent automatically. " +
          "Set sttAutoSubmit to submit after recording.";
        adapted.api.ui.toast({ message: notice, variant: "warning", duration: 8000 });
        logger?.log?.("plugin", `v2 focused-input mode: ${notice}`, "warn");
        // v2 has no client.app.log, so the logger above is a no-op: compat
        // warnings must surface as a toast or they are lost entirely.
        if (adapted.warnMessages.length > 0) {
          const shown = adapted.warnMessages.slice(0, 3).join(" | ");
          const rest =
            adapted.warnMessages.length > 3 ? ` (+${adapted.warnMessages.length - 3} more)` : "";
          adapted.api.ui.toast({
            message: `Voice v2 compat: ${shown}${rest}`,
            variant: "warning",
            duration: 8000,
          });
        }
        for (const message of adapted.warnMessages) {
          logger?.log?.("plugin", `v2-compat: ${message}`, "warn");
        }
      },
    });
    return adapted.cleanup;
  },
};
