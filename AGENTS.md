# AGENTS.md - opencode-voice

Guidelines for AI agents working in this repository. Keep this file concise -
only document constraints and rules an agent would get wrong without being told.

## Architecture

Single OpenCode V2 CLI plugin exported from `index.js` with logic split into `lib/`.

## Key invariants

- Single default export: `Plugin.define({ id, setup })` from `@opencode/plugin/tui`. No server-side plugin.
- The host provides `@opencode/plugin/tui` at runtime; never add it as a runtime dependency.
- LLM calls use the OpenAI chat completions API, not the Anthropic messages API.
- Configuration uses `context.options` (static) and `context.storage` (runtime, wrapped by `lib/kv.js`). No dotfile I/O.
- V2 does not expose the prompt composer to plugins; STT sends prompts via `context.client.session.prompt`. Do not reintroduce `tui.appendPrompt`/`api.command.register` (V1 APIs).
- Voice features need `submitOnStop: true` for hands-free sending; the default opens an edit dialog instead.
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
