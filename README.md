# opencode-voice

> **Speak your prompts. Hear your answers.** A voice plugin for [OpenCode](https://opencode.ai/) v2.

[![CI](https://github.com/bojackduy/opencode-voice/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bojackduy/opencode-voice/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@bojackduy/opencode-voice)](https://www.npmjs.com/package/@bojackduy/opencode-voice)

![Demo: voice workflow in OpenCode](assets/voice-demo-2.gif)

## What it does

- **Dictate** into the focused text field — **live** (words appear while you speak) or **batch** (speak, then transcribe).
- **Mac or phone mic** — local sox capture, or a phone over USB/ssh (Termux) with automatic `adb forward`.
- **Clean-up** with any OpenCode model (fixes misheard words, punctuation), or exact whisper text.
- **Fix** — press Fix and say the correction ("fix, not fit"); the LLM merges it into the current text.
- **Read replies aloud** in natural Vietnamese and English with [VieNeu-TTS](https://github.com/pnnbao97/VieNeu-TTS); Piper takes over automatically if VieNeu is unavailable. Mac speakers or the phone.
- **One status line** above the prompt shows exactly what is happening, with clickable buttons:

```
● LIVE 0:07 ▃▅▄ [⏸ Pause] [■ Done] [✕ Cancel] │ ♪ 0:05/0:12 [«5] [⏸] [5»] [1.25x] [■]
[● Speak] [✎ Fix] [⏹ Auto-stop ✓] [⏎ Auto-send ✓] [Live] [turbo] │ [▶ Reply] [↺] [1x] [Read ✓]
```

## Install

Prerequisites (macOS): `brew install sox whisper-cpp`, a ggml whisper model in
`~/.local/share/whisper-cpp/` (e.g. `ggml-large-v3-turbo-q5_0.bin`), and for
speech: Piper on `PATH` with voices in `~/.local/share/piper-voices/`, plus an
optional VieNeu-TTS Python venv. See [docs/technical.md](docs/technical.md).

Add to `~/.config/opencode/cli.json` (OpenCode v2 reads plugins only from
`cli.json` → `plugins`; entries in `tui.jsonc` are ignored):

```json
{
  "plugins": [
    {
      "package": "@bojackduy/opencode-voice",
      "options": {
        "sttMode": "streaming",
        "sttAutoSubmit": false,
        "ttsEngine": "vieneu",
        "ttsVieneuPython": "~/.local/share/opencode-voice/vieneu-venv/bin/python",
        "ttsVieneuVoice": "Mai Anh"
      }
    }
  ]
}
```

For a local checkout use `"package": "file:/path/to/opencode-voice"`. Restart
OpenCode after changing the config.

The clean-up / Fix LLM defaults to the session's current model; pick another
with `/voice-model`, or set `endpoint` + `model` + `apiKeyEnv` explicitly.

## Voice follows you across machines (voice node)

Run OpenCode on any machine in your Tailscale network and speak/listen on
**whichever device you are using right now** — this Mac, a Linux box, or an
Android phone (Termux). Transcription (whisper) and speech (VieNeu/Piper) run
once, on the strongest machine (the _engine host_).

```
OpenCode on duy ──┐                       ┌── mic + speaker: Mac
OpenCode on Mac ──┼─ text ─▶ voice node ◀─┼── mic + speaker: duy-1 (Linux, PipeWire)
OpenCode on ... ──┘    (engine host: Mac) └── mic + speaker: Phone (Termux, USB or Tailscale)
```

- **Follow me**: audio goes to the device with the most recent keyboard,
  mouse or touch activity (a phone only counts while Termux is on screen —
  Android blocks the mic for background apps). Devices without a working
  mic/speaker are skipped. Pin a device with the status-line button
  (`[🎙 Mac]` / `[📌 Phone]`) or `/voice-device`.
- One dictation at a time across all machines ("Microphone is in use by
  duy:opencode"); replies from any machine play on the same speaker.
- The node only listens on loopback and your Tailscale IP and only accepts
  peers of your own tailnet account (`tailscale whois`).

Setup on the engine host (plugin option `"voiceNode": "host"` starts the node
automatically and restarts it if it dies):

`~/.config/opencode-voice/node.json`

```json
{
  "devices": [
    { "id": "mac", "label": "Mac", "kind": "local" },
    {
      "id": "phone",
      "label": "Phone",
      "kind": "termux",
      "ssh": "phone-usb",
      "adb": "SERIAL",
      "adbForwardPort": 8022
    },
    { "id": "duy-1", "label": "duy-1", "kind": "linux", "ssh": "duy-1" }
  ],
  "vieneuVoice": "Mai Anh"
}
```

`ssh` names are hosts in `~/.config/opencode-voice/ssh_config` (key-based,
non-interactive). Linux devices need PipeWire/PulseAudio (`pw-cat`, `pacat`);
the phone needs Termux with `openssh`, `sox`, `ffmpeg` and Termux:API. On the
other machines just add the plugin with `"voiceNode": "auto"` (the default):
it finds the node on the tailnet. See [docs/technical.md](docs/technical.md#voice-node).

## Keys and commands

| Key                       | Command                                   | What it does                                                 |
| ------------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| `<leader>[`               | `/stt`                                    | Start dictation; press again to finish (resumes when paused) |
| —                         | `/stt-fix`                                | Re-speak to correct the current text                         |
| —                         | `/stt-pause`                              | Pause / resume live dictation                                |
| `<leader>.`               | `/voice-cancel`                           | Cancel everything in flight                                  |
| `<leader>]`               | `/tts-speak`                              | Read the last reply; press again to stop                     |
| `<leader>0`               | `/tts-replay`                             | Replay the last reading                                      |
| `<leader>-` / `<leader>=` | `/tts-rewind`, `/tts-forward`             | Back / forward 5 s (also across parts)                       |
| —                         | `/tts-faster`, `/tts-slower`, `/tts-rate` | Reading speed 0.75x–2x, voice pitch kept (saved)             |
| —                         | `/tts-pause`, `/tts-stop`                 | Pause / stop reading                                         |

Click `[1x]` on the status line to cycle the speed, `[«5]` / `[5»]` to skip,
`[Live]` to switch live/batch, and the engine button (`[turbo]`) to pick the
transcription engine and whisper model.

Settings (persisted): `/stt-mode` (live/batch), `/stt-autosubmit`,
`/stt-auto-end` (finish after 2.5 s of silence), `/stt-normalize`,
`/stt-language`, `/stt-model`, `/stt-engine`, `/stt-mic`, `/tts-mode`
(auto-read replies), `/tts-engine`, `/tts-voice`, `/tts-output`,
`/voice-model`, `/voice-device` (follow me / pin a device), and `/voice-status`
for diagnostics.

Override keys with `"keybinds": { "stt.record": "ctrl+r", "tts.speak-last": "none" }`.

## Options

| Option                                       | Default                | Meaning                                                                                                                            |
| -------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `sttMode`                                    | `"batch"`              | `"streaming"` (live) or `"batch"`                                                                                                  |
| `sttAutoSubmit`                              | `false`                | Send the prompt right after dictation                                                                                              |
| `sttLanguage`                                | `"auto"`               | `"auto"`, `"vi"`, `"en"`                                                                                                           |
| `sttModel`                                   | auto                   | Path to a ggml whisper model                                                                                                       |
| `sttCaptureCmd`                              | —                      | Phone mic argv, must print raw s16le mono PCM (e.g. `["ssh", "-p", "8022", "u0_a368@localhost", "$HOME/bin/capture.sh", "16000"]`) |
| `sttEndpoint`, `sttApiModel`, `sttApiKeyEnv` | —                      | Optional OpenAI-compatible transcription API                                                                                       |
| `audioSampleRate`                            | `16000`                | Capture rate                                                                                                                       |
| `ttsEngine`                                  | `"vieneu"`             | `"vieneu"` or `"piper"`                                                                                                            |
| `ttsVieneuPython`, `ttsVieneuVoice`          | venv path, `"Mai Anh"` | VieNeu sidecar                                                                                                                     |
| `ttsPlayCmd`                                 | —                      | Phone speaker argv, reads raw PCM on stdin                                                                                         |
| `endpoint`, `model`, `apiKeyEnv`             | session model          | LLM for clean-up and Fix                                                                                                           |
| `sttPrompt`, `ttsPrompt`                     | built-in               | Override the system prompts (text)                                                                                                 |

## Privacy

Audio stays on your machine unless you configure an API transcriber or a
phone. Only the transcript is sent to the LLM for clean-up (turn it off with
`/stt-normalize`). Stored OpenCode keys are only sent to their own provider.
The diagnostic log (`~/.cache/opencode-voice/voice.log`, mode 0600) never
contains transcript text.

## Changes in 2.0

Rewritten in TypeScript around two small state machines (dictation, speech)
and one status line. Conversation mode, live notes, Kokoro, Chatterbox,
and Gipformer were removed (reading speed and ±5 s skip are back since 2.0.2). OpenCode v1 is no longer
supported. Existing settings carry over.

## License

AGPL-3.0-or-later
