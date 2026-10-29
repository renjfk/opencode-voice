// Streaming-transcript stability logic (STAGE 1, local streaming dictation).
//
// Rolling-window STT re-transcribes overlapping audio on every tick, so each
// hypothesis restates words the previous one already contained. Blindly
// appending every hypothesis would duplicate words; blindly replacing would
// flicker committed text. This module splits each hypothesis into:
//
//   stable   - prefix confirmed by successive hypotheses; monotonic, never
//              rewritten once emitted (callers can render/commit it).
//   tentative - unconfirmed tail; replaced wholesale on every update.
//
// Alignment scheme (bounded-utterance overlap join, NOT time-anchored):
//
// whisper-server `/inference` with `response_format=json` returns
// `{ "text": "..." }` - text only, no audio timestamps. `verbose_json`
// returns `{ text, segments: [{ start, end, text, ... }], ... }` where
// segment `start`/`end` are seconds RELATIVE TO THE SUBMITTED SNAPSHOT (each
// rolling window restarts at 0; verified against a live local whisper-server,
// see `.opencode/loopd/goals/17bca58e-.../whisper-verbose-fixture.json`).
// Consecutive snapshots therefore cannot share an absolute clock, and
// whisper's word timestamps jitter at window edges, so segments are never
// used as cross-window commit pointers. Instead each new hypothesis is joined
// onto the assembled transcript by maximal word suffix-prefix overlap:
//
//   assembled = stable + tentative (previous)
//   k = longest suffix of assembled that equals a prefix of the hypothesis
//   novel = hypothesis after that overlap; assembled' = assembled + novel
//
// The whole previously assembled transcript becomes stable once any overlap
// re-observes it (every old word was just heard again); only the novel tail
// stays tentative. When the window rolls forward the hypothesis no longer
// contains the historical prefix, and the overlap anchors on the shared
// middle - no duplication, no loss.
//
// Revision policy: when the hypothesis shares a longer prefix with the
// assembled transcript FROM THE START than the suffix overlap (whisper
// restated the same region with different words), it is a self-correction,
// not new speech. Corrections inside the tentative region replace the tail;
// corrections touching committed (stable) words FREEZE stable - stable is
// never rewritten - and the tail shows the hypothesis minus whatever stable
// prefix it still shares, so no word is ever emitted twice.
//
// Update rule summary:
//   0. Final stop-tail decode covering the utterance from t=0 supersedes the
//      rolling assembly outright (tentative = hypothesis); guarded by length
//      so a collapsed decode can never wipe a good transcript.
//   1. Empty hypothesis: keep stable, clear the tail (pause/silence).
//   2. c = common word-prefix(assembled, hypothesis), k = overlap(assembled,
//      hypothesis). If c > k: revision path (see above).
//   3. Else: assembled' = assembled + hypothesis[k:]; stable = assembled
//      (when k > 0, or when assembled was empty nothing is stable yet);
//      tentative = hypothesis[k:]. With no overlap at all (k = 0, c = 0)
//      the hypothesis is genuinely new speech after a gap: appended whole.
//   4. The first hypothesis only fills tentative (nothing is confirmed by a
//      single observation).
//
// Comparison is word level, punctuation/case/diacritic-insensitive; original
// words are preserved for display. Pure punctuation tokens must match exactly
// to count.
// preserved for display. Pure punctuation tokens must match exactly to count.
//
// Memory: O(transcript words). The tracker holds stable words, the tentative
// tail, and the last window hints - no history list, no per-tick
// accumulation. Long dictations grow only the transcript itself (the output).
import { sttLog } from "./stt-log.js";

