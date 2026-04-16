[![CI](https://github.com/renjfk/opencode-voice/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/renjfk/opencode-voice/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@renjfk/opencode-voice)](https://www.npmjs.com/package/@renjfk/opencode-voice)
[![Downloads](https://img.shields.io/npm/dm/@renjfk/opencode-voice)](https://www.npmjs.com/package/@renjfk/opencode-voice)

# opencode-voice

Speech-to-text and text-to-speech plugin for [OpenCode](https://opencode.ai/).

Record voice prompts with local whisper transcription, hear assistant responses
spoken aloud via Piper TTS. Both directions use an LLM to normalize text for
natural speech (fixing homophones, splitting camelCase identifiers, summarizing
code-heavy responses, etc.).

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["@renjfk/opencode-voice"]
}
```

## Prerequisites

### Speech-to-text

```bash
brew install whisper-cpp sox
```

Download a whisper model to `~/.local/share/whisper-cpp/`:

```bash
mkdir -p ~/.local/share/whisper-cpp
curl -L -o ~/.local/share/whisper-cpp/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```

### Text-to-speech

Install [Piper](https://github.com/rhasspy/piper):

```bash
uv tool install piper-tts
```

Or with pip:

```bash
pip install piper-tts
```

Download a voice model to `~/.local/share/piper-voices/`:

```bash
mkdir -p ~/.local/share/piper-voices
curl -L -o ~/.local/share/piper-voices/en_US-ryan-high.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx
curl -L -o ~/.local/share/piper-voices/en_US-ryan-high.onnx.json \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx.json
```

### LLM endpoint

An OpenAI-compatible LLM endpoint is required for text normalization. For
speech-to-text it cleans up whisper output (punctuation, filler words, software
engineering homophones). For text-to-speech it converts markdown into natural
spoken text.

By default uses Anthropic's OpenAI compatibility layer with `claude-haiku-4-5`.
Requires `ANTHROPIC_API_KEY` in your environment.

Set defaults in `tui.json` via plugin options:

```json
{
  "plugin": [
    [
      "@renjfk/opencode-voice",
      {
        "endpoint": "https://api.anthropic.com/v1",
        "model": "claude-haiku-4-5",
        "apiKeyEnv": "ANTHROPIC_API_KEY",
        "maxTokens": 2048
      }
    ]
  ]
}
```

Any OpenAI-compatible endpoint works (Ollama, vLLM, LM Studio, etc.).

### Custom prompts

The LLM system prompts used for normalization can be fully replaced by pointing
to your own prompt files. This lets you fine-tune how transcriptions are cleaned
up or how responses are spoken.

```json
{
  "plugin": [
    [
      "@renjfk/opencode-voice",
      {
        "sttPrompt": "~/.config/opencode/stt-prompt.md",
        "ttsAutoPrompt": "~/.config/opencode/tts-auto-prompt.md",
        "ttsManualPrompt": "~/.config/opencode/tts-manual-prompt.md"
      }
    ]
  ]
}
```

- `sttPrompt` - system prompt for cleaning up whisper transcriptions
- `ttsAutoPrompt` - system prompt for auto-speaking assistant responses
- `ttsManualPrompt` - system prompt for manually reading responses aloud

If a path is not set, the built-in default prompt is used.

## Commands

### Speech-to-text

| Command       | Keybind  | Description                       |
| ------------- | -------- | --------------------------------- |
| `/stt-record` | `ctrl+r` | Start/stop recording + transcribe |
| `/stt-stop`   |          | Cancel recording                  |
| `/stt-model`  |          | Select whisper model              |
| `/stt-mic`    |          | Select microphone                 |

### Text-to-speech

The `leader` key in OpenCode is `ctrl+x`. So `leader+s` means press `ctrl+x`
then `s`.

| Command      | Keybind    | Description              |
| ------------ | ---------- | ------------------------ |
| `/tts-speak` | `leader+s` | Read last response aloud |
| `/tts-mode`  | `leader+v` | Toggle auto TTS on/off   |
| `/tts-stop`  | `escape`   | Stop playback            |
| `/tts-voice` |            | Select TTS voice         |

## How it works

### STT pipeline

1. `sox` records audio from your microphone
2. `whisper-cli` transcribes locally using a ggml model
3. LLM normalizes the transcription: fixes punctuation, removes filler words,
   corrects software engineering homophones ("Jason" to "JSON", "bullion" to
   "boolean", etc.)
4. Cleaned text is appended to the OpenCode prompt

### TTS pipeline

1. When the assistant finishes responding (or on manual trigger), the response
   text is sent to the LLM for speech normalization
2. The LLM decides how to handle it: narrate simple answers, summarize
   code-heavy responses, or briefly notify for confirmations
3. Piper synthesizes speech locally, piped through sox for playback

### Auto TTS

When enabled (`/tts-mode`), the plugin automatically speaks:

- Assistant responses when a session goes idle after work
- Permission requests
- Questions that need your answer

## Contributing

opencode-voice is open to contributions and ideas!

### Issue conventions

**Format:** `type: brief description`

- `feat:` new features or functionality
- `fix:` bug fixes
- `enhance:` improvements to existing features
- `chore:` maintenance tasks, dependencies, cleanup
- `docs:` documentation updates
- `build:` build system, CI/CD changes

### Development

```bash
npm run check        # lint + fmt
npm run lint         # oxlint
npm run fmt          # oxfmt --check
npm run fmt:fix      # oxfmt --write
```

### Release process

Manual releases via opencode; see [RELEASE_PROCESS.md](RELEASE_PROCESS.md).

## License

This project is licensed under the [MIT License](LICENSE).
