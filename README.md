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

Add to your `tui.json` (create at `~/.config/opencode/tui.json` if it doesn't exist).
You must configure at least `endpoint` and `model`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "@renjfk/opencode-voice",
      {
        "endpoint": "https://api.anthropic.com/v1",
        "model": "claude-haiku-4-5",
        "apiKeyEnv": "ANTHROPIC_API_KEY"
      }
    ]
  ]
}
```

### Refresh cached plugin after updates

If OpenCode keeps using an older published version of the plugin after an
update, clear the cached package and restart OpenCode:

```bash
rm -rf ~/.cache/opencode/packages/@renjfk/
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

The `piper` executable must be located at `~/.local/bin/piper`. If installed in a different location, you can symlink it there instead:

```bash
ln -s $(which piper) ~/.local/bin/piper
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

Configure your endpoint in `tui.json` via plugin options. Any OpenAI-compatible
endpoint works (Anthropic, OpenAI, Ollama, vLLM, LM Studio, etc.). The `apiKeyEnv`
option is optional - omit it for unauthenticated endpoints like Ollama.

```json
{
  "plugin": [
    [
      "@renjfk/opencode-voice",
      {
        "endpoint": "https://api.anthropic.com/v1",
        "model": "claude-haiku-4-5",
        "apiKeyEnv": "ANTHROPIC_API_KEY"
      }
    ]
  ]
}
```

For unauthenticated local endpoints (e.g. Ollama):

```json
{
  "plugin": [
    [
      "@renjfk/opencode-voice",
      {
        "endpoint": "http://localhost:11434/v1",
        "model": "llama3.2"
      }
    ]
  ]
}
```

- `endpoint` _(required)_ - OpenAI-compatible base URL
- `model` _(required)_ - model name sent to `/chat/completions`
- `apiKeyEnv` _(optional)_ - environment variable containing the API key
- `maxTokens` _(optional)_ - maximum completion tokens for normalization calls
- `reasoningEffort` _(optional)_ - reasoning level for models that support it
- `chatTemplateKwargs` _(optional)_ - extra keyword arguments passed to the model's chat template (e.g. `{"enable_thinking": false}` for Qwen models to disable chain-of-thought)
- `retries` _(optional)_ - number of retry attempts for transient LLM failures

### Logging

The plugin writes diagnostics through OpenCode's structured app logger. If this plugin is not working with your setup, check the OpenCode log file and, optionally, enable debug mode. See the [OpenCode Docs](https://opencode.ai/docs/troubleshooting/#logs) for details.

Routine plugin diagnostics use `debug`; recoverable issues use `warn`; failed
child processes, API calls, or unexpected exceptions use `error`.

### STT API transcription (optional)

Instead of local `whisper-cli`, you can use an OpenAI-compatible speech-to-text
API (e.g. serving a Whisper model). This is useful when you want to run the
plugin on a machine without whisper-cpp installed.

```json
{
  "plugin": [
    [
      "@renjfk/opencode-voice",
      {
        "sttEndpoint": "http://127.0.0.1:8000/v1",
        "sttModel": "whisper-large-v3-turbo",
        "sttApiKeyEnv": "MY_STT_API_KEY"
      }
    ]
  ]
}
```

- `sttEndpoint` _(optional)_ - OpenAI-compatible base URL with `/audio/transcriptions` support
- `sttModel` _(optional)_ - whisper model name to pass to the API (default: `whisper-large-v3-turbo`). Can be changed at runtime via `/stt-model`, which fetches available whisper models from the endpoint's `/models` listing
- `sttApiKeyEnv` _(optional)_ - environment variable containing the API key

OpenRouter note: when `sttEndpoint` points at `https://openrouter.ai/api/v1`, the plugin automatically uses OpenRouter's JSON/base64 transcription request format instead of multipart upload.

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

- `sttPrompt` _(optional)_ - system prompt for cleaning up whisper transcriptions
- `ttsAutoPrompt` _(optional)_ - system prompt for auto-speaking assistant responses
- `ttsManualPrompt` _(optional)_ - system prompt for manually reading responses aloud

If a path is not set, the built-in default prompt is used.

## Commands

### Speech-to-text

| Command       | Keybind    | Description                            |
| ------------- | ---------- | -------------------------------------- |
| `/stt-record` | `ctrl+r`   | Start/stop recording + transcribe      |
| `/stt-submit` | `leader+r` | Stop recording, transcribe, and submit |
| `/stt-stop`   |            | Cancel recording                       |
| `/stt-model`  |            | Select whisper model                   |
| `/stt-mic`    |            | Select microphone                      |

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
2. `whisper-cli` transcribes locally using a ggml model, or an OpenAI-compatible
   API endpoint if `sttEndpoint` is configured
3. LLM normalizes the transcription: fixes punctuation, removes filler words,
   corrects software engineering homophones ("Jason" to "JSON", "bullion" to
   "boolean", etc.)
4. Cleaned text is appended to the OpenCode prompt, or submitted immediately
   when `/stt-submit` is used. If normalization fails (e.g. LLM endpoint
   unreachable), the raw transcription is used as a fallback so you never lose
   your input

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

### Test local plugin in OpenCode

To test unpublished changes in the OpenCode TUI, point `~/.config/opencode/tui.json`
at the local repo path, not the npm package name:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/Users/your-user/opencode-voice"]
}
```

### Optional macOS Hammerspoon integration

If you use macOS, [Hammerspoon](https://www.hammerspoon.org/), and
[Ghostty](https://ghostty.org/), see
[`examples/hammerspoon/ghostty-fn.lua`](examples/hammerspoon/ghostty-fn.lua)
for an optional global `Fn` key setup.

Behavior:

- Press `Fn` to send `ctrl+r` and start recording.
- Hold `Fn` for at least 0.5 seconds and release to send `leader+r`, which
  stops recording, normalizes, and submits the prompt.

Notes:

- It assumes OpenCode is using the default leader key, `ctrl+x`.
- It assumes OpenCode is running in Ghostty terminal `1`.
- It is best used as a push-to-talk flow: hold `Fn` while speaking, then
  release to submit.
- Adjust `APP_NAME`, `TARGET_TERMINAL`, and `LONG_PRESS_THRESHOLD_SECONDS` to
  fit your setup.

### Release process

Manual releases via opencode; see [RELEASE_PROCESS.md](RELEASE_PROCESS.md).

## License

This project is licensed under the [MIT License](LICENSE).
