// Stable/tentative transcript assembly for rolling-window streaming STT.
//
// Every tick re-transcribes the last ~10s of audio, so each hypothesis
// restates words already shown. The tracker joins each hypothesis onto the
// assembled transcript (stable + tentative) by word overlap:
//
//   stable    - words confirmed by two observations; never rewritten.
//   tentative - the unconfirmed tail; replaced on every update.
//
// Join rule (per hypothesis H, assembled A = stable + tentative):
//   1. Anchor: a contiguous run H[s..s+k) == A[e-k..e) where s <= 3 (the
//      window may start mid-word, so the first hypothesis words can be cut or
//      reworded) and e >= stable.length (the anchor may end anywhere inside
//      the tentative region; tentative words after e are replaced). Longest
//      run wins. Result: stable = A[0..e), tentative = H[s+k..].
//   2. No anchor and the window does not overlap the previous one: genuinely
//      new speech after a gap, so commit A and append H as tentative.
//   3. No anchor but the windows overlap: H restates audio we already have.
//      Never append it. Keep stable, and REPLACE tentative with the part of H
//      after where stable's last words occur in H (all of H when not found).
//
// Comparison is word level, case/punctuation/diacritic-insensitive (whisper
// shifts Vietnamese tone marks between windows). Original words are kept for
// display. Memory is O(transcript words).

import type { StreamingPartial } from "../types.ts";

export interface TranscriptWindow {
  /** Absolute start of the decoded audio, ms since session start. */
  readonly startMs: number;
  /** Absolute end of the decoded audio, ms since session start. */
  readonly endMs: number;
}

export interface TranscriptTracker {
  push(hypothesis: string, window: TranscriptWindow): StreamingPartial;
  current(): StreamingPartial;
  /** stable + tentative, single-spaced. */
  text(): string;
  reset(): void;
}

export interface Anchor {
  /** Leading hypothesis words skipped before the run. */
  readonly skip: number;
  /** Exclusive end index of the run in the assembled words. */
  readonly end: number;
  /** Run length in words. */
  readonly length: number;
}

export interface JoinResult {
  readonly stable: readonly string[];
  readonly tentative: readonly string[];
}

export const MAX_ANCHOR_SKIP = 3;
/** Longest stable suffix searched for when locating stable's end in a hypothesis. */
const MAX_SUFFIX_WORDS = 8;
/** Trailing stable words that may be reworded when locating stable's end. */
const MAX_SUFFIX_DROP = 2;

export function normalizeWord(word: string): string {
  // Vietnamese đ does not decompose under NFD; map it explicitly.
  return word
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export function splitWords(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

export function sameWord(a: string, b: string): boolean {
  const na = normalizeWord(a);
  if (na !== normalizeWord(b)) return false;
  // Pure punctuation tokens only match when identical.
  return na !== "" || a === b;
}

/** Number of equal words starting at a[ai] and b[bi]. */
export function matchRun(
  a: readonly string[],
  ai: number,
  b: readonly string[],
  bi: number,
): number {
  let n = 0;
  for (;;) {
    const x = a[ai + n];
    const y = b[bi + n];
    if (x === undefined || y === undefined || !sameWord(x, y)) return n;
    n += 1;
  }
}

/**
 * Longest run of hypothesis words (after skipping at most `maxSkip` leading
 * words) that matches assembled words and ends at or after `stableLength`.
 * Ties prefer fewer skipped words, then the later end (less duplication).
 */
export function findAnchor(
  assembled: readonly string[],
  stableLength: number,
  hypothesis: readonly string[],
  maxSkip: number = MAX_ANCHOR_SKIP,
): Anchor | null {
  let best: Anchor | null = null;
  for (let skip = 0; skip <= maxSkip && skip < hypothesis.length; skip++) {
    const available = hypothesis.length - skip;
    // Single-word anchors only when nothing longer is possible.
    const minLength = Math.max(1, Math.min(2, available, assembled.length));
    const firstStart = Math.max(0, stableLength - available);
    for (let start = firstStart; start < assembled.length; start++) {
      const length = matchRun(assembled, start, hypothesis, skip);
      if (length < minLength) continue;
      const end = start + length;
      if (end < stableLength) continue;
      if (
        best === null ||
        length > best.length ||
        (length === best.length && skip === best.skip && end > best.end)
      ) {
        best = { skip, end, length };
      }
    }
  }
  return best;
}

/**
 * Index in `hypothesis` just after the end of `stable`, found by locating
 * stable's last words (longest suffix first, last occurrence). Allows the
 * final 1-2 stable words to be reworded. Null when not found.
 */
export function locateStableEnd(
  stable: readonly string[],
  hypothesis: readonly string[],
): number | null {
  for (let drop = 0; drop <= MAX_SUFFIX_DROP; drop++) {
    const endIdx = stable.length - drop;
    const minR = drop === 0 ? 1 : 2;
    for (let r = Math.min(MAX_SUFFIX_WORDS, endIdx); r >= minR; r--) {
      for (let h = hypothesis.length - r; h >= 0; h--) {
        if (matchRun(stable, endIdx - r, hypothesis, h) >= r) {
          return Math.min(hypothesis.length, h + r + drop);
        }
      }
    }
  }
  return null;
}

/** Pure join step; see the file header for the rules. */
export function joinHypothesis(
  stable: readonly string[],
  tentative: readonly string[],
  hypothesis: readonly string[],
  overlapsPrevious: boolean,
): JoinResult {
  // Silence or a failed decode confirms nothing and revises nothing.
  if (hypothesis.length === 0) return { stable, tentative };
  const assembled = [...stable, ...tentative];
  // A single observation confirms nothing.
  if (assembled.length === 0) return { stable, tentative: hypothesis };

  const anchor = findAnchor(assembled, stable.length, hypothesis);
  if (anchor) {
    return {
      stable: assembled.slice(0, anchor.end),
      tentative: hypothesis.slice(anchor.skip + anchor.length),
    };
  }
  // New speech after a gap: the old tail can never be re-observed, commit it.
  if (!overlapsPrevious) return { stable: assembled, tentative: hypothesis };
  if (stable.length === 0) return { stable, tentative: hypothesis };
  const at = locateStableEnd(stable, hypothesis);
  return { stable, tentative: hypothesis.slice(at ?? 0) };
}

export function createTranscriptTracker(): TranscriptTracker {
  let stable: readonly string[] = [];
  let tentative: readonly string[] = [];
  let lastWindow: TranscriptWindow | null = null;

  function current(): StreamingPartial {
    return { stable: stable.join(" "), tentative: tentative.join(" ") };
  }

  return {
    push(hypothesis, window) {
      const overlaps = lastWindow !== null && window.startMs < lastWindow.endMs;
      const next = joinHypothesis(stable, tentative, splitWords(hypothesis), overlaps);
      stable = next.stable;
      tentative = next.tentative;
      lastWindow = { startMs: window.startMs, endMs: window.endMs };
      return current();
    },
    current,
    text() {
      return [...stable, ...tentative].join(" ");
    },
    reset() {
      stable = [];
      tentative = [];
      lastWindow = null;
    },
  };
}
