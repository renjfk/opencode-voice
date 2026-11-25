// Sizing math for the voice review dialog.
//
// OpenCode sizes dialogs with a width class — medium 60, large 88, or
// xlarge 116 columns (the same buckets the built-in prompt dialog uses).
// The height, however, is decided by the dialog's content: a custom dialog
// renders whatever the plugin returns, so the editor can grow with the
// transcript instead of the built-in prompt's single fixed row.

// Inner text width of each dialog size class, in columns.
export const DIALOG_WIDTHS = { medium: 60, large: 88, xlarge: 116 };

// Columns lost to dialog padding and borders when estimating how many
// characters fit on an editor row.
export const CHROME_PADDING = 6;

// Longest line of `text`, in characters.
function longestLine(text) {
  return String(text ?? "")
    .split("\n")
    .reduce((max, line) => Math.max(max, line.length), 0);
}

// Smallest dialog width class whose inner width fits the longest line of
// `text`, never wider than `max` columns (the terminal width cap). When no
// class fits the text within `max`, the largest class that still fits the
// terminal is used and the text wraps inside it.
export function sizeForText(text, { max = DIALOG_WIDTHS.xlarge, padding = CHROME_PADDING } = {}) {
  const want = Math.min(longestLine(text) + padding, max);
  let largest = null;
  for (const size of ["medium", "large", "xlarge"]) {
    const width = DIALOG_WIDTHS[size];
    if (width > max) break;
    if (width >= want) return size;
    largest = size;
  }
  return largest ?? "medium";
}

// Visual rows a single source line occupies when the editor greedily
// word-wraps it at `usable` columns: rows break at spaces, never mid-word
// (except for words longer than a whole row, which hard-break).
function wrappedRowCount(line, usable) {
  if (line.length === 0) return 1;
  let rows = 1;
  let col = 0;
  for (const word of line.split(" ")) {
    if (col > 0) {
      if (col + 1 + word.length <= usable) {
        col += 1 + word.length;
        continue;
      }
      rows += 1;
      col = 0;
    }
    if (word.length > usable) {
      rows += Math.ceil(word.length / usable) - 1;
      col = word.length % usable;
    } else {
      col = word.length;
    }
  }
  return rows;
}

// Visual rows the transcript occupies in a word-wrapped editor of the given
// width. Uncapped — see fitEditor.
export function editorRows(text, { width = DIALOG_WIDTHS.medium, padding = CHROME_PADDING } = {}) {
  const usable = Math.max(1, width - padding);
  return String(text ?? "")
    .split("\n")
    .reduce((rows, line) => rows + wrappedRowCount(line, usable), 0);
}

// Editor height for the transcript: the wrapped row count plus one spare
// row of headroom (absorbs wrap-width estimation error), capped to
// `maxHeight`; plus how many rows are hidden below the fold. When rows are
// clipped the editor scrolls to the start, so the beginning stays visible.
export function fitEditor(text, { width, maxHeight = Number.POSITIVE_INFINITY, padding } = {}) {
  const rows = editorRows(text, { width, padding });
  const height = Math.min(rows + 1, Math.max(1, maxHeight));
  return { rows: height, clipped: Math.max(0, rows - height) };
}
