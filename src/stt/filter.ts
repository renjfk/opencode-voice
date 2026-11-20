// Transcript cleanup and whisper-hallucination detection.

/**
 * Remove whisper annotations and normalize spacing. Strips anything in
 * [brackets] or (parens) - [BLANK_AUDIO], [Music], (music), (laughs),
 * timestamp prefixes - plus music notes, then collapses whitespace.
 */
export function cleanTranscript(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[♪♫♬]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Phrases whisper "hears" on silence/noise (YouTube outros, EN + VI).
// Entries are pre-normalized (lowercase, no diacritics, đ -> d).
const KNOWN_HALLUCINATIONS = [
  "hay subscribe cho kenh ghien mi go",
  "hay subscribe cho kenh",
  "subscribe cho kenh ghien mi go",
  "dang ky kenh",
  "cam on cac ban da xem",
  "alo alo nghe toi noi gi khong",
  "alo alo nghe toi noi gi",
  "thank you",
  "thank you for watching",
  "thanks for watching",
  "please subscribe",
  "subscribe to my channel",
  "like and subscribe",
  "you",
];

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when the transcript is empty or looks like a whisper hallucination.
 * Short entries ("you", "thank you") only match the WHOLE transcript;
 * substring matching applies to entries of 3+ words only, so real dictation
 * like "can you fix the test" survives.
 */
export function isLikelyHallucination(text: string): boolean {
  const t = normalize(text);
  if (!t) return true;
  const hit = KNOWN_HALLUCINATIONS.some(
    (k) => t === k || (k.split(" ").length >= 3 && t.includes(k)),
  );
  if (hit) return true;
  if (/subscribe/.test(t) && /(kenh|channel|ghien)/.test(t)) return true;
  // Very short outputs on silence that mention outro words.
  if (t.split(" ").length <= 3 && /subscribe|kenh|watching/.test(t)) return true;
  return false;
}
