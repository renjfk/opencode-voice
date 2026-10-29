// Host-owned Solid/OpenTUI modules are loaded only when a v2 recording starts.
// No composer mutation: this bounded display is an additive, documented slot.
//
// Renders the live transcript and the live input waveform together: the same
// 16-column bar style used by the batch recording toast, sourced from the
// streaming capture's newest PCM tail. The waveform timer lives here so every
// stop path (`clear()`) cancels it in one place.
//
// Layout (single row, fixed width): [toggle] [wave] [body...] [auto-submit] [end-of-speech]
// - toggle/wave/auto-submit/end-of-speech are fixed-width segments that never
//   scroll, so they stay visible no matter how long the transcript grows.
// - body is the only scrolling segment: it shows the LAST N chars of the
//   transcript (auto-scroll) so the user always sees what was just said.
import { sttLog } from "./stt-log.js";

const WAVE_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const BODY_WIDTH = 60;

export function createV2Preview(
  ctx,
  load = async () => {
    const [solid, tui] = await Promise.all([import("solid-js"), import("@opentui/solid")]);
    return { ...solid, ...tui };
  },
) {
  let generation = 0;
  let active = false;
  let paused = false;
  const onToggleRef = { current: null };
  const onAutoSubmitRef = { current: null };
  const onAutoEndRef = { current: null };
  let autoSubmit = false;
  let autoEndOfSpeech = false;
  let partial = { stableText: "", tentativeText: "" };
  let levels = null;
  let applyLogCount = 0;
  let waveProvider = null;
  let waveTimer = null;
  const nodes = new Set();
  const lastTexts = { toggle: null, wave: null, body: null, autoSubmit: null, autoEnd: null };
  let setContent = null;

  function toggleText() {
    return paused ? "[▶]" : "[⏸]";
  }

  function waveText() {
    return levels
      ? `${levels.map((level) => WAVE_CHARS[level] ?? WAVE_CHARS[0]).join("")}  `
      : "▁".repeat(16) + "  ";
  }

  function bodyText() {
    const stable = partial.stableText || "";
    const tentative = partial.tentativeText || "";
    const full =
      `Voice live · ${stable ? `${stable} ` : ""}${tentative ? `[${tentative}]` : stable ? "" : "Listening…"}`;
    // Auto-scroll: show the tail so the newest speech is always visible.
    if (full.length <= BODY_WIDTH) return full;
    return "…" + full.slice(-(BODY_WIDTH - 1));
  }

  function autoSubmitText() {
    return autoSubmit ? "[auto-submit:ON]" : "[auto-submit:off]";
  }

  function autoEndText() {
    return autoEndOfSpeech ? "[auto-end:ON]" : "[auto-end:off]";
  }

  function redraw() {
    const texts = {
      toggle: toggleText(),
      wave: waveText(),
      body: bodyText(),
      autoSubmit: autoSubmitText(),
      autoEnd: autoEndText(),
    };
    for (const entry of nodes) {
      if (entry.node.isDestroyed) {
        nodes.delete(entry);
        continue;
      }
      const text = texts[entry.key];
      if (text === undefined || lastTexts[entry.key] === text) continue;
      lastTexts[entry.key] = text;
      setContent?.(entry.node, text);
    }
  }

  function applyLevels(next) {
    if (!active || !Array.isArray(next) || next.length === 0) return;
    if (applyLogCount < 3) {
      applyLogCount += 1;
      sttLog("preview.levels", `max=${Math.max(...next)} n=${next.length}`);
    }
    levels = next.map((value) => {
      const level = Math.trunc(Number(value));
      if (!Number.isFinite(level)) return 0;
      return Math.max(0, Math.min(WAVE_CHARS.length - 1, level));
    });
    redraw();
  }

  function stopWave() {
    if (waveTimer) {
      clearInterval(waveTimer);
      waveTimer = null;
    }
    waveProvider = null;
  }

  function startWave(provider, intervalMs = 80) {
    stopWave();
    sttLog("preview.wave", active && typeof provider === "function" ? "start" : "rejected");
    if (!active || typeof provider !== "function") return;
    waveProvider = provider;
    const timer = setInterval(
      () => {
        if (!active || !waveProvider) return;
        try {
          const next = waveProvider();
          if (next) applyLevels(next);
        } catch {}
      },
      Math.max(20, Math.floor(Number(intervalMs) || 80)),
    );
    if (typeof timer.unref === "function") timer.unref();
    waveTimer = timer;
  }

  let unclaims = [];
  function clear() {
    generation += 1;
    active = false;
    paused = false;
    partial = { stableText: "", tentativeText: "" };
    levels = null;
    applyLogCount = 0;
    stopWave();
    nodes.clear();
    for (const key of Object.keys(lastTexts)) lastTexts[key] = null;
    setContent = null;
    // Action handlers persist across begin/clear cycles: they are wired by
    // stt.js after begin() resolves, but a re-begin (new generation) must
    // not wipe handlers set before the previous clear. Only the toggle
    // glyph state resets.
    autoSubmit = false;
    autoEndOfSpeech = false;
    for (const unclaim of unclaims.splice(0)) unclaim();
  }
  let renderErrorShown = false;
  let renderCalls = 0;
  function loudRenderError(err) {
    sttLog("preview.render-error", err?.message || String(err));
    if (renderErrorShown) return;
    renderErrorShown = true;
    try {
      ctx.ui?.toast?.show?.({
        message: `Voice live preview failed: ${err?.message || err}`,
        variant: "error",
        duration: 5000,
      });
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
        sttLog("preview.begin-failed", loadErr?.message || String(loadErr));
        loudRenderError(loadErr);
        throw loadErr;
      }
      if (!active || mine !== generation) return false;
      sttLog("preview.begin-ok");
      setContent = (node, value) => setProp(node, "content", value);
      const themeText = ctx.theme?.text;
      const fg =
        typeof themeText === "string"
          ? themeText
          : themeText?.base || themeText?.muted || "#eeeeee";
      const render = () => {
        if (!active || mine !== generation) return null;
        renderCalls += 1;
        if (renderCalls === 1) sttLog("preview.render-first");
        try {
          const box = createElement("box");
          setProp(box, "height", 2);
          setProp(box, "flexShrink", 0);
          setProp(box, "flexDirection", "row");
          setProp(box, "width", "100%");
          setProp(box, "gap", 1);
          const segs = [
            { key: "toggle", text: toggleText(), action: "toggle" },
            { key: "wave", text: waveText(), action: null },
            { key: "body", text: bodyText(), action: null },
            { key: "autoSubmit", text: autoSubmitText(), action: "autoSubmit" },
            { key: "autoEnd", text: autoEndText(), action: "autoEnd" },
          ];
          const mountEntries = [];
          for (const seg of segs) {
            const node = createElement("text");
            setProp(node, "maxHeight", 2);
            setProp(node, "minHeight", 1);
            setProp(node, "fg", fg);
            setProp(node, "content", seg.text);
            lastTexts[seg.key] = seg.text;
            if (seg.action) {
              const action = seg.action;
              try {
                setProp(node, "onMouseUp", () => {
                  try {
                    if (action === "toggle") (onToggleRef.current)?.();
                    else if (action === "autoSubmit") (onAutoSubmitRef.current)?.();
                    else if (action === "autoEnd") (onAutoEndRef.current)?.();
                  } catch {}
                });
              } catch {}
            }
            const entry = { key: seg.key, node };
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
      // Vertical slots only: prompt.footer is a horizontal row (zero-width
      // text) and is absent on the home screen.
      unclaims = [
        ctx.ui.slot({ before: "session.composer.top", render }),
        ctx.ui.slot({ before: "home.footer", render }),
      ];
      return true;
    },
    applyPartial(p) {
      if (!active) return;
      partial = { stableText: p?.stableText || "", tentativeText: p?.tentativeText || "" };
      sttLog(
        "preview.partial",
        `stable=${partial.stableText.length} tentative=${partial.tentativeText.length} nodes=${nodes.size}`,
      );
      redraw();
    },
    applyLevels,
    startWave,
    stopWave,
    setPaused(p) {
      paused = !!p;
      if (active) redraw();
    },
    setToggleAction(fn) {
      onToggleRef.current = typeof fn === "function" ? fn : null;
    },
    setAutoSubmit(v) {
      autoSubmit = !!v;
      if (active) redraw();
    },
    setAutoEndOfSpeech(v) {
      autoEndOfSpeech = !!v;
      if (active) redraw();
    },
    setAutoSubmitToggleAction(fn) {
      onAutoSubmitRef.current = typeof fn === "function" ? fn : null;
    },
    setAutoEndToggleAction(fn) {
      onAutoEndRef.current = typeof fn === "function" ? fn : null;
    },
    getAutoSubmit: () => autoSubmit,
    getAutoEndOfSpeech: () => autoEndOfSpeech,
    getTranscript: () => [partial.stableText, partial.tentativeText].filter(Boolean).join(" "),
    finalize(text) {
      clear();
      return { text, inserted: false };
    },
    cancel: clear,
    clear,
  };
}
