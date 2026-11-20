import { describe, expect, test } from "bun:test";

import {
  detectLang,
  mergeForEngine,
  prepareSpeech,
  splitSegments,
  summarizeMermaid,
  summarizeTable,
} from "./text.ts";

describe("prepareSpeech", () => {
  test("empty input", () => {
    expect(prepareSpeech("")).toBe("");
  });

  test("fenced code becomes 'code snippet', inline code is split into words", () => {
    const out = prepareSpeech(
      "Run this:\n\n```bash\nrm -rf node_modules\n```\n\nThen call `getVoiceModel`.",
    );
    expect(out).toContain("code snippet");
    expect(out).not.toContain("rm -rf");
    expect(out).not.toContain("`");
    expect(out).toContain("get Voice Model");
  });

  test("an unterminated fence hides the rest", () => {
    expect(prepareSpeech("Look:\n```js\nconst x = 1;")).toBe("Look: code snippet.");
  });

  test("links keep their label, URLs become the domain, images keep alt text", () => {
    const out = prepareSpeech(
      "See [the docs](https://x.dev/a). Visit https://github.com/foo/bar. ![logo](a.png)",
    );
    expect(out).toContain("See the docs.");
    expect(out).toContain("github dot com.");
    expect(out).toContain("logo");
    expect(out).not.toContain("http");
    expect(out).not.toContain("](");
  });

  test("paths read their last segment, files say 'dot'", () => {
    const out = prepareSpeech("Edit /usr/local/bin/piper and src/tts/text.ts, then ~/notes.");
    expect(out).toContain("piper");
    expect(out).not.toContain("/usr");
    expect(out).toContain("text dot ts,");
    expect(out).toContain("notes.");
  });

  test("headings, bullets, emphasis and html are stripped; items become sentences", () => {
    const out = prepareSpeech("## Kết quả\n\n- **Đã sửa** lỗi\n- _done_ <br> item\n\n> quoted");
    expect(out).toBe("Kết quả. Đã sửa lỗi. done item. quoted.");
  });

  test("tables and mermaid diagrams become short summaries", () => {
    const md =
      "| Name | Status |\n|---|---|\n| a | ok |\n| b | fail |\n\n```mermaid\ngraph TD\nA[Start] --> B[End]\n```";
    const out = prepareSpeech(md);
    expect(out).toContain("Table with columns Name, Status. 2 rows: a, ok; b, fail.");
    expect(out).toContain("Diagram, graph: Start, End.");
    expect(out).not.toContain("|");
  });

  test("unfenced mermaid is summarized", () => {
    const out = prepareSpeech("flowchart LR\nA[One] --> B[Two]\n\nAfter.");
    expect(out).toBe("Diagram, flowchart: One, Two. After.");
  });

  test("summaries", () => {
    expect(summarizeTable("|---|")).toBe("Table.");
    expect(summarizeMermaid("sequenceDiagram\nA->>B: hi")).toBe("Diagram.");
    const many = ["| h |", "|---|", "| 1 |", "| 2 |", "| 3 |", "| 4 |"].join("\n");
    expect(summarizeTable(many)).toBe("Table with columns h. 4 rows: 1; 2; 3. And 1 more.");
  });
});

describe("detectLang", () => {
  test("vi by diacritics ratio, en otherwise", () => {
    expect(detectLang("Xin chào các bạn")).toBe("vi");
    expect(detectLang("Hello world, this is fine")).toBe("en");
    expect(detectLang("")).toBe("en");
    expect(detectLang("Mình dùng React và TypeScript")).toBe("vi");
  });
});

describe("splitSegments", () => {
  test("groups adjacent sentences by language", () => {
    const segs = splitSegments(
      "Xin chào các bạn. Hôm nay trời đẹp. This is English. And more English. Tạm biệt nhé.",
    );
    expect(segs).toEqual([
      { lang: "vi", text: "Xin chào các bạn. Hôm nay trời đẹp." },
      { lang: "en", text: "This is English. And more English." },
      { lang: "vi", text: "Tạm biệt nhé." },
    ]);
  });

  test("chunks long groups at sentence boundaries within maxChars", () => {
    const sentence = "This is a fairly ordinary English sentence for testing.";
    const segs = splitSegments(Array(10).fill(sentence).join(" "), { maxChars: 120 });
    expect(segs.length).toBeGreaterThan(1);
    for (const s of segs) {
      expect(s.text.length).toBeLessThanOrEqual(120);
      expect(s.text.endsWith(".")).toBe(true);
      expect(s.lang).toBe("en");
    }
    expect(segs.map((s) => s.text).join(" ")).toBe(Array(10).fill(sentence).join(" "));
  });

  test("a sentence longer than maxChars splits at commas, then words", () => {
    const long = Array(12).fill("một hai ba bốn năm").join(", ") + ".";
    const segs = splitSegments(long, { maxChars: 60 });
    for (const s of segs) expect(s.text.length).toBeLessThanOrEqual(60);
    expect(segs[0]?.text.endsWith(",")).toBe(true);
    expect(segs.map((s) => s.text).join(" ")).toBe(long);
    const words = Array(40).fill("word").join(" ");
    for (const s of splitSegments(words, { maxChars: 50 })) {
      expect(s.text.length).toBeLessThanOrEqual(50);
    }
  });

  test("a single unbreakable token is hard-cut", () => {
    const segs = splitSegments("x".repeat(100), { maxChars: 40 });
    expect(segs.map((s) => s.text.length)).toEqual([40, 40, 20]);
  });

  test("default max is 240 and empty input gives nothing", () => {
    expect(splitSegments("   ")).toEqual([]);
    const segs = splitSegments(Array(30).fill("Short sentence here.").join(" "));
    for (const s of segs) expect(s.text.length).toBeLessThanOrEqual(240);
  });
});

describe("mergeForEngine", () => {
  const segs = splitSegments(
    "Xin chào các bạn. This is English. Tạm biệt nhé, hẹn gặp lại các bạn vào ngày mai.",
  );

  test("piper keeps per-language groups", () => {
    expect(mergeForEngine(segs, false)).toEqual(segs);
    expect(segs.length).toBe(3);
  });

  test("vieneu merges mixed segments up to maxChars with majority language", () => {
    const merged = mergeForEngine(segs, true);
    expect(merged).toEqual([
      {
        lang: "vi",
        text: "Xin chào các bạn. This is English. Tạm biệt nhé, hẹn gặp lại các bạn vào ngày mai.",
      },
    ]);
  });

  test("vieneu merge respects maxChars", () => {
    const merged = mergeForEngine(
      [
        { lang: "en", text: "a".repeat(30) },
        { lang: "vi", text: "b".repeat(30) },
        { lang: "vi", text: "c".repeat(30) },
      ],
      true,
      { maxChars: 61 },
    );
    expect(merged.map((s) => s.text.length)).toEqual([61, 30]);
    expect(merged[0]?.lang).toBe("en"); // tie -> first segment's language
  });
});
