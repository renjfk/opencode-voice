import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_KEYBINDS, resolveKeybinds } from "../lib/keybinds.js";

test("keybinds: sin opciones devuelve los defaults de upstream", () => {
  const binds = resolveKeybinds();
  assert.deepEqual(binds, DEFAULT_KEYBINDS);
  assert.equal(binds.record, "ctrl+r");
  assert.equal(binds.stopPlayback, "escape");
});

test("keybinds: override reemplaza el default", () => {
  const binds = resolveKeybinds({ keybinds: { record: "f5" } });
  assert.equal(binds.record, "f5");
  assert.equal(binds.submit, DEFAULT_KEYBINDS.submit);
});

test("keybinds: string vacío o 'none' desactiva el binding", () => {
  const binds = resolveKeybinds({ keybinds: { record: "", speak: "none", mic: "  " } });
  assert.equal(binds.record, "");
  assert.equal(binds.speak, "");
  assert.equal(binds.mic, "");
});

test("keybinds: ignora claves desconocidas y valores no-string", () => {
  const binds = resolveKeybinds({ keybinds: { record: 42, nope: "f9", mic: "f10" } });
  assert.equal(binds.record, DEFAULT_KEYBINDS.record);
  assert.equal(binds.mic, "f10");
  assert.equal("nope" in binds, false);
});

test("keybinds: keybinds no-objeto se ignora", () => {
  assert.deepEqual(resolveKeybinds({ keybinds: "f5" }), DEFAULT_KEYBINDS);
  assert.deepEqual(resolveKeybinds({ keybinds: null }), DEFAULT_KEYBINDS);
});
