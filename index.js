// opencode-voice: Speech-to-text and text-to-speech for OpenCode V2.
//
// STT: Record voice via sox, transcribe with whisper-cpp, normalize with
//      an OpenAI-compatible LLM, then submit it as a prompt (or edit it in a
//      dialog first when submitOnStop is off).
//
// TTS: Auto-speak assistant responses (or read on demand) via Piper,
//      with LLM normalization for natural speech.
//
// Prerequisites:
//   STT: brew install whisper-cpp sox
//   TTS: Piper binary on PATH, voice models at ~/.local/share/piper-voices/
//
// Configuration via cli.json plugin options:
//   { "plugins": [{ "package": "opencode-voice", "options": { ... } }] }
//
// Runtime state (model, mic, voice, tts mode) persisted via context.storage.
//
// Commands:
//   /stt-record (ctrl+r)   - start/stop recording + transcribe + send
//   /stt-submit            - stop recording + transcribe + send
//   /stt-stop (ctrl+y)     - cancel recording
//   /stt-model             - select whisper model
//   /stt-language          - select transcription language
//   /stt-mic               - select microphone
//   /tts-speak (leader+v)  - read last response aloud
//   /tts-mode (leader+o)   - toggle auto TTS on/off
//   /tts-stop              - stop playback
//   /tts-voice             - select TTS voice

import { Plugin } from "@opencode/plugin/tui";
import { createPluginDefinition } from "./lib/plugin.js";

export default Plugin.define(createPluginDefinition());
