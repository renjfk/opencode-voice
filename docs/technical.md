# opencode-voice — technical guide

## Prerequisites

### Speech-to-text

macOS:

```bash
brew install sox whisper-cpp
sox -d /tmp/mic-check.wav trim 0 3 && play /tmp/mic-check.wav && rm /tmp/mic-check.wav
```

The first `sox -d` triggers the macOS microphone permission prompt (System
Settings → Privacy & Security → Microphone).

Linux / WSL2: `sudo apt install sox libsox-fmt-pulse pulseaudio-utils`, then
build whisper.cpp (`whisper-server` and `whisper-cli` targets) and put the
binaries on `PATH`. On WSL2 the Windows mic arrives through WSLg's PulseAudio;
`wsl --shutdown` fixes a stuck PulseAudio.

Download a model (the plugin prefers large-v3-turbo):

```bash
mkdir -p ~/.local/share/whisper-cpp
curl -L -o ~/.local/share/whisper-cpp/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```

### Text-to-speech

Piper (fallback, and the engine for `/tts-engine piper`):

```bash
uv tool install piper-tts
mkdir -p ~/.local/share/piper-voices && cd ~/.local/share/piper-voices
base=https://huggingface.co/rhasspy/piper-voices/resolve/main
for f in en/en_US/ryan/high/en_US-ryan-high vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium; do
  curl -LO "$base/$f.onnx"; curl -LO "$base/$f.onnx.json"
done
```

VieNeu-TTS (natural Vietnamese + English, default engine):

```bash
python3 -m venv ~/.local/share/opencode-voice/vieneu-venv
~/.local/share/opencode-voice/vieneu-venv/bin/pip install vieneu
```

The plugin starts the VieNeu server itself (`src/tts/vieneu_server.py`) on the
first free port from 8000, in a private working directory. The first start
downloads and loads the model (about 10 s once cached). If it fails, the
reason is shown once and Piper reads for the next two minutes while VieNeu
retries in the background.

### Phone mic and speaker (optional)

With Termux + `openssh` on an Android phone, set

```jsonc
"sttCaptureCmd": ["ssh", "-p", "8022", "u0_a368@localhost", "$HOME/bin/capture.sh", "16000"],
"ttsPlayCmd": ["ssh", "-p", "8022", "u0_a368@localhost", "$HOME/bin/playback.sh", "16000"]
```

`capture.sh RATE` must print raw signed 16-bit mono PCM at RATE to stdout;
`playback.sh RATE` must play the same format from stdin. When the ssh target
is `localhost`/`127.0.0.1`, the plugin runs `adb forward tcp:PORT tcp:PORT`
for the single attached physical device first. Pick the phone with `/stt-mic`
and `/tts-output`. If ssh exits with 255 the status says so and suggests
checking the cable, the forward, and `sshd` in Termux.

## LLM

Clean-up (`/stt-normalize`), Fix and reply preparation use, in order: explicit
`endpoint` + `model` options, the `/voice-model` selection, or the session's
current model. Keys come from `apiKey`/`apiKeyEnv` for explicit endpoints;
for OpenCode providers from the provider's env vars or an `api`-type entry in
OpenCode's `auth.json` (OAuth tokens are never used, and a stored key is only
sent to its own provider). Calls time out (20 s clean-up, 30 s Fix, 15 s
replies) and fall back to the raw text.

## How it works

```
key / button ─▶ stt/session.ts ──▶ audio/mic.ts (sox | ssh)
                   │ batch:  PCM ─▶ stt/long.ts ─▶ whisper-server
                   │ live:   stt/streaming.ts (1 s ticks over a 10 s window,
                   │         transcript.ts joins windows, final full decode)
                   ├─▶ llm (clean-up / Fix merge)
                   └─▶ stt/editor.ts (insert / live span / replace) ─▶ submit?

reply ─▶ tts/session.ts ─▶ tts/text.ts (markdown → speech, vi/en parts)
           └─▶ vieneu.ts (fallback piper.ts), next part prefetched ─▶ audio/player.ts
```

- Each machine has one operation id. Cancel, a newer start, or a stop bumps
  it; late results are dropped, and every path ends in `idle` with a result
  shown on the status line.
- Live dictation writes into the focused field in place. If you edit the
  field meanwhile, the plugin stops touching it.
- Pause drops incoming audio but keeps the capture running, so a phone mic
  never replays paused speech.
- The whisper server is shared by batch and live dictation and released after
  10 idle minutes; VieNeu stays warm while auto-read is on.
- Speed uses `sox tempo -s` locally and `ffmpeg atempo` for the phone, so the
  voice keeps its pitch; changing speed or skipping respawns the player at the
  current position. Skipping back past the start of a part continues in the
  previous part.
- Auto-read speaks a reply once, only in the TUI showing that session, and
  waits while you are dictating.

## Logs

`~/.cache/opencode-voice/voice.log` (mode 0600, rotated at 1 MB). It records
steps, timings and errors, never transcript or reply text. `/voice-status`
shows the current configuration.

## Development

```bash
npm install
npm test          # bun test src (fakes only, no audio or network)
npm run check     # lint + format + typecheck
```
