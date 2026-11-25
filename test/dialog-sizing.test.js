import assert from "node:assert/strict";
import test from "node:test";

import { DIALOG_WIDTHS, editorRows, fitEditor, sizeForText } from "../lib/dialog-sizing.js";

test("editorRows: one row per source line", () => {
  assert.equal(editorRows("one\ntwo\nthree", { width: 60 }), 3);
});

test("editorRows: empty text still needs one row", () => {
  assert.equal(editorRows("", { width: 60 }), 1);
  assert.equal(editorRows(null, { width: 60 }), 1);
});

test("editorRows: wraps lines past the usable width", () => {
  // usable = 60 - 6 = 54 columns; a 55-char line hard-breaks onto a second row.
  assert.equal(editorRows("a".repeat(55), { width: 60 }), 2);
  assert.equal(editorRows("a".repeat(54), { width: 60 }), 1);
  // Each source line wraps independently.
  assert.equal(editorRows(`${"a".repeat(55)}\nshort`, { width: 60 }), 3);
});

test("editorRows: word wrap breaks at spaces, needing more rows than character division", () => {
  // usable = 16 - 6 = 10 columns. Three 6-char words: character division
  // says ceil(20/10) = 2 rows, but no two words fit a row together, so the
  // editor really uses 3.
  assert.equal(editorRows("ffffff ffffff ffffff", { width: 16 }), 3);
});

test("fitEditor: adds one row of headroom, caps the height, reports clipped rows", () => {
  const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
  // Nothing clipped: the spare row is kept for wrap-estimation error.
  assert.deepEqual(fitEditor(text, { width: 60, maxHeight: 20 }), { rows: 11, clipped: 0 });
  // Clipped to the terminal: the editor fills the cap.
  assert.deepEqual(fitEditor(text, { width: 60, maxHeight: 4 }), { rows: 4, clipped: 6 });
  // The height never drops below one row.
  assert.deepEqual(fitEditor(text, { width: 60, maxHeight: 0 }), { rows: 1, clipped: 9 });
});

test("sizeForText: smallest width class that fits the longest line", () => {
  assert.equal(sizeForText("short line"), "medium");
  assert.equal(sizeForText("a".repeat(70)), "large");
  assert.equal(sizeForText(`${"a".repeat(80)}\ntiny`, { padding: 0 }), "large");
  assert.equal(sizeForText("a".repeat(200)), "xlarge");
});

test("sizeForText: never wider than max (terminal width cap)", () => {
  const tinyTerminal = DIALOG_WIDTHS.medium + 10;
  assert.equal(sizeForText("a".repeat(200), { max: tinyTerminal }), "medium");
});

test("sizeForText: long single-line text on a wide terminal still picks the largest class that fits", () => {
  // Nothing fits a 390-char line, but the terminal allows xlarge — take it
  // rather than shrinking back to medium.
  const wideTerminal = DIALOG_WIDTHS.xlarge + 60;
  assert.equal(sizeForText("a".repeat(390), { max: wideTerminal }), "xlarge");
});
