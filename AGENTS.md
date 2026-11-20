# AGENTS.md - opencode-voice

Guidelines for AI agents working in this repository. Only constraints an agent
would get wrong without being told.

## Architecture

OpenCode v2 TUI plugin, strict TypeScript shipped as source (Bun runs it
inside OpenCode; no build step). `index.ts`/`tui.ts` re-export `src/entry.ts`.

- `src/plugin.ts` is the composition root: builds every module and wires them.
- `src/stt/session.ts` and `src/tts/session.ts` are the only state machines.
  Every async step checks its operation id; every path ends in `idle`.
- `src/ui/status.ts` renders one status line as a pure function of both
  machines (`statusSegments`).
- `src/host.ts` is the only place that touches the host `Context`.
- Leaf modules (`src/audio`, `src/stt/{whisper,streaming,transcript,...}`,
  `src/tts/{vieneu,piper,text}`, `src/llm`) take injectable `deps` and know
  nothing about the host.

## Key invariants

- Single default export `{ id, setup }` (v2 only).
- Shared contracts live in `src/types.ts`.
- `solid-js` / `@opentui/solid` are host-provided: import them with literal
  dynamic `import("...")` only (variable specifiers fail to resolve at runtime);
  their types are in `src/host-modules.d.ts`.
- Settings use the old kv keys in storage key `"opencode-voice"`; keep them.
- Never log transcript or speech text. Stored provider keys go only to their
  own provider; `x-opencode-session` only to opencode.ai hosts.

## Scripts

```bash
npm test             # bun test src
npm run check        # oxlint + oxfmt --check + tsc --noEmit
npm run fmt:fix      # oxfmt --write .
```

Verify changes: `npm run check` and `npm test`, zero errors. Tests use fakes in
`src/testing/fakes.ts`; never spawn real audio, binaries or network in tests.

See RELEASE_PROCESS.md for releases.