export function normalizeStabilityWord(word) {
  // Diacritic-insensitive: whisper re-decodes shared Vietnamese audio with
  // shifting tone marks between windows, so exact matching breaks anchors on
  // every tick (nothing stabilizes) or appends whole hypotheses as
  // duplicates. Strip combining marks after NFD; Vietnamese đ/Đ do not
  // decompose, so map them explicitly (after lowercase, only đ occurs).
  // Genuine repetitions still work: overlap needs multi-word contiguous
  // runs, not single words.
  return String(word || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export function splitWords(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function sameStabilityWord(aRaw, bRaw) {
  const a = normalizeStabilityWord(aRaw);
  const b = normalizeStabilityWord(bRaw);
  if (a !== b) return false;
  // Both sides reduced to nothing (e.g. "--" vs "…"): only equal when the
  // raw tokens are identical so punctuation noise cannot confirm words.
  if (!a && aRaw !== bRaw) return false;
  return true;
}

/**
 * Length (in words) of the longest common prefix of two word arrays,
 * compared with stability normalization (case/punctuation-insensitive).
 */
export function commonWordPrefixLength(aWords, bWords) {
  const limit = Math.min(aWords.length, bWords.length);
  let n = 0;
  for (let i = 0; i < limit; i++) {
    if (!sameStabilityWord(aWords[i], bWords[i])) break;
    n += 1;
  }
  return n;
}

/**
 * Maximal k such that the last k words of `assembled` equal the first k
 * words of `hypothesis` (stability normalization). Always >= 0.
 */
export function overlapJoinLength(assembledWords, hypothesisWords) {
  const limit = Math.min(assembledWords.length, hypothesisWords.length);
  for (let k = limit; k > 0; k--) {
    let ok = true;
    for (let i = 0; i < k; i++) {
      if (!sameStabilityWord(assembledWords[assembledWords.length - k + i], hypothesisWords[i])) {
        ok = false;
        break;
      }
    }
    if (ok) return k;
  }
  return 0;
}

/**
 * Strip a stable word-prefix from hypothesis words. Returns the remaining
 * words, or null when the hypothesis does not start with the stable prefix
 * (whisper revised already-committed words - caller must not advance).
 */
export function stripStablePrefix(stableWords, hypothesisWords) {
  if (stableWords.length === 0) return hypothesisWords.slice();
  if (hypothesisWords.length < stableWords.length) return null;
  const n = commonWordPrefixLength(stableWords, hypothesisWords.slice(0, stableWords.length));
  if (n < stableWords.length) return null;
  return hypothesisWords.slice(stableWords.length);
}

/**
 * Create a stability tracker. `onUpdate`-style callbacks live in the
 * streaming controller - this stays a pure text function for testability.
 *
 * `update(hypothesisText, windowHints)` accepts optional snapshot metadata
 * ({ absoluteStartMs, absoluteEndMs, seq, final }) describing which audio
 * window the hypothesis was decoded from. The hints are retained for
 * coverage accounting (see getState().lastWindow) and future alignment
 * work; text assembly itself is overlap-based because snapshot-relative
 * segment times cannot anchor a cross-window commit pointer. One exception:
 * a final stop-tail decode covering the utterance from t=0 supersedes the
 * rolling assembly outright (see update) instead of joining it.
 */
export function createStabilityTracker() {
  let stableWords = [];
  let tentativeWords = [];
  let updates = 0;
  let lastWindow = null;

  function update(hypothesisText, windowHints = null) {
    const hypoWords = splitWords(hypothesisText);
    updates += 1;
    if (windowHints && typeof windowHints === "object") {
      lastWindow = { ...windowHints };
    }

    // Empty hypothesis: keep stable, clear the tail (speaker paused or the
    // window caught only silence). It confirms nothing.
    if (hypoWords.length === 0) {
      tentativeWords = [];
      return snapshot();
    }

    // Full-utterance stop-tail decode supersedes the rolling assembly.
    // update() is also fed the final transcription (hints.final) decoded
    // from the stop-tail WAV; when that window covers the utterance from t=0
    // (spool-backed, or a ring tail starting at 0 for short dictations), a
    // single full-context decode beats stitched windows. Joining it would
    // append nearly the whole transcript again whenever the re-decode
    // rewords the head and breaks every anchor - so replace instead.
    // Guarded by length so a collapsed model output can never wipe a good
    // transcript; tail-only and suspiciously short finals still go through
    // the normal join below.
    if (
      windowHints &&
      windowHints.final === true &&
      (windowHints.absoluteStartMs ?? Infinity) <= 1000
    ) {
      const total = stableWords.length + tentativeWords.length;
      if (total === 0 || hypoWords.length * 2 >= total) {
        try {
          sttLog(
            "transcript.final-replace",
            `hypoWords=${hypoWords.length} assembledWords=${total} absoluteStartMs=${windowHints.absoluteStartMs}`,
          );
        } catch {}
        stableWords = [];
        tentativeWords = hypoWords.slice();
        return snapshot();
      }
      try {
        sttLog(
          "transcript.final-join",
          `hypoWords=${hypoWords.length} assembledWords=${total} absoluteStartMs=${windowHints.absoluteStartMs}`,
        );
      } catch {}
    }

    const assembled = stableWords.concat(tentativeWords);

    // First observation of the session: everything is tentative.
    if (assembled.length === 0) {
      tentativeWords = hypoWords.slice();
      return snapshot();
    }

    const k = overlapJoinLength(assembled, hypoWords);
    const c = commonWordPrefixLength(assembled, hypoWords);

    if (c > k) {
      // Revision: the hypothesis restates the same region with different
      // words instead of extending it with new speech.
      if (c < stableWords.length) {
        // Correction touches committed words: freeze stable (never rewrite)
        // and show the hypothesis minus whatever stable prefix it still
        // shares, so the shared head is never emitted twice.
        const strip = commonWordPrefixLength(stableWords, hypoWords);
        tentativeWords = hypoWords.slice(strip);
        return snapshot();
      }
      // Correction is inside the tentative region: rebase the tail onto the
      // shared prefix. Stable is untouched.
      const rebased = assembled.slice(0, c).concat(hypoWords.slice(c));
      tentativeWords = rebased.slice(stableWords.length);
      return snapshot();
    }

    // Normal advance (possibly after the window rolled forward and dropped
    // the historical prefix - the overlap anchors on the shared middle).
    const novel = hypoWords.slice(k);
    if (assembled.length > 0 && k > 0) {
      // Every previously assembled word was just re-observed: confirm it.
      stableWords = assembled.slice();
    }
    // k = 0 with no common prefix is genuinely new speech after a gap: the
    // whole hypothesis is novel and stable stays as-is (no confirmation).
    tentativeWords = novel.slice();
    return snapshot();
  }

  function snapshot() {
    return {
      stableText: stableWords.join(" "),
      tentativeText: tentativeWords.join(" "),
      updates,
    };
  }

  /**
   * Commit the tentative tail (used on stop): the final window is never
   * re-observed, so its tail can never "stabilize" by agreement. Returns the
   * full transcript and clears the tentative tail.
   */
  function commitTail() {
    if (tentativeWords.length > 0) {
      stableWords = stableWords.concat(tentativeWords);
      tentativeWords = [];
    }
    return snapshot();
  }

  function reset() {
    stableWords = [];
    tentativeWords = [];
    updates = 0;
    lastWindow = null;
  }

  function getState() {
    return { ...snapshot(), lastWindow };
  }

  return { update, commitTail, reset, getState };
}
