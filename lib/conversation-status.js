// Persistent conversation status line for v2 (mirrors lib/tts-status.js).
//
// Why a slot and not a toast: v2 Toast.show is fire-and-forget text with no
// update or buttons, so polling would stack. This is one bounded line showing
// the current phase and the 2-3 actions that matter right now.
//
// Phase-aware buttons (see README): recording -> cancel/send-now; processing ->
// cancel; waiting -> cancel/barge-in; speaking -> stop/talk-now/pause-TTS;
// paused -> talk/end. Only the relevant subset renders per phase.

export function phaseGlyph(phase) {
  switch (phase) {
    case "recording":
      return "●";
    case "processing":
      return "…";
    case "waiting":
      return "…";
    case "speaking":
      return "▶";
    case "paused":
      return "⏸";
    default:
      return "○";
  }
}

export function phaseLabel(phase) {
  switch (phase) {
    case "recording":
      return "Listening";
    case "processing":
      return "Transcribing";
    case "waiting":
      return "Agent working";
    case "speaking":
      return "Speaking";
    case "paused":
      return "Paused";
    default:
      return "Conversation off";
  }
}

// Returns the segments for the current phase. Static segments carry no
// action; button segments do. The renderer maps each to its own text node
// so mouse hits land on exactly one action.
export function conversationSegments(phase) {
  const glyph = phaseGlyph(phase);
  const label = phaseLabel(phase);
  const base = [{ key: "status", text: `${glyph} ${label}`, action: null }];
  switch (phase) {
    case "recording":
      return [...base, { key: "cancel", text: "[cancel]", action: "cancel" }, { key: "send", text: "[send now]", action: "send" }];
    case "processing":
      return [...base, { key: "cancel", text: "[cancel]", action: "cancel" }];
    case "waiting":
      return [...base, { key: "cancel", text: "[cancel]", action: "cancel" }, { key: "barge", text: "[talk now]", action: "barge" }];
    case "speaking":
      return [
        ...base,
        { key: "stop", text: "[stop]", action: "stop" },
        { key: "talk", text: "[talk now]", action: "barge" },
        { key: "pause", text: "[pause]", action: "pauseTts" },
      ];
    case "paused":
      return [...base, { key: "talk", text: "[talk]", action: "talk" }, { key: "end", text: "[end]", action: "end" }];
    default:
      return base;
  }
}

export function formatConversationStatus(phase) {
  if (!phase || phase === "idle") return "";
  return conversationSegments(phase)
    .map((seg) => seg.text)
    .join(" ");
}

export function createConversationStatus(
  ctx,
  readPhase,
  actions = {},
  load = async () => {
    const [solid, tui] = await Promise.all([import("solid-js"), import("@opentui/solid")]);
    return { ...solid, ...tui };
  },
) {
  let generation = 0;
  let active = false;
  let lastTexts = new Map();
  let renderErrorShown = false;
  let renderCalls = 0;
  let timer = null;
  const nodes = new Set();
  let setContent = null;

  function segments() {
    return conversationSegments(readPhase?.() || "idle");
  }

  function redraw() {
    const segMap = new Map(segments().map((seg) => [seg.key, seg.text]));
    let changed = false;
    for (const [key, text] of segMap) {
      if (lastTexts.get(key) !== text) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      for (const entry of nodes) {
        if (entry.node.isDestroyed) nodes.delete(entry);
      }
      return;
    }
    for (const [key, text] of segMap) {
      lastTexts.set(key, text);
      for (const entry of nodes) {
        if (entry.key !== key || entry.node.isDestroyed) continue;
        setContent?.(entry.node, text);
      }
    }
  }

  function loudRenderError(err) {
    if (renderErrorShown) return;
    renderErrorShown = true;
    try {
      ctx.ui?.toast?.show?.({
        message: `Conversation status failed: ${err?.message || err}`,
        variant: "error",
        duration: 5000,
      });
    } catch {}
  }

  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  let unclaims = [];
  function clear() {
    generation += 1;
    active = false;
    lastTexts = new Map();
    renderCalls = 0;
    stopTimer();
    nodes.clear();
    setContent = null;
    for (const unclaim of unclaims.splice(0)) unclaim();
  }

  function press(action) {
    if (!active) return;
    try {
      actions?.[action]?.();
    } catch {}
  }

  return {
    async begin() {
      clear();
      active = true;
      renderErrorShown = false;
      const mine = generation;
      let createElement;
      let setProp;
      let insertNode;
      let onCleanup;
      try {
        ({ createElement, setProp, insertNode, onCleanup } = await load());
      } catch (loadErr) {
        loudRenderError(loadErr);
        throw loadErr;
      }
      if (!active || mine !== generation) return false;
      setContent = (node, value) => setProp(node, "content", value);
      const themeText = ctx.theme?.text;
      const fg =
        typeof themeText === "string"
          ? themeText
          : themeText?.base || themeText?.muted || "#eeeeee";
      const render = () => {
        if (!active || mine !== generation) return null;
        renderCalls += 1;
        try {
          const box = createElement("box");
          setProp(box, "height", 1);
          setProp(box, "flexShrink", 0);
          setProp(box, "flexDirection", "row");
          setProp(box, "width", "100%");
          const segMap = new Map(segments().map((seg) => [seg.key, seg.text]));
          const mountEntries = [];
          for (const key of ["status", "cancel", "send", "barge", "stop", "talk", "end", "pause"]) {
            const node = createElement("text");
            setProp(node, "maxHeight", 1);
            setProp(node, "minHeight", 1);
            setProp(node, "fg", fg);
            const text = segMap.has(key) ? segMap.get(key) : "";
            setProp(node, "content", text);
            lastTexts.set(key, text);
            const action = segMap.has(key)
              ? (segments().find((s) => s.key === key)?.action ?? null)
              : null;
            if (action) {
              try {
                setProp(node, "onMouseUp", () => press(action));
              } catch {}
            }
            const entry = { key, node };
            nodes.add(entry);
            mountEntries.push(entry);
            insertNode(box, node);
          }
          onCleanup?.(() => {
            for (const entry of mountEntries) nodes.delete(entry);
          });
          redraw();
          return box;
        } catch (renderErr) {
          loudRenderError(renderErr);
          return null;
        }
      };
      unclaims = [
        ctx.ui.slot({ before: "session.composer.top", render }),
        ctx.ui.slot({ before: "home.footer", render }),
      ];
      stopTimer();
      timer = setInterval(() => {
        if (!active) return;
        try {
          redraw();
        } catch {}
      }, 500);
      if (typeof timer.unref === "function") timer.unref();
      return true;
    },
    update() {
      if (!active) return;
      redraw();
    },
    renderCalls: () => renderCalls,
    nodes: () => {
      const keys = new Set();
      for (const entry of nodes) {
        if (!entry.node.isDestroyed) keys.add(entry.key);
      }
      return keys.size;
    },
    clear,
  };
}
