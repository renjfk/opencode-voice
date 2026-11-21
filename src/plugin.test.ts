import { expect, test } from "bun:test";
import { nextRate } from "./plugin.ts";

test("faster / slower step through the presets and stop at the ends", () => {
  expect(nextRate(1, 1)).toBe(1.25);
  expect(nextRate(1, -1)).toBe(0.75);
  expect(nextRate(2, 1)).toBe(2);
  expect(nextRate(0.75, -1)).toBe(0.75);
  expect(nextRate(1.1, 1)).toBe(1.25);
});
