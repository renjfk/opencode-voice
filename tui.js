// OpenCode v2 TUI entrypoint (file probe, not package exports).
//
// WHY this file exists: v2 resolves a package's TUI entrypoint by probing
// for a literal `./tui` FILE inside the package directory
// (`resolve({directory})` → `path.resolve(directory, "tui")` in
// `@opencode/plugin`'s host mirror) — package.json `exports["./tui"]` alone
// is NOT consulted for path-form packages, so without this file v2 silently
// skips the package entirely (proven: `plugin list` empty before, listed
// after). v1 keeps loading via `exports["./tui"]` → `./index.js`, unchanged.
//
// Single core: this re-exports the same default object (with both `tui` for
// v1 and `setup` for v2) — each host reads its own key off the one module
// instance. See index.js, lib/boot.js, lib/v2-compat.js.
export { default } from "./index.js";
