# opencode-voice

> **Speak your prompts. Hear your answers.** A voice plugin for [OpenCode](https://opencode.ai/) that turns your terminal into a hands-free coding companion.

**[Website and live demo → bojackduy.github.io/opencode-voice](https://bojackduy.github.io/opencode-voice/)**

[![CI](https://github.com/bojackduy/opencode-voice/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bojackduy/opencode-voice/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@bojackduy/opencode-voice)](https://www.npmjs.com/package/@bojackduy/opencode-voice)
[![Downloads](https://img.shields.io/npm/dm/@bojackduy/opencode-voice)](https://www.npmjs.com/package/@bojackduy/opencode-voice)
[![GitHub stars](https://img.shields.io/github/stars/bojackduy/opencode-voice)](https://github.com/bojackduy/opencode-voice)

![Demo: full voice workflow in OpenCode](assets/voice-demo-2.gif)

## What it does

- **Dictate prompts** with your voice — transcripts appear at your cursor as editable text, never auto-sent
- **Hear responses** spoken aloud with code-aware voices that understand camelCase, diagrams, and tables
- **Hands-free conversation mode** — speak, listen, speak again, no keyboard needed
- **Bilingual** Vietnamese + English in a single sentence (VieNeu-TTS)
- **Local-first** — audio never leaves your machine unless you choose
- **Works on OpenCode v1 and v2** — one package, both hosts

## Quick install

**Prerequisites:** [OpenCode](https://opencode.ai/) + `brew install whisper-cpp sox` (macOS) or see [full setup](docs/technical.md#prerequisites).

### OpenCode v2

Add to `~/.config/opencode/cli.json`:

```json
{
  "plugins": [
    {
      "package": "@bojackduy/opencode-voice",
      "options": {
        "endpoint": "https://api.anthropic.com/v1",
        "model": "claude-haiku-4-5",
        "apiKeyEnv": "ANTHROPIC_API_KEY"
      }
    }
  ]
}
```

### OpenCode v1

```json
{ "plugins": ["opencode-voice"] }
```

Then `npm i -g @bojackduy/opencode-voice` and configure via `tui.json`.

That's it. Press `Ctrl+X` then `[` to start recording.

## Features

| Feature                 | What you get                                                 |
| ----------------------- | ------------------------------------------------------------ |
| Streaming dictation     | Live waveform + live transcript above the prompt             |
| Code-aware TTS          | Piper, Chatterbox, or VieNeu — per-sentence language routing |
| Bilingual vi + en       | VieNeu-TTS code-switches in one utterance, 25 voices         |
| Hands-free conversation | Auto-silence finalize, auto-listen after reply, barge-in     |
| Local-first             | whisper-cpp + sox + Piper on your machine                    |
| Remote audio            | Use your phone as a mic over SSH                             |
| Playback controls       | Pause, rewind, forward, speed 0.75x–2x, replay               |
| 19 commands             | Palette + slash + leader keybinds on both hosts              |

## Commands

| Command               | What it does                                    |
| --------------------- | ----------------------------------------------- |
| `/stt-record`         | Start / stop recording + transcribe             |
| `/tts-speak`          | Read last response aloud                        |
| `/voice-conversation` | Toggle hands-free conversation mode             |
| `/tts-engine`         | Switch TTS engine (Piper / Chatterbox / VieNeu) |
| `/tts-vieneu-voice`   | Pick from 25 VieNeu voices                      |
| `/stt-mic`            | Choose microphone (local or remote)             |

Full command list: [technical docs](docs/technical.md#commands).

## Landing page

https://bojackduy.github.io/opencode-voice/

## Documentation

- [Technical setup & config](docs/technical.md) — prerequisites, install, env vars, commands reference
- [Product positioning](POSITIONING.md) — audience, differentiators, channels
- [Marketing & launch](MARKETING.md) — content calendar, launch drafts

## Support

- [GitHub Issues](https://github.com/bojackduy/opencode-voice/issues)
- [GitHub Sponsors](https://github.com/sponsors/bojackduy)

## License

AGPL-3.0-or-later — free to use, modify, and self-host.

---

_Keywords: opencode voice plugin, speech to text, text to speech, whisper, piper, tts, stt, terminal, local-first, bilingual, vietnamese, hands-free, dictation, voice coding_
EOF
echo "written"; wc -l README.md
