// Configurable keybinds for the plugin commands.
//
// V2 keymaps take the binding from the command definition, so a user cannot
// remap a plugin command from cli.json. This resolves the bindings from plugin
// options instead, keeping the upstream defaults when nothing is configured.
//
// Options (plugin options in cli.json / opencode.json):
//   keybinds: {
//     record, submit, cancelRecording, mic,        // STT
//     speak, toggleTts, stopPlayback, voice        // TTS
//   }
// An empty string or "none" disables the binding for that command.

export const DEFAULT_KEYBINDS = {
  record: "ctrl+r",
  submit: "<leader>r",
  cancelRecording: "",
  mic: "",
  speak: "<leader>s",
  toggleTts: "<leader>v",
  stopPlayback: "escape",
  voice: "",
};

function normalizeBind(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") return "";
  return trimmed;
}

/**
 * Merge the `keybinds` plugin option over the defaults.
 *
 * @param {object} [options] - Plugin options
 * @returns {Record<keyof typeof DEFAULT_KEYBINDS, string>}
 */
export function resolveKeybinds(options) {
  const resolved = { ...DEFAULT_KEYBINDS };
  const overrides = options?.keybinds;
  if (!overrides || typeof overrides !== "object") return resolved;
  for (const key of Object.keys(DEFAULT_KEYBINDS)) {
    if (!(key in overrides)) continue;
    const bind = normalizeBind(overrides[key]);
    if (bind !== null) resolved[key] = bind;
  }
  return resolved;
}
