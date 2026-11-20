import { describe, expect, test } from "bun:test";
import {
  buildCorrectionUser,
  buildSttUser,
  cleanNormalizerOutput,
  needsContext,
} from "./prompts.ts";

describe("needsContext", () => {
  test("sentence-initial capitals are not a signal", () => {
    expect(needsContext("Add tests for the async user service")).toBe(false);
    expect(needsContext("Run the build. Check the logs")).toBe(false);
    expect(needsContext("Chạy lại build giúp tôi")).toBe(false);
  });

  test("capitalized name mid-sentence is a signal", () => {
    expect(needsContext("ask Cristina about the deploy")).toBe(true);
    expect(needsContext("Send it to (Cristina)")).toBe(true);
  });

  test("English pronouns and demonstratives", () => {
    expect(needsContext("fix that function")).toBe(true);
    expect(needsContext("This is broken")).toBe(true);
    expect(needsContext("rename them")).toBe(true);
  });

  test("Vietnamese pronouns with diacritics match as whole words", () => {
    expect(needsContext("sửa cái đó đi")).toBe(true);
    expect(needsContext("hỏi chị về việc deploy")).toBe(true);
    // "chịu" contains "chị" but is a different word.
    expect(needsContext("chịu khó chạy lại")).toBe(false);
  });

  test("lowercase accented words are not capitals", () => {
    expect(needsContext("chạy lại để kiểm tra")).toBe(false);
  });

  test("short or empty input", () => {
    expect(needsContext("")).toBe(false);
    expect(needsContext("ok")).toBe(false);
  });
});

describe("builders", () => {
  test("buildSttUser without context", () => {
    expect(buildSttUser("raw text", {})).toBe(
      "Clean up this speech-to-text transcription:\n\nraw text",
    );
  });

  test("buildSttUser with title and recent turns", () => {
    expect(buildSttUser("raw", { sessionTitle: "Fix login", recent: "user: hi" })).toBe(
      '<knowledge>\n[session: "Fix login"]\nuser: hi\n</knowledge>\n<task>Clean up this speech-to-text transcription:\n\nraw</task>',
    );
  });

  test("buildCorrectionUser", () => {
    const out = buildCorrectionUser("fit the bug", "I mean fix", { sessionTitle: "T" });
    expect(out).toContain('[session: "T"]');
    expect(out).toContain("CURRENT: fit the bug\nCORRECTION: I mean fix");
  });
});

describe("cleanNormalizerOutput", () => {
  test("strips an echoed task wrapper", () => {
    expect(
      cleanNormalizerOutput(
        "reply with one short sentence",
        "Clean up this speech-to-text transcription: Reply with one short sentence.",
      ),
    ).toBe("Reply with one short sentence.");
  });
  test("strips added quotes and labels", () => {
    expect(cleanNormalizerOutput("hello there", '"Hello there."')).toBe("Hello there.");
    expect(cleanNormalizerOutput("hello there", "Output: Hello there.")).toBe("Hello there.");
  });
  test("falls back to raw when the model answers instead of cleaning", () => {
    const answer =
      "Sure! Here is a detailed explanation of how to fix the failing test in your parser module, step by step...";
    expect(cleanNormalizerOutput("fix the test", answer)).toBe("fix the test");
    expect(cleanNormalizerOutput("fix the test", "   ")).toBe("fix the test");
  });
});
