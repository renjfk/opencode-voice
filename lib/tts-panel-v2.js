// TTS Control Panel — WhatsApp-style voice feed.
//
// Renders a full TUI screen via @opentui/solid components (box, text,
// select, ascii_font). The screen is a vertical stack of:
//   1. A big ASCII header showing the current TTS state.
//   2. An action bar with the 4 toggles (engine, mode, bubbles, voice).
//   3. A scrollable feed of voice bubbles, each rendered as a rounded
//      "card" with timestamp, ASCII waveform, duration, and a "▶ Play"
//      select that re-synthesizes the bubble.
//   4. A "Speak last response" button and a "Close" button at the bottom.
//
// Why factory functions instead of JSX? opencode-voice is plain ESM
// JS, and JSX requires a build step the plugin does not have. Solid
// components work as plain function calls: `box({...})` instead of
// `<box>...</box>`. Same reactivity (createSignal, For, Show).
//
// The whole render is re-evaluated when any piece of state changes,
// so toggling a setting from the action bar immediately re-renders
// the bubbles list and the header.

import { getComponentCatalogue, createElement } from "@opentui/solid";
import { createSignal, For, Show } from "solid-js";

const CATALOG = (() => {
  try {
    return getComponentCatalogue();
  } catch {
    return {};
  }
})();

const { box, text, ascii_font, select, scrollbox } = CATALOG;

// h(component, props, ...children) is what JSX desugars to. We call it
// explicitly because opencode-voice is plain ESM JS with no JSX
// transform; the host provides the Solid root when it calls our
// render() function via api.ui.dialog.replace.
function h(component, props, ...children) {
  if (!component) return null;
  return createElement(component, props, ...children);
}

const ENGINE_LABELS = {
  piper: "Piper (local)",
  deepgram: "Deepgram Aura 2",
};

const VOICE_LABELS = {
  ryan: "Ryan (high)",
  bryce: "Bryce (medium)",
};

const WAVEFORM_BARS = "▁▂▃▄▅▆▇█";

function waveformFor(text, length = 20) {
  // Deterministic pseudo-waveform from the text's char codes. Real audio
  // amplitude would need a PCM peak reader; this is a visual stand-in
  // that looks like a real voice bar and is stable for the same text.
  const out = [];
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    out.push(WAVEFORM_BARS[seed % WAVEFORM_BARS.length]);
  }
  return out.join("");
}

