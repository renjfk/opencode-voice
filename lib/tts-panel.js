// TTS Control Panel — a TUI menu of clickable buttons.
//
// Implemented as a stack of api.ui.DialogSelect dialogs (opencode's
// built-in selectable list) so it works without any extra dependencies.
// Every option in the menu is a "button" the user can fire with arrow
// keys + enter, or filter by typing.
//
// The panel is stateful: opening it after toggling a setting reflects
// the new state because each option mutates `kv` and re-opens the
// panel with the updated header.

const ENGINE_LABELS = {
  piper: "Piper (local, free)",
  deepgram: "Deepgram Aura 2 (cloud)",
};

const VOICE_LABELS = {
  ryan: "Ryan (high)",
  bryce: "Bryce (medium)",
};

function statusHeader(kv) {
  const engine = kv.get("tts.engine", "piper");
  const mode = kv.get("tts.mode", "off");
  const chunked = kv.get("tts.chunked", "on");
  const voice = kv.get("tts.voice", "ryan");
  const bubbles = (kv.get("tts.bubbles", []) || []).length;

  return [
    `  Engine : ${ENGINE_LABELS[engine] || engine}`,
    `  Mode   : ${mode === "on" ? "AUTO (speak on every response)" : "manual (only when you ask)"}`,
    `  Bubbles: ${chunked === "on" ? "ON (WhatsApp-style chunks)" : "OFF (single blob)"}`,
    `  Voice  : ${VOICE_LABELS[voice] || voice}`,
    `  Stored : ${bubbles} bubble${bubbles === 1 ? "" : "s"}`,
  ].join("\n");
}

function speakAction(api, _kv) {
  return {
    title: "▶  Speak last response",
    description: "Synthesize the last assistant message right now (no auto-speak needed)",
    onSelect() {
      api.ui.dialog.clear();
      // Defer to the existing speakLastResponse path so we don't
      // duplicate the LLM normalization + chunking logic.
      api.command.trigger("tts.speak-last");
    },
  };
}

function stopAction(api, _kv) {
  return {
    title: "⏹  Stop playback",
    description: "Kill the current TTS process",
    onSelect() {
      api.ui.dialog.clear();
      api.command.trigger("tts.stop");
    },
  };
}

function toggleEngineAction(api, kv, openPanel) {
  const cur = kv.get("tts.engine", "piper");
  const next = cur === "piper" ? "deepgram" : "piper";
  return {
    title: `▣  Engine: ${ENGINE_LABELS[cur] || cur}  →  click to switch`,
    description: "Piper runs offline. Deepgram uses DEEPGRAM_API_KEY from env.",
    onSelect() {
      kv.set("tts.engine", next);
      api.ui.toast({
        message: `Engine: ${next === "deepgram" ? "Deepgram Aura 2" : "Piper (local)"}`,
        variant: "info",
      });
      openPanel();
    },
  };
}

function toggleModeAction(api, kv, openPanel) {
  const cur = kv.get("tts.mode", "off");
  const next = cur === "on" ? "off" : "on";
  return {
    title: `◉  Auto-speak: ${cur === "on" ? "ON" : "off (manual-only)"}  →  click to switch`,
    description:
      cur === "on"
        ? "Currently speaks on every session.idle. Toggle to save cycles."
        : "Currently manual-only. Toggle on if you want every response spoken.",
    onSelect() {
      kv.set("tts.mode", next);
      if (next === "off") api.command.trigger("tts.stop");
      api.ui.toast({
        message: next === "on" ? "Auto-speak on" : "Manual-only",
        variant: "info",
      });
      openPanel();
    },
  };
}

function toggleChunkedAction(api, kv, openPanel) {
  const cur = kv.get("tts.chunked", "on");
  const next = cur === "on" ? "off" : "on";
  return {
    title: `◐  Voice bubbles: ${cur === "on" ? "ON" : "OFF"}  →  click to switch`,
    description: "When ON, responses are split into short WhatsApp-style bubbles.",
    onSelect() {
      kv.set("tts.chunked", next);
      if (next === "off") api.command.trigger("tts.stop");
      api.ui.toast({
        message: next === "on" ? "Voice bubbles on" : "Voice bubbles off",
        variant: "info",
      });
      openPanel();
    },
  };
}

function toggleVoiceAction(api, kv, openPanel, voiceKeys, defaultVoice) {
  const cur = kv.get("tts.voice", defaultVoice);
  const idx = voiceKeys.indexOf(cur);
  const next = voiceKeys[(idx + 1) % voiceKeys.length] || defaultVoice;
  return {
    title: `🎙  Piper voice: ${VOICE_LABELS[cur] || cur}  →  click to cycle`,
    description: "Only used when engine=Piper. Cycles through the available voices.",
    onSelect() {
      kv.set("tts.voice", next);
      api.ui.toast({
        message: `Voice: ${VOICE_LABELS[next] || next}`,
        variant: "info",
      });
      openPanel();
    },
  };
}

function browseBubblesAction(api, kv) {
  return {
    title: "💬  Browse voice bubbles",
    description: "Open the last 50 bubbles (replay or clear)",
    onSelect() {
      api.ui.dialog.clear();
      api.command.trigger("tts.bubbles");
    },
  };
}

function clearBubblesAction(api, kv, openPanel) {
  return {
    title: "🗑  Clear voice bubbles",
    description: "Erase the bubble history",
    onSelect() {
      const list = kv.get("tts.bubbles", []) || [];
      kv.set("tts.bubbles", []);
      api.ui.toast({
        message: `Cleared ${list.length} bubble${list.length === 1 ? "" : "s"}`,
        variant: "info",
      });
      openPanel();
    },
  };
}

function closeAction(api) {
  return {
    title: "✕  Close panel",
    description: "Dismiss the TTS control panel",
    onSelect() {
      api.ui.dialog.clear();
    },
  };
}

/**
 * Open the TTS Control Panel. Re-entrant: each action that mutates
 * state re-calls this so the menu re-opens with fresh status.
 */
export function openTtsPanel(api, kv, deps) {
  const voiceKeys = Object.keys(deps.TTS_VOICES);
  const defaultVoice = deps.DEFAULT_TTS_VOICE;
  const open = () => openTtsPanel(api, kv, deps);

  const options = [
    speakAction(api, kv),
    stopAction(api, kv),
    toggleEngineAction(api, kv, open),
    toggleModeAction(api, kv, open),
    toggleChunkedAction(api, kv, open),
    toggleVoiceAction(api, kv, open, voiceKeys, defaultVoice),
    browseBubblesAction(api, kv),
    clearBubblesAction(api, kv, open),
    closeAction(api),
  ];

  api.ui.dialog.replace(
    () =>
      api.ui.DialogSelect({
        title: `TTS Control Panel\n${statusHeader(kv)}`,
        current: options[0].title,
        options: options.map((o) => ({
          title: o.title,
          description: o.description,
          onSelect: o.onSelect,
        })),
      }),
    () => api.ui.dialog.clear(),
  );
}
