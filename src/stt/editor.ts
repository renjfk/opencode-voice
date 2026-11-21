// Writes dictation into the focused text field (composer, dialog input...).
// A LiveSpan owns one range of text that streaming dictation rewrites in
// place; any user edit around it detaches the span so we never overwrite
// what the user typed.
import type { FocusedTextarea } from "../host.ts";

export interface LiveSpan {
  /** Rewrite the owned range. False once detached (user edited / field gone). */
  set(text: string): boolean;
  readonly detached: boolean;
  /** Text currently owned in the field. */
  readonly written: string;
  /** Delete the owned range (cancel). */
  remove(): void;
}

function needsLeadingSpace(before: string, text: string): boolean {
  if (!text || /^\s/.test(text)) return false;
  const last = before.slice(-1);
  return last !== "" && !/\s/.test(last);
}

function position(t: FocusedTextarea, offset: number): { row: number; col: number } {
  try {
    const p = t.editBuffer?.offsetToPosition?.(offset);
    if (p && Number.isFinite(p.row) && Number.isFinite(p.col)) return p;
  } catch {}
  const before = t.plainText.slice(0, offset);
  const lines = before.split("\n");
  return { row: lines.length - 1, col: (lines.at(-1) ?? "").length };
}

/** Replace [start, end) of the field with text; cursor ends after it. */
function replaceRange(t: FocusedTextarea, start: number, end: number, text: string): void {
  if (end > start) {
    const a = position(t, start);
    const b = position(t, end);
    t.deleteRange(a.row, a.col, b.row, b.col);
  }
  t.cursorOffset = start;
  if (text) t.insertText(text);
}

/** Insert at the cursor with a separating space when needed. */
export function insertAtCursor(t: FocusedTextarea, text: string): void {
  const before = t.plainText.slice(0, t.cursorOffset);
  t.insertText(needsLeadingSpace(before, text) ? ` ${text}` : text);
}

export function replaceAll(t: FocusedTextarea, text: string): void {
  replaceRange(t, 0, t.plainText.length, text);
}

export function createLiveSpan(t: FocusedTextarea, onDetach?: (why: string) => void): LiveSpan {
  const anchor = Math.max(0, Math.min(t.cursorOffset, t.plainText.length));
  const before = t.plainText.slice(0, anchor);
  const after = t.plainText.slice(anchor);
  const pad = needsLeadingSpace(before, "x") ? " " : "";
  let written = "";
  let detached = false;

  const intact = (): boolean => {
    if (t.isDestroyed) return false;
    try {
      return t.plainText === before + written + after;
    } catch {
      return false;
    }
  };

  return {
    get detached() {
      return detached;
    },
    get written() {
      return written;
    },
    set(text) {
      if (detached) return false;
      if (!intact()) {
        detached = true;
        try {
          const actual = t.plainText;
          const expected = before + written + after;
          onDetach?.(
            `field changed: expected=${expected.length} actual=${actual.length} nfcEqual=${actual.normalize("NFC") === expected.normalize("NFC")} destroyed=${t.isDestroyed === true}`,
          );
        } catch {}
        return false;
      }
      const next = text ? pad + text : "";
      if (next === written) return true;
      try {
        replaceRange(t, anchor, anchor + written.length, next);
        written = next;
        return true;
      } catch {
        detached = true;
        return false;
      }
    },
    remove() {
      if (detached || !written || !intact()) return;
      try {
        replaceRange(t, anchor, anchor + written.length, "");
        written = "";
      } catch {}
    },
  };
}
