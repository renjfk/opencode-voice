# AGENTS.md - opencode-voice

Guidelines for AI agents working in this repository. Keep this file concise -
only document constraints and rules an agent would get wrong without being told.

## Architecture

Single TUI plugin exported from `index.js` with logic split into `lib/`.

## Key invariants

- Single TUI plugin via `Plugin.define` from `@opencode/plugin/tui`; `setup`
  returns a cleanup that detaches the data listeners. No server-side plugin.
- LLM calls use the OpenAI chat completions API, not the Anthropic messages API.
- Normalization (STT cleanup and TTS markdown conversion) goes through
  `createNormalizer` in `lib/normalize.js`; `normalizeModel` /
  `normalizeEndpoint` / `normalizeApiKeyEnv` can point it at a different model
  than the one answering, and `normalize: false` disables the pass entirely.
- Configuration uses `options` (static) and the storage-backed `api.kv`
  (runtime). No dotfile I/O.
- Auto TTS triggers on `session.execution.started` / `succeeded` /
  `interrupted` events and only speaks for the session the TUI is showing.
  V1's `session.status` / `session.idle` events have no producer in V2.
- Diagnostics go through `lib/logger.js`, which is a no-op unless
  `OPENCODE_VOICE_DEBUG` is set (V2 removed the `client.app.log` sink).
- No build step. Plain ESM JavaScript, shipped as-is.

## Scripts

```bash
npm run test         # node --test
npm run check        # lint + fmt
npm run lint         # oxlint .
npm run fmt          # oxfmt --check .
npm run fmt:fix      # oxfmt --write .
```

Verify changes: `npm run check` with zero errors.

CI runs on every PR and push to main (lint, test, build). See
RELEASE_PROCESS.md for release steps.

## Code style

- **ESM only** - `import`/`export`, `"type": "module"` in package.json
- **No build step** - no TypeScript, no bundler
- **Formatting** - enforced by oxfmt
- **Linting** - enforced by oxlint
