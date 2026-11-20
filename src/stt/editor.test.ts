import { describe, expect, test } from "bun:test";
import { fakeTextarea } from "../testing/fakes.ts";
import { createLiveSpan, insertAtCursor, replaceAll } from "./editor.ts";

describe("insertAtCursor", () => {
  test("adds a separating space after a word", () => {
    const t = fakeTextarea("hello");
    insertAtCursor(t, "world");
    expect(t.plainText).toBe("hello world");
  });
  test("no extra space at start or after whitespace", () => {
    const a = fakeTextarea("");
    insertAtCursor(a, "hi");
    expect(a.plainText).toBe("hi");
    const b = fakeTextarea("hi ");
    insertAtCursor(b, "there");
    expect(b.plainText).toBe("hi there");
  });
});

describe("live span", () => {
  test("rewrites its own range in place, keeping surrounding text", () => {
    const t = fakeTextarea("before after", 6); // cursor after "before"
    const s = createLiveSpan(t);
    expect(s.set("xin")).toBe(true);
    expect(t.plainText).toBe("before xin after");
    expect(s.set("xin chào các bạn")).toBe(true);
    expect(t.plainText).toBe("before xin chào các bạn after");
    expect(s.set("xin chào")).toBe(true);
    expect(t.plainText).toBe("before xin chào after");
  });

  test("works across multiple lines", () => {
    const t = fakeTextarea("line one\nline two", 8);
    const s = createLiveSpan(t);
    s.set("A");
    s.set("ABC\nDEF");
    s.set("Z");
    expect(t.plainText).toBe("line one Z\nline two");
  });

  test("detaches when the user edits, and never overwrites their text", () => {
    const t = fakeTextarea("", 0);
    const s = createLiveSpan(t);
    s.set("hello");
    t.cursorOffset = t.plainText.length;
    t.insertText("!!"); // user typed
    expect(s.set("hello world")).toBe(false);
    expect(s.detached).toBe(true);
    expect(t.plainText).toBe("hello!!");
  });

  test("remove deletes only the owned text", () => {
    const t = fakeTextarea("keep", 4);
    const s = createLiveSpan(t);
    s.set("dictated words");
    s.remove();
    expect(t.plainText).toBe("keep");
  });

  test("replaceAll swaps the whole field", () => {
    const t = fakeTextarea("fit the test");
    replaceAll(t, "fix the test");
    expect(t.plainText).toBe("fix the test");
    expect(t.cursorOffset).toBe(12);
  });
});
