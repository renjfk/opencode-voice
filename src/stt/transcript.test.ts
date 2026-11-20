import { describe, expect, test } from "bun:test";
import {
  createTranscriptTracker,
  findAnchor,
  joinHypothesis,
  locateStableEnd,
  normalizeWord,
  sameWord,
  splitWords,
} from "./transcript.ts";

const w = (s: string): string[] => splitWords(s);
const win = (startMs: number, endMs: number) => ({ startMs, endMs });

/** True when any run of `n` consecutive words appears twice in `text`. */
function hasRepeatedPhrase(text: string, n = 3): boolean {
  const words = splitWords(text).map(normalizeWord);
  const seen = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) {
    const key = words.slice(i, i + n).join(" ");
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

describe("word helpers", () => {
  test("normalizeWord strips case, punctuation, diacritics and đ", () => {
    expect(normalizeWord("Đường,")).toBe("duong");
    expect(normalizeWord("Việt.")).toBe("viet");
    expect(normalizeWord("Hello!")).toBe("hello");
  });

  test("sameWord: punctuation-only tokens must match exactly", () => {
    expect(sameWord("--", "…")).toBe(false);
    expect(sameWord("--", "--")).toBe(true);
    expect(sameWord("Tiếng", "tieng")).toBe(true);
  });

  test("splitWords handles empty and extra whitespace", () => {
    expect(splitWords("   ")).toEqual([]);
    expect(splitWords(" a  b\nc ")).toEqual(["a", "b", "c"]);
  });
});

describe("findAnchor", () => {
  test("skips cut leading words", () => {
    const a = findAnchor(w("the quick brown fox"), 0, w("uick brown fox jumps"));
    expect(a).toEqual({ skip: 1, end: 4, length: 2 });
  });

  test("never anchors entirely inside stable", () => {
    // Run "a b" ends at 2, before stable end (4): rejected.
    expect(findAnchor(w("a b c d"), 4, w("a b x y"))).toBeNull();
  });

  test("does not skip more than 3 words", () => {
    expect(findAnchor(w("p q r s"), 0, w("1 2 3 4 r s"))).toBeNull();
    expect(findAnchor(w("p q r s"), 0, w("1 2 3 r s"))).toEqual({ skip: 3, end: 4, length: 2 });
  });
});

describe("locateStableEnd", () => {
  test("finds stable's last words in the hypothesis", () => {
    expect(locateStableEnd(w("a b c d"), w("x c d e f"))).toBe(3);
  });

  test("tolerates a reworded last stable word", () => {
    expect(locateStableEnd(w("a b c d"), w("b c D2 e"))).toBe(3);
  });

  test("null when nothing matches", () => {
    expect(locateStableEnd(w("a b"), w("x y z"))).toBeNull();
  });
});

describe("joinHypothesis", () => {
  test("empty hypothesis changes nothing", () => {
    const r = joinHypothesis(w("a b"), w("c"), [], true);
    expect(r).toEqual({ stable: w("a b"), tentative: w("c") });
  });

  test("revised last tentative word is replaced, not appended", () => {
    const r = joinHypothesis(w("a b c"), w("d e"), w("b c d x y"), true);
    expect(r).toEqual({ stable: w("a b c d"), tentative: w("x y") });
  });

  test("whole tentative revised: anchor ends at stable end", () => {
    const r = joinHypothesis(w("a b c"), w("d e"), w("a b c q r"), true);
    expect(r).toEqual({ stable: w("a b c"), tentative: w("q r") });
  });

  test("no anchor with time overlap replaces the tail instead of appending", () => {
    // Mid-window revision breaks every anchor run; stable "z" located in H.
    // The tentative "q" is revised too, so no run reaches past stable's end.
    const r = joinHypothesis(w("v x y z"), w("q"), w("x Y2 z Q2 n"), true);
    expect(r.stable).toEqual(w("v x y z"));
    expect(r.tentative).toEqual(w("Q2 n"));
  });

  test("no anchor and stable not found: tentative replaced by hypothesis", () => {
    const r = joinHypothesis(w("a b"), w("c"), w("x y z"), true);
    expect(r).toEqual({ stable: w("a b"), tentative: w("x y z") });
  });

  test("no anchor after a time gap appends and commits the old tail", () => {
    const r = joinHypothesis(w("a b"), w("c"), w("x y z"), false);
    expect(r).toEqual({ stable: w("a b c"), tentative: w("x y z") });
  });
});

describe("createTranscriptTracker", () => {
  test("first hypothesis is tentative, re-observation makes it stable", () => {
    const t = createTranscriptTracker();
    expect(t.push("hello world", win(0, 1000))).toEqual({ stable: "", tentative: "hello world" });
    expect(t.push("hello world how", win(0, 2000))).toEqual({
      stable: "hello world",
      tentative: "how",
    });
    expect(t.text()).toBe("hello world how");
  });

  test("regression: rolling window starting mid-utterance never duplicates", () => {
    const t = createTranscriptTracker();
    t.push("the quick brown fox jumps over the lazy dog", win(0, 10_000));
    // Window rolled 1s: first word cut ("quick" -> "uick"). Old join: k=0 -> append.
    t.push("uick brown fox jumps over the lazy dog and runs", win(1000, 11_000));
    // Last tentative word revised ("runs" -> "ran"). Old join: k=0 -> append.
    t.push("brown fox jumps over the lazy dog and ran away", win(2000, 12_000));
    // First word reworded and two more words.
    t.push("Fox jumped over the lazy dog and ran away fast today", win(3000, 13_000));
    const text = t.text();
    expect(hasRepeatedPhrase(text)).toBe(false);
    expect(text).toBe("the quick brown fox jumps over the lazy dog and ran away fast today");
    // Repeating the same window keeps it stable without duplication.
    t.push("Fox jumped over the lazy dog and ran away fast today", win(3000, 13_000));
    expect(t.text()).toBe(text);
    expect(t.current()).toEqual({ stable: text, tentative: "" });
  });

  test("regression: Vietnamese tone shifts between windows still anchor", () => {
    const t = createTranscriptTracker();
    t.push("tôi muốn đi chợ mua rau", win(0, 10_000));
    t.push("muon di cho mua rau và thịt", win(1000, 11_000));
    expect(t.text()).toBe("tôi muốn đi chợ mua rau và thịt");
  });

  test("stable never shrinks", () => {
    const t = createTranscriptTracker();
    t.push("a b c", win(0, 3000));
    t.push("a b c d", win(0, 4000));
    const before = t.current().stable;
    t.push("totally different words", win(1000, 5000));
    expect(t.current().stable.startsWith(before)).toBe(true);
  });

  test("reset clears everything", () => {
    const t = createTranscriptTracker();
    t.push("a b", win(0, 1000));
    t.push("a b c", win(0, 2000));
    t.reset();
    expect(t.current()).toEqual({ stable: "", tentative: "" });
    expect(t.text()).toBe("");
    // After reset the next push is a first observation again.
    expect(t.push("x y", win(0, 1000))).toEqual({ stable: "", tentative: "x y" });
  });
});
