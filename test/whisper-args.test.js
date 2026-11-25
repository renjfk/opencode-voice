import assert from "node:assert/strict";
import test from "node:test";

import { buildWhisperArgs } from "../lib/stt.js";

// Regression: `-nt` (no-timestamps) makes whisper-cli drop its final
// segment, silently truncating the end of long dictations — verified with
// ggml-large-v3-turbo on a 45s recording (707 vs 719 chars; the tail
// sentence was missing). The plugin strips the `[00:00:.. --> ..]`
// prefixes itself, so `-nt` must never be passed.
test("buildWhisperArgs omits -nt and keeps stderr quiet with -np", () => {
  const args = buildWhisperArgs("/models/ggml.bin", "/tmp/rec.wav", "auto");
  assert.ok(!args.includes("-nt"), "-nt drops the final transcript segment");
  assert.ok(args.includes("-np"), "-np keeps progress output off stderr");
  assert.deepEqual(args.slice(0, 6), [
    "-m",
    "/models/ggml.bin",
    "-f",
    "/tmp/rec.wav",
    "-l",
    "auto",
  ]);
});

test("buildWhisperArgs falls back to the default language", () => {
  const args = buildWhisperArgs("/models/ggml.bin", "/tmp/rec.wav", "");
  assert.ok(args.includes("auto"));
});
