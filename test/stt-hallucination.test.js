import { test } from "node:test";
import assert from "node:assert/strict";
import { isLikelyHallucination } from "../lib/stt.js";

test("real dictation containing 'you' is kept", () => {
  assert.equal(isLikelyHallucination("can you fix the test"), false);
  assert.equal(isLikelyHallucination("thank you, now run the build"), false);
  assert.equal(isLikelyHallucination("update your config"), false);
});

test("bare silence hallucinations are still dropped", () => {
  assert.equal(isLikelyHallucination("you"), true);
  assert.equal(isLikelyHallucination("Thank you."), true);
  assert.equal(isLikelyHallucination(""), true);
  assert.equal(isLikelyHallucination("Hãy subscribe cho kênh Ghiền Mì Gõ"), true);
  assert.equal(isLikelyHallucination("ok thank you for watching"), true);
});
