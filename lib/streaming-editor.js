// Focused-editor range adapter for local streaming dictation (STAGE 2).
//
// Owns ONLY the dictated range inside the focused editable field:
//   prefix (surrounding text before the cursor at record start) +
//   dictated (stable + tentative, replaced as hypotheses evolve) +
//   suffix (surrounding text after the cursor at record start).
//
// Verified renderer APIs (installed @opencode-ai/plugin 1.18.25,
// .opencode/node_modules/@opencode-ai/plugin/dist/tui.d.ts):
// - `api.renderer` is typed as untyped `CliRenderer` from @opentui/core.
//   `currentFocusedRenderable` does NOT appear in the plugin types at all -
//   it is a runtime-only property.
// - The ONLY observed runtime methods on the focused renderable are
//   `insertText(text)` and `submit()` (see lib/stt.js insertIntoFocusedInput).
// - `TuiPromptRef` (via session_prompt/home_prompt slots, which this repo
//   does not use) offers `current.input` + `set()` + `submit()` - also no
//   selection, cursor, or change-notification APIs.
// - No selection/cursor/change-notification behavior exists in the installed
//   types. This adapter therefore MUST NOT assume any range-deletion,
//   selection, or edit-notification API on the live renderer.
//
// Probing rule: a target supports live range replacement ONLY when it
// exposes BOTH `getText()` and `setRange(start, end, text)` functions
// (plus optional `getSelection()` and `isAlive()`). Anything else -
// including the real renderer, which exposes only `insertText` - takes the
// fallback path: live preview toast plus a SINGLE insert at finalize.
// Fallback inserts use the existing `insertIntoFocusedInput` helper and
// never fall through to primary-chat `appendPrompt`/`submitPrompt`.
//
// Safety rules (both paths):
// - The captured target is fixed for the session. If `getFocused()` returns
//   a different identity, or `isAlive()` reports false, live mutations stop
//   immediately; the transcript is retained for recovery and never silently
//   redirected into another field.
// - If the user edits inside the dictated range (detected by comparing the
//   field text against prefix + lastWritten + suffix), live mutations stop
//   immediately; the transcript is retained.
// - `cancel()` removes ONLY plugin-owned dictated text via `setRange`
//   (live path) and is a no-op when nothing was inserted (fallback path).
//   User-typed prefix/suffix text is never touched.
// - Submission uses ONLY the captured target's own `submit()` when present.
//   There is deliberately no fallback to primary-chat submit for a custom
//   field. Callers implement this via `resolveStreamingSubmit(target)`.
// - No LLM calls anywhere in this module (local-only, zero quota).

export function canLiveReplace(target) {
  return !!target && typeof target.getText === "function" && typeof target.setRange === "function";
}

export function hasOwnSubmit(target) {
  return !!target && typeof target.submit === "function";
}

// Submission-safety decision for a captured target. Returns
// `{ ok: true, via: "focused-submit" }` only when the captured target
// itself can submit; otherwise `{ ok: false, reason }` and the caller must
// NOT fall through to primary-chat submit.
export function resolveStreamingSubmit(target) {
  if (!target) return { ok: false, reason: "no-target" };
  if (hasOwnSubmit(target)) return { ok: true, via: "focused-submit" };
  return { ok: false, reason: "target-cannot-submit" };
}

function joinDictated(stableText, tentativeText) {
  return `${stableText || ""} ${tentativeText || ""}`.trim();
}

