import { describe, expect, test } from "bun:test";
import { cleanTranscript, isLikelyHallucination } from "./filter.ts";

describe("cleanTranscript", () => {
  test("strips whisper annotations and collapses whitespace", () => {
    expect(cleanTranscript("  [BLANK_AUDIO]  hello\n\n world  ")).toBe("hello world");
    expect(cleanTranscript("(music) fix the bug [Music] ♪ now ♫")).toBe("fix the bug now");
    expect(cleanTranscript("[00:00.000 --> 00:02.000]  xin chào (laughs)")).toBe("xin chào");
  });

  test("empty and annotation-only input becomes empty", () => {
    expect(cleanTranscript("")).toBe("");
    expect(cleanTranscript(" [BLANK_AUDIO] ")).toBe("");
  });
});

describe("isLikelyHallucination", () => {
  test.each([
    "",
    "   ",
    "you",
    "You.",
    "Thank you.",
    "thank you",
    "Thanks for watching!",
    "Thank you for watching, see you",
    "Please subscribe",
    "Hãy subscribe cho kênh Ghiền Mì Gõ để không bỏ lỡ",
    "Đăng ký kênh",
    "Cảm ơn các bạn đã xem video",
    "subscribe to the channel",
  ])("drops %p", (text) => {
    expect(isLikelyHallucination(text)).toBe(true);
  });

  test.each([
    "can you fix the test",
    "thank you, now run the build",
    "you should rename this function",
    "thank you so much for the review, let's merge",
    "sửa lỗi trong file index",
    "watch the logs please",
  ])("keeps real dictation %p", (text) => {
    expect(isLikelyHallucination(text)).toBe(false);
  });
});
