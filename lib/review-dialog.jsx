// Editable review dialog for voice transcripts.
//
// The built-in `context.ui.dialog.prompt` renders a single-line editor at a
// fixed medium width — fine for a rename, useless for reviewing a dictated
// paragraph. This dialog sizes itself to the transcript instead: it picks
// the smallest dialog width class that fits the longest line, gives the
// editor one row per wrapped line (capped to the terminal height), and the
// textarea scrolls internally when the transcript is longer.
//
// Loaded lazily from index.js so an unexpected runtime (no JSX transform,
// missing custom-dialog API) degrades to the built-in prompt instead of
// failing the whole plugin.

import { Show, createSignal } from "solid-js";
import { usePlugin } from "@opencode/plugin/tui";
import { DIALOG_WIDTHS, editorRows, fitEditor, sizeForText } from "./dialog-sizing.js";

// Terminal rows spent on everything around the editor: dialog padding,
// title, description, hint, and the gaps between them.
const CHROME_ROWS = 8;

function ReviewDialog(props) {
  const context = usePlugin();
  const muted = context.theme?.text?.muted;
  let editor;
  // Height starts from an estimate (the editor's usable width isn't known
  // until it mounts) and is refined from the measured width below.
  const [rows, setRows] = createSignal(props.rows);
  const [clipped, setClipped] = createSignal(props.clipped);
  // OpenCode's own dialogs apply their size from inside the component (the
  // dialog stack resets it when the dialog opens), so do the same here.
  try {
    context.ui.dialog.set({ size: props.size, centered: true });
  } catch {
    // Size classes are cosmetic; the dialog still works at the default.
  }
  context.keymap.layer(() => ({
    mode: "modal",
    commands: [
      {
        id: "opencode-voice.review.submit",
        title: "Send transcript",
        bind: "return",
        run: () => props.onConfirm?.(editor?.plainText ?? ""),
      },
      {
        id: "opencode-voice.review.cancel",
        title: "Cancel review",
        bind: "escape",
        run: () => props.onCancel?.(),
      },
    ],
  }));
  const refine = (delay) =>
    setTimeout(() => {
      if (!editor || editor.isDestroyed) return;
      // Refine the height from the measured editor width instead of the
      // pre-mount estimate, so the editor grows to hold the whole transcript
      // whenever the terminal allows it. Runs twice: once early so the
      // dialog opens the right size, once after layout settles in case the
      // first measurement raced it.
      if (editor.width > 0) {
        const fit = fitEditor(props.value, {
          width: editor.width,
          padding: 0,
          maxHeight: props.maxRows,
        });
        setRows(fit.rows);
        setClipped(fit.clipped);
      }
    }, delay);
  refine(1);
  refine(150);
  setTimeout(() => {
    if (!editor || editor.isDestroyed) return;
    editor.focus();
    // With clipped rows, review from the beginning (the hint says the rest
    // scrolls); otherwise start at the end, ready to append.
    if (clipped() > 0) editor.gotoLineStart?.();
    else editor.gotoLineEnd?.();
  }, 160);
  return (
    <box flexDirection="column" gap={1}>
      <text>{props.title}</text>
      <Show when={props.description}>
        <text fg={muted}>{props.description}</text>
      </Show>
      <textarea
        ref={(el) => {
          editor = el;
        }}
        initialValue={props.value}
        height={rows()}
        wrapMode="word"
      />
      <text fg={muted}>
        {clipped() > 0
          ? `${clipped()} more line(s) below · editor scrolls · Enter send, Esc cancel`
          : "Enter send · Esc cancel"}
      </text>
    </box>
  );
}

// Open the review dialog and resolve with the edited text, or undefined if
// the user cancelled. Sizes itself to the transcript; if the terminal is too
// short for every row, the remaining rows scroll inside the editor.
export function openReviewDialog(context, { title, description, value }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        context.ui.dialog.clear();
      } catch {
        // The host already closed the dialog.
      }
      resolve(result);
    };

    const termWidth = context.renderer?.width ?? 120;
    const termHeight = context.renderer?.height ?? 40;
    const size = sizeForText(value, { max: Math.max(1, termWidth - 4) });
    const width = Math.min(DIALOG_WIDTHS[size], Math.max(1, termWidth - 4));
    const { rows, clipped } = fitEditor(value, {
      width,
      maxHeight: Math.max(1, termHeight - CHROME_ROWS),
    });

    try {
      context.ui.dialog.set({ size, centered: true });
    } catch {
      // Size classes are cosmetic; the dialog still works at the default.
    }
    context.ui.dialog.show(
      () => (
        <ReviewDialog
          title={title}
          description={description}
          value={value}
          size={size}
          rows={rows}
          clipped={clipped}
          maxRows={Math.max(1, termHeight - CHROME_ROWS)}
          width={width}
          onConfirm={(text) => finish(text)}
          onCancel={() => finish(undefined)}
        />
      ),
      () => finish(undefined),
    );
  });
}

// Rows the transcript would occupy uncapped — exported for tests.
export { editorRows };