export function createStreamingEditorAdapter({ toast = null, getFocused = null } = {}) {
  let active = false;
  let fallback = true;
  let detached = false;
  let detachReason = null;
  let target = null;
  let prefix = "";
  let suffix = "";
  let lastWritten = "";
  let dictatedText = "";

  function currentFocused() {
    try {
      return typeof getFocused === "function" ? getFocused() : target;
    } catch {
      return target;
    }
  }

  function snapshotTarget(t) {
    // Append-mode anchoring: without a selection API the cursor position is
    // unknowable, so the entire pre-existing text is treated as prefix and
    // the dictated range starts at its end. Nothing pre-existing is ever
    // overwritten.
    try {
      const text = t.getText() ?? "";
      if (typeof t.getSelection === "function") {
        const sel = t.getSelection() || {};
        const start = Number(sel.start ?? sel.anchor ?? text.length);
        const end = Number(sel.end ?? sel.head ?? start);
        const s = Number.isFinite(start) ? Math.max(0, Math.min(start, text.length)) : text.length;
        const e = Number.isFinite(end) ? Math.max(s, Math.min(end, text.length)) : s;
        return { prefix: text.slice(0, s), suffix: text.slice(e) };
      }
      return { prefix: String(text), suffix: "" };
    } catch {
      return { prefix: "", suffix: "" };
    }
  }

  function begin(capturedTarget) {
    if (active) return { ok: false, reason: "already-active" };
    if (!capturedTarget) {
      // No editable field at record start: fallback session with no target.
      // Partials become preview toasts; finalize has nowhere to insert and
      // reports `no-target` instead of redirecting into primary chat.
      active = true;
      fallback = true;
      detached = false;
      detachReason = null;
      target = null;
      prefix = "";
      suffix = "";
      lastWritten = "";
      dictatedText = "";
      return { ok: true, fallback: true, reason: "no-target" };
    }
    active = true;
    detached = false;
    detachReason = null;
    target = capturedTarget;
    dictatedText = "";
    lastWritten = "";
    if (canLiveReplace(capturedTarget)) {
      const snap = snapshotTarget(capturedTarget);
      prefix = snap.prefix;
      suffix = snap.suffix;
      fallback = false;
      return { ok: true, fallback: false };
    }
    // Insert-capable (or unknown) field without range APIs: preview + single
    // insert at finalize. Nothing is written until finalize.
    prefix = "";
    suffix = "";
    fallback = true;
    return { ok: true, fallback: true, reason: "no-range-api" };
  }

  function detach(reason) {
    if (!active || detached) return dictatedText;
    detached = true;
    detachReason = reason || "detached";
    return dictatedText;
  }

  function checkAttached() {
    if (!active || fallback || detached) return null;
    const now = currentFocused();
    if (now !== target) {
      detach(now ? "focus-moved" : "target-closed");
      return detachReason;
    }
    try {
      if (typeof target.isAlive === "function" && target.isAlive() === false) {
        detach("target-closed");
        return detachReason;
      }
    } catch {
      detach("target-closed");
      return detachReason;
    }
    // User-edit detection: the field must still read prefix +
    // lastWritten + suffix. Any deviation inside the dictated range (or of
    // the anchors) means the user typed there - freeze live mutations.
    try {
      const current = target.getText() ?? "";
      const expected = `${prefix}${lastWritten}${suffix}`;
      if (current !== expected) {
        detach("user-edit");
        return detachReason;
      }
    } catch {
      detach("target-closed");
      return detachReason;
    }
    return null;
  }

  function applyPartial({ stableText = "", tentativeText = "" } = {}) {
    if (!active) return { status: "inactive", text: "" };
    dictatedText = joinDictated(stableText, tentativeText);
    if (fallback || detached) {
      if (!detached && dictatedText) {
        try {
          toast?.(`🎙 ${dictatedText}`, "info");
        } catch {}
      }
      return { status: detached ? "detached" : "preview", text: dictatedText };
    }
    const lost = checkAttached();
    if (lost) return { status: "detached", text: dictatedText, reason: lost };
    try {
      target.setRange(prefix.length, prefix.length + lastWritten.length, dictatedText);
      lastWritten = dictatedText;
      return { status: "applied", text: dictatedText };
    } catch {
      detach("write-failed");
      return { status: "detached", text: dictatedText, reason: detachReason };
    }
  }

  // Commit state at finalize. Live path already shows the full text; the
  // caller performs the single insert for the fallback path via the existing
  // focused-input helper (never primary-chat append).
  function finalize(fullText) {
    if (!active) return { text: fullText || dictatedText, inserted: false, fallback };
    const text = typeof fullText === "string" ? fullText : dictatedText;
    dictatedText = text;
    if (!fallback && !detached) {
      const lost = checkAttached();
      if (!lost) {
        try {
          target.setRange(prefix.length, prefix.length + lastWritten.length, text);
          lastWritten = text;
        } catch {
          detach("write-failed");
        }
      }
    }
    const out = {
      text,
      inserted: !fallback && !detached,
      fallback,
      detached,
      reason: detachReason,
    };
    active = false;
    return out;
  }

  // Remove ONLY plugin-owned dictated text. Live path: clear the owned
  // range, restoring prefix + suffix. Fallback path: nothing was inserted,
  // so there is nothing to remove. Never touches user-typed text.
  function cancel() {
    if (!active) return { removedChars: 0, fallback };
    let removedChars = 0;
    if (!fallback && !detached && target) {
      try {
        const now = currentFocused();
        if (now === target) {
          const alive = typeof target.isAlive !== "function" || target.isAlive() !== false;
          if (alive) {
            const current = target.getText() ?? "";
            if (current === `${prefix}${lastWritten}${suffix}` && lastWritten) {
              target.setRange(prefix.length, prefix.length + lastWritten.length, "");
              removedChars = lastWritten.length;
            }
          }
        }
      } catch {}
    }
    const wasFallback = fallback;
    active = false;
    detached = false;
    detachReason = null;
    target = null;
    lastWritten = "";
    dictatedText = "";
    prefix = "";
    suffix = "";
    return { removedChars, fallback: wasFallback };
  }

  function reset() {
    active = false;
    fallback = true;
    detached = false;
    detachReason = null;
    target = null;
    prefix = "";
    suffix = "";
    lastWritten = "";
    dictatedText = "";
  }

  function getState() {
    return {
      active,
      fallback,
      detached,
      reason: detachReason,
      dictatedText,
      lastWritten,
      prefixChars: prefix.length,
      suffixChars: suffix.length,
      hasTarget: target !== null,
    };
  }

  return {
    begin,
    applyPartial,
    finalize,
    cancel,
    reset,
    detach,
    getState,
    getTarget: () => target,
    getTranscript: () => dictatedText,
  };
}
