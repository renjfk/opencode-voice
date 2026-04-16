# AGENTS.md - opencode-voice

Guidelines for AI agents working in this repository. Keep this file concise -
only document constraints and rules an agent would get wrong without being told.

## Project overview

**opencode-voice** is an OpenCode TUI plugin that adds speech-to-text and
text-to-speech to the terminal. Records audio via sox, transcribes with
whisper-cpp, normalizes with an OpenAI-compatible LLM, and speaks responses
via Piper TTS.

## Architecture

Single TUI plugin exported from `index.js`, with logic split into three
internal modules under `lib/`.

- `index.js` - entry point, registers all commands from STT + TTS + LLM config
- `lib/stt.js` - sox recording, whisper-cpp transcription, LLM normalization
- `lib/tts.js` - Piper/sox audio pipeline, auto/manual speech, event handlers
- `lib/llm-client.js` - OpenAI-compatible completion client (`createClient(kv, options)`)

### Key invariants

- Single default export: `{ id, tui }`. OpenCode's TUI loader requires this shape.
- No server-side plugin. The `server` property must never be added.
- `registerSTT(api, kv, complete)` and `registerTTS(api, kv, complete)` return
  command arrays. TTS also registers event handlers via `api.event.on()` as a side effect.
- LLM calls use the OpenAI chat completions API, not the Anthropic messages API.
  This keeps the client provider-agnostic.
- Configuration uses two mechanisms:
  - **`options`** (from `tui.json` plugin tuple) for static LLM endpoint config
  - **`api.kv`** for runtime state (whisper model, mic, TTS mode, voice, LLM preset overrides)
- No dotfile I/O for config. All persistence goes through `api.kv`.
- No build step. Plain ESM JavaScript, shipped as-is.

## Scripts

```bash
npm run check        # lint + fmt
npm run lint         # oxlint .
npm run fmt          # oxfmt --check .
npm run fmt:fix      # oxfmt --write .
```

Verify changes: `npm run check` with zero errors.

CI runs on every PR and push to main (lint, build). Releases are manual
dispatch via `gh workflow run release.yml`.

## Code style

- **ESM only** - `import`/`export`, `"type": "module"` in package.json
- **No dependencies** - only peer dep on `@opencode-ai/plugin`
- **No build step** - no TypeScript, no bundler
- **Formatting** - enforced by oxfmt
- **Linting** - enforced by oxlint
