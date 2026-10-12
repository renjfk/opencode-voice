// TUI entrypoint for local (path-based) plugin loading.
//
// OpenCode V2 resolves the TUI entry of a local plugin directory by looking
// for a `tui` file (tui.ts/tui.tsx/tui.js) instead of the package.json
// "exports" field, which only applies to package-name targets. This file
// re-exports the implementation so both loading styles work.

export { default } from "./index.js";
