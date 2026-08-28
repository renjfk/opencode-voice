[![CI](https://github.com/renjfk/opencode-voice/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/renjfk/opencode-voice/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@renjfk/opencode-voice)](https://www.npmjs.com/package/@renjfk/opencode-voice)
[![Downloads](https://img.shields.io/npm/dm/@renjfk/opencode-voice)](https://www.npmjs.com/package/@renjfk/opencode-voice)

# opencode-voice

Speech-to-text and text-to-speech plugin for [OpenCode](https://opencode.ai/).

Record voice prompts with local whisper transcription, hear assistant responses
spoken aloud via Piper TTS. An LLM can optionally normalize text for natural
speech (fixing homophones, splitting camelCase identifiers, summarizing
code-heavy responses, etc.). Speech-to-text works without an LLM: raw whisper
transcription is used directly when no `endpoint`/`model` is configured.

## Install

Add to your `tui.json` (create at `~/.config/opencode/tui.json` if it doesn't
exist). An LLM `endpoint` and `model` are optional and only needed for text
normalization. For speech-to-text alone you can enable the plugin with an empty
config (or just `sttLanguage`):

> [!NOTE]
> **Clobbering default keybinds.** This plugin uses `ctrl+r` for voice
> recording, but OpenCode assigns it to session rename by default. Session
> rename is not used frequently and is still accessible via `/rename`, so we
> clobber the factory default to let the plugin use `ctrl+r` properly. See
> the `keybinds` section in the config below.

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "keybinds": {
    "session_rename": "none"
  },
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

The plugin uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp) via a
`whisper-cli` binary and `sox` for microphone capture. Follow the subsection
for your OS to install the binary and verify your microphone, then run the
shared **Download model & smoke test** step at the end.

#### macOS

Install the `whisper-cpp` bottle (ships a `whisper-cli` with Metal enabled on
Apple Silicon) and `sox`:

```bash
brew install whisper-cpp sox
```

Verify your microphone by recording a 3-second clip and playing it back. The
first `sox -d` invocation triggers a macOS microphone permission prompt —
grant it in **System Settings → Privacy & Security → Microphone**, then rerun.
Remove the temp file once you've heard yourself clearly:

```bash
sox -d /tmp/mic-check.wav trim 0 3   # speak for 3 seconds
play /tmp/mic-check.wav              # you should hear yourself
rm /tmp/mic-check.wav                # delete after verification
```

#### Linux (including WSL2)

Install `sox` with its PulseAudio driver (a separate package on Debian/Ubuntu),
the PulseAudio tools so the plugin can enumerate input devices via `pactl`,
and the build tools for whisper.cpp:

```bash
sudo apt install sox libsox-fmt-pulse pulseaudio-utils build-essential cmake
```

On WSL2, make sure [WSLg](https://learn.microsoft.com/windows/wsl/tutorials/gui-apps)
is running — it bridges the Windows microphone into WSL as a PulseAudio source
(typically named `RDPSource`), which you can then pick with `/stt-mic`.

**WSL2 audio troubleshooting.** There is no `/dev/snd` in WSL2 — that is
normal. Audio goes through WSLg's PulseAudio server at `/mnt/wslg/PulseServer`,
so ALSA-only tools like `arecord -l` will never list a device. If `/stt-mic`
finds no devices or `pactl info` fails with `Connection refused`, WSLg's
PulseAudio is stuck; fix it from Windows PowerShell:

```powershell
wsl --shutdown   # then reopen Ubuntu (closes all WSL sessions)
```

If the source list is still empty after a restart, check Windows
**Settings → Privacy & security → Microphone** and enable both "Microphone
access" and "Let desktop apps access your microphone" (WSLg captures audio via
a desktop RDP client), then run `wsl --update` for the latest WSLg.

Verify your microphone by recording a 3-second clip and playing it back.
Remove the temp file once you've heard yourself clearly; skip building
whisper.cpp until this works, otherwise `/stt-mic` will have nothing to select:

```bash
sox -d /tmp/mic-check.wav trim 0 3   # speak for 3 seconds
play /tmp/mic-check.wav              # you should hear yourself
rm /tmp/mic-check.wav                # delete after verification
```

`whisper-cli` is not packaged for Linux, so build whisper.cpp from source.
Pick **one** of the two builds below.

**CPU build** — works on any machine, adequate for `tiny`/`base`/`small`
models:

```bash
git clone https://github.com/ggml-org/whisper.cpp ~/opt/whisper.cpp
cmake -B ~/opt/whisper.cpp/build -S ~/opt/whisper.cpp \
  -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF
cmake --build ~/opt/whisper.cpp/build -j --target whisper-cli
sudo ln -sf ~/opt/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
```

**CUDA build** — NVIDIA GPU, ~100× faster encode for `medium`/`large` models.
Check your GPU with `nvidia-smi` and your toolkit with `nvcc --version`, then
pick the arch code from the table:

| GPU family    | Arch      | `CMAKE_CUDA_ARCHITECTURES` | Min. CUDA |
| ------------- | --------- | -------------------------- | --------- |
| RTX 20 / T4   | Turing    | `75`                       | 10.0      |
| RTX 30 / A100 | Ampere    | `86`                       | 11.0      |
| RTX 40 / L40  | Ada       | `89`                       | 11.8      |
| H100          | Hopper    | `90`                       | 12.0      |
| RTX 50 / B100 | Blackwell | `120`                      | 13.0      |

```bash
git clone https://github.com/ggml-org/whisper.cpp ~/opt/whisper.cpp
cmake -B ~/opt/whisper.cpp/build -S ~/opt/whisper.cpp \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_CUDA=ON \
  -DCMAKE_CUDA_ARCHITECTURES=89 \
  -DWHISPER_BUILD_TESTS=OFF
cmake --build ~/opt/whisper.cpp/build -j --target whisper-cli
sudo ln -sf ~/opt/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
```

If you have multiple CUDA toolkits installed (e.g. Blackwell requires CUDA 13
while the default `nvcc` is 12), also pass `-DCMAKE_CUDA_COMPILER=/usr/local/cuda-13.3/bin/nvcc`
to point at the matching `nvcc`. CUDA runtime libraries are resolved via
ldconfig; no `LD_LIBRARY_PATH` is needed.

At runtime the plugin records through sox's `pulseaudio` driver when `pactl`
is available, and falls back to sox's default device otherwise.

#### Download model & smoke test

Download a whisper model to `~/.local/share/whisper-cpp/` (same path on both
OSes):

```bash
mkdir -p ~/.local/share/whisper-cpp
curl -L -o ~/.local/share/whisper-cpp/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```

Smoke-test the install by transcribing a short recording:

```bash
sox -d /tmp/smoke.wav trim 0 4   # say something for 4 seconds
whisper-cli -m ~/.local/share/whisper-cpp/ggml-large-v3-turbo-q5_0.bin \
  -f /tmp/smoke.wav -l auto -nt
rm /tmp/smoke.wav
```

Check the first `system_info:` line in the output to confirm the expected
backend is active:

| Install                        | Expect                  |
| ------------------------------ | ----------------------- |
| macOS Homebrew (Apple Silicon) | `METAL = 1`             |
| Linux CUDA build               | `CUDA : ARCHS = <n>`    |
| CPU-only                       | `METAL = 0` / no `CUDA` |

Reference `encode time` on a 4-second clip: CPU `medium` ≈ 15–30 s; CUDA
`medium` ≈ 100–200 ms; CUDA `large-v3-turbo` ≈ 100–300 ms. Apple Silicon
Metal timings are hardware-dependent but typically sub-second. If your GPU
build shows CPU-level timings, the GPU backend failed to load — on Linux,
re-check `nvidia-smi` and rebuild with the arch code from the table above.

### Text-to-speech

Install [Piper](https://github.com/rhasspy/piper):

```bash
uv tool install piper-tts
```

Or with pip:

```bash
pip install piper-tts
```

The plugin looks for `piper` on your `PATH` (`~/.local/bin` is typically on `PATH`).

Download a voice model to `~/.local/share/piper-voices/`:

```bash
mkdir -p ~/.local/share/piper-voices
curl -L -o ~/.local/share/piper-voices/en_US-ryan-high.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx
curl -L -o ~/.local/share/piper-voices/en_US-ryan-high.onnx.json \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx.json
```

### LLM endpoint

An OpenAI-compatible LLM endpoint is optional. When configured it normalizes
text: for speech-to-text it cleans up whisper output (punctuation, filler words,
software engineering homophones); for text-to-speech it converts markdown into
natural spoken text. Without `endpoint`/`model`, speech-to-text still works and
uses the raw whisper transcription directly. Text-to-speech requires the LLM
endpoint and reports unavailability if it is not configured.

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

- `endpoint` _(optional)_ - OpenAI-compatible base URL. Required together with `model` for LLM normalization.
- `model` _(optional)_ - model name sent to `/chat/completions`. Required together with `endpoint` for LLM normalization.
- `apiKeyEnv` _(optional)_ - environment variable containing the API key
- `maxTokens` _(optional)_ - maximum completion tokens for normalization calls
- `reasoningEffort` _(optional)_ - reasoning level for models that support it
- `chatTemplateKwargs` _(optional)_ - extra keyword arguments passed to the model's chat template (e.g. `{"enable_thinking": false}` for Qwen models to disable chain-of-thought)
- `retries` _(optional)_ - number of retry attempts for transient LLM failures
- `tmpDir` _(optional)_ - directory used for the temporary STT recording file (default `/tmp`)
- `sttLanguage` _(optional)_ - spoken language passed to local `whisper-cli -l` (default `auto`; any whisper.cpp language code, e.g. `en`, `zh`). Can be changed at runtime via `/stt-language`
- `trimSilence` _(optional)_ - whether to remove leading silence from recordings (default `true`). Set to `false` if your recordings are missing the first word or syllable

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

| Command         | Keybind    | Description                            |
| --------------- | ---------- | -------------------------------------- |
| `/stt-record`   | `ctrl+r`   | Start/stop recording + transcribe      |
| `/stt-submit`   | `leader+r` | Stop recording, transcribe, and submit |
| `/stt-stop`     |            | Cancel recording                       |
| `/stt-model`    |            | Select whisper model                   |
| `/stt-language` |            | Select transcription language          |
| `/stt-mic`      |            | Select microphone                      |

`/stt-mic` lists CoreAudio input devices on macOS, and PulseAudio sources on
Linux (via `pactl`, monitor sources excluded). On systems without a supported
device listing, "System default" uses sox's default device (`sox -d`).

`/stt-language` offers a curated list of common languages (plus auto-detect)
and only affects local `whisper-cli` transcription, not the STT API. Languages
outside the list can be set via the `sttLanguage` plugin option.

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

1. `sox` records audio from your microphone (CoreAudio on macOS, PulseAudio on
   Linux when `pactl` is available, sox default device otherwise)
2. `whisper-cli` transcribes locally using a ggml model, or an OpenAI-compatible
   API endpoint if `sttEndpoint` is configured
3. If an LLM `endpoint`/`model` is configured, it normalizes the transcription:
   fixes punctuation, removes filler words, corrects software engineering
   homophones ("Jason" to "JSON", "bullion" to "boolean", etc.). Without an LLM,
   the raw transcription is used directly
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