function formatTime(ts) {
  return new Date(ts).toISOString().slice(11, 16);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Render the WhatsApp-style TTS control panel.
 *
 * @param {object} api     opencode TUI plugin api
 * @param {object} kv      plugin key-value store
 * @param {object} actions { speak, speakBubble, stop, toggleEngine, toggleMode, toggleChunked, toggleVoice, clearBubbles, close }
 */
export function renderTtsPanelV2(api, kv, actions) {
  const [tick, setTick] = createSignal(0);
  const [status, setStatus] = createSignal("");

  function rerender(msg) {
    if (msg) setStatus(msg);
    setTick(tick() + 1);
  }

  function bubbles() {
    return kv.get("tts.bubbles", []) || [];
  }

  function headerLine() {
    const engine = kv.get("tts.engine", "piper");
    const mode = kv.get("tts.mode", "off");
    const chunked = kv.get("tts.chunked", "on");
    const voice = kv.get("tts.voice", "ryan");
    return `engine=${engine}  mode=${mode}  bubbles=${chunked}  voice=${voice}  stored=${bubbles().length}`;
  }

  return h(
    box,
    {
      flexDirection: "column",
      width: 70,
      paddingLeft: 1,
      paddingRight: 1,
      gap: 0,
    },

    // Header
    h(ascii_font, { text: "TTS", font: "block" }),
    h(text, {
      content: () =>
        `Voice Control Panel  •  ${ENGINE_LABELS[kv.get("tts.engine", "piper")] || kv.get("tts.engine", "piper")}`,
      bold: true,
    }),
    h(text, { content: () => headerLine(), dim: true }),
    h(text, { content: () => (status() ? `  ▸ ${status()}` : ""), dim: true }),
    h(text, { content: "" }),

    // Action bar
    h(
      box,
      {
        flexDirection: "row",
        gap: 1,
        borderStyle: "single",
        borderColor: "#444444",
        paddingLeft: 1,
        paddingRight: 1,
      },
      h(select, {
        options: () => [
          {
            name: `▣ Engine: ${ENGINE_LABELS[kv.get("tts.engine", "piper")]}`,
            description: "Piper local / Deepgram cloud",
            value: "engine",
          },
          {
            name: `◉ Auto: ${kv.get("tts.mode", "off") === "on" ? "ON" : "off"}`,
            description: "Auto-speak on every response",
            value: "mode",
          },
          {
            name: `◐ Bubbles: ${kv.get("tts.chunked", "on") === "on" ? "ON" : "off"}`,
            description: "WhatsApp-style chunks",
            value: "chunked",
          },
          {
            name: `🎙 Voice: ${VOICE_LABELS[kv.get("tts.voice", "ryan")]}`,
            description: "Cycle Piper voice",
            value: "voice",
          },
        ],
        onSelect: (option) => {
          if (option.value === "engine") actions.toggleEngine(() => rerender());
          else if (option.value === "mode") actions.toggleMode(() => rerender());
          else if (option.value === "chunked") actions.toggleChunked(() => rerender());
          else if (option.value === "voice") actions.toggleVoice(() => rerender());
        },
      }),
    ),

    h(text, { content: "" }),

    // Speak / Stop bar
    h(
      box,
      { flexDirection: "row", gap: 1, paddingLeft: 1, paddingRight: 1 },
      h(select, {
        options: [
          {
            name: "▶ Speak last response",
            description: "Synthesize the last assistant message now",
            value: "speak",
          },
          {
            name: "⏹ Stop playback",
            description: "Kill the current TTS process",
            value: "stop",
          },
          {
            name: "🗑 Clear bubble history",
            description: "Erase all stored voice bubbles",
            value: "clear",
          },
          {
            name: "✕ Close panel",
            description: "Dismiss this view",
            value: "close",
          },
        ],
        onSelect: (option) => {
          if (option.value === "speak") {
            rerender("Speaking last response…");
            actions.speak(() => rerender("Done"));
          } else if (option.value === "stop") {
            actions.stop();
            rerender("Stopped");
          } else if (option.value === "clear") {
            actions.clearBubbles();
            rerender(`Cleared ${bubbles().length} bubbles`);
          } else if (option.value === "close") {
            actions.close();
          }
        },
      }),
    ),

    h(text, { content: "" }),
    h(text, { content: () => `── Voice bubbles (${bubbles().length}) ──`, bold: true }),

    // Bubble feed
    h(Show, {
      when: () => bubbles().length === 0,
      children: h(text, {
        content: "  (no bubbles yet — press Speak or wait for the next response)",
        dim: true,
      }),
    }),

    h(Show, {
      when: () => bubbles().length > 0,
      fallback: h(text, { content: "" }),
      children: h(
        scrollbox,
        { height: 14, scrollbar: true },
        h(
          box,
          { flexDirection: "column", gap: 1 },
          h(For, {
            each: () => bubbles().slice().reverse(),
            children: (bubble) => bubbleCard(api, kv, actions, bubble, () => rerender("")),
          }),
        ),
      ),
    }),

    h(text, { content: "" }),
    h(text, {
      content: "  ↑/↓ to navigate  •  enter to select  •  esc to close",
      dim: true,
    }),
  );
}

/**
 * One voice bubble rendered as a rounded WhatsApp-style card.
 * Each card shows: timestamp, ASCII waveform, duration, and a "▶ Play"
 * select that re-synthesizes the bubble's text.
 */
function bubbleCard(api, kv, actions, bubble, rerender) {
  return h(
    box,
    {
      borderStyle: "rounded",
      borderColor: "#00AAFF",
      paddingLeft: 1,
      paddingRight: 1,
      flexDirection: "column",
      gap: 0,
    },
    h(
      box,
      { flexDirection: "row", justifyContent: "space-between" },
      h(text, {
        content: `${formatTime(bubble.ts)}  •  ${bubble.source || "auto"}`,
        dim: true,
      }),
      h(text, { content: formatDuration(bubble.duration), bold: true }),
    ),
    h(text, { content: ` ${waveformFor(bubble.text || "", 24)} ` }),
    h(
      box,
      { flexDirection: "row", gap: 1 },
      h(select, {
        options: [
          {
            name: "▶ Play this bubble",
            description: `Re-synthesize: "${(bubble.text || "").slice(0, 60)}${(bubble.text || "").length > 60 ? "…" : ""}"`,
            value: "play",
          },
        ],
        onSelect: () => {
          rerender(`Playing bubble from ${formatTime(bubble.ts)}…`);
          actions.speakBubble(bubble, () => rerender(""));
        },
      }),
    ),
  );
}
