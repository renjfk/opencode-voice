// Voice bubbles: chunk normalized text into short, WhatsApp-style voice
// messages that play sequentially with a small inter-bubble pause.
//
// We keep a small in-memory history of the most recent bubbles per session so
// the user can replay any of them on demand via the `/tts-bubbles` command.

const DEFAULT_TARGET_CHARS = 140;
const MIN_TARGET_CHARS = 60;
const MAX_TARGET_CHARS = 240;
const MAX_BUBBLES = 50;

const CHARS_PER_SECOND = 14;
const INTER_BUBBLE_PAUSE_MS = 250;

// Regex matches a sentence boundary: one of ".", "!", "?" followed by
// whitespace and an optional opening quote. We keep the punctuation attached
// to the previous sentence so Piper reads it naturally.
const SENTENCE_BREAK = /([.!?](?:["')\]]*))\s+/g;

// Newline boundaries are stronger than sentence boundaries.
const PARAGRAPH_BREAK = /\n{2,}/g;

// Single newlines also act as soft boundaries when followed by a capital
// letter (typical of list items or speaker turns).
const LINE_BREAK = /\n/g;

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Split `text` into chunks that approximate the target character budget while
 * respecting sentence, paragraph and line boundaries. Returns an array of
 * non-empty trimmed chunks in source order.
 *
 * The algorithm:
 *   1. Split on paragraph breaks (double newline).
 *   2. Inside each paragraph, walk the text greedily up to `targetChars`,
 *      preferring to cut on a sentence boundary when one is available within
 *      the budget, otherwise on a single newline, otherwise on the budget.
 *   3. Drop empty chunks and re-trim.
 */
export function chunkText(text, targetChars = DEFAULT_TARGET_CHARS) {
  if (typeof text !== "string" || text.length === 0) return [];
  const target = clamp(targetChars, MIN_TARGET_CHARS, MAX_TARGET_CHARS);

  const paragraphs = text.split(PARAGRAPH_BREAK);
  const chunks = [];

  for (const paragraphRaw of paragraphs) {
    if (!paragraphRaw.trim()) continue;

    // Normalize whitespace for length-based decisions but keep the raw string
    // for boundary detection so we can still cut on newlines and punctuation.
    const paragraph = paragraphRaw.replace(/[ \t]+/g, " ");
    const normalized = paragraph.replace(/\s+/g, " ").trim();

    if (normalized.length <= target) {
      chunks.push(normalized);
      continue;
    }

    // Walk the paragraph, cutting on the best available boundary inside the
    // [cursor, cursor + target] window. We expand the window slightly when
    // the only boundary is far away so we never produce a 5KB bubble.
    let cursor = 0;
    const hardMax = target * 2;
    while (cursor < paragraph.length) {
      const remaining = paragraph.length - cursor;
      if (remaining <= target) {
        const tail = paragraph.slice(cursor).replace(/\s+/g, " ").trim();
        if (tail) chunks.push(tail);
        break;
      }

      const window = paragraph.slice(cursor, cursor + Math.min(hardMax, remaining));
      const cut = pickCut(window, target);
      const piece = paragraph
        .slice(cursor, cursor + cut)
        .replace(/\s+/g, " ")
        .trim();
      if (piece) chunks.push(piece);
      cursor += cut;
    }
  }

  return chunks;
}

function pickCut(window, target) {
  // 1. Prefer the latest sentence boundary within [target * 0.6, target].
  const lower = Math.max(1, Math.floor(target * 0.6));
  const upper = Math.min(window.length, target);

  let lastSentence = -1;
  SENTENCE_BREAK.lastIndex = 0;
  let match;
  while ((match = SENTENCE_BREAK.exec(window)) !== null) {
    const end = match.index + match[0].length;
    if (end >= lower && end <= upper) lastSentence = end;
  }
  if (lastSentence > 0) return lastSentence;

  // 2. Fall back to a single-newline boundary inside the window.
  LINE_BREAK.lastIndex = 0;
  let lastLine = -1;
  while ((match = LINE_BREAK.exec(window)) !== null) {
    const end = match.index + match[0].length;
    if (end <= upper) lastLine = end;
  }
  if (lastLine > 0) return lastLine;

  // 3. Last resort: cut on the budget boundary (between words when possible).
  const slice = window.slice(0, upper);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > lower) return lastSpace + 1;
  return upper;
}

/**
 * Approximate spoken duration in seconds for a given text. Piper is roughly
 * 12-16 chars/s for English so we use 14 as a sensible default. The caller
 * can override via `charsPerSecond` for languages that speak faster.
 */
export function estimateDuration(text, charsPerSecond = CHARS_PER_SECOND) {
  if (typeof text !== "string" || text.length === 0) return 0;
  if (!Number.isFinite(charsPerSecond) || charsPerSecond <= 0) return 0;
  return Math.max(1, Math.round(text.length / charsPerSecond));
}

/**
 * Append a bubble to the persistent history stored under `tts.bubbles` in kv.
 * The history is capped to `MAX_BUBBLES` entries (oldest first removed).
 */
export function recordBubble(kv, bubble) {
  if (!kv || !bubble || typeof bubble.text !== "string") return null;
  const entry = {
    id: bubble.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: bubble.text,
    chars: bubble.text.length,
    duration: Number.isFinite(bubble.duration) ? bubble.duration : estimateDuration(bubble.text),
    sessionID: bubble.sessionID || null,
    sessionTitle: bubble.sessionTitle || null,
    source: bubble.source || "auto",
    ts: bubble.ts || Date.now(),
  };

  const existing = kv.get("tts.bubbles", []);
  const list = Array.isArray(existing) ? existing.slice() : [];
  list.push(entry);
  while (list.length > MAX_BUBBLES) list.shift();
  kv.set("tts.bubbles", list);
  return entry;
}

/**
 * Read the bubble history. Returns the most recent `limit` bubbles in
 * reverse-chronological order unless `reverse=false`.
 */
export function getBubbles(kv, { limit = 10, reverse = true } = {}) {
  if (!kv) return [];
  const stored = kv.get("tts.bubbles", []);
  if (!Array.isArray(stored) || stored.length === 0) return [];
  const ordered = reverse ? stored.slice().reverse() : stored.slice();
  return ordered.slice(0, Math.max(0, limit));
}

/**
 * Clear the bubble history.
 */
export function clearBubbles(kv) {
  if (!kv) return;
  kv.set("tts.bubbles", []);
}

export const CONSTANTS = {
  DEFAULT_TARGET_CHARS,
  MIN_TARGET_CHARS,
  MAX_TARGET_CHARS,
  MAX_BUBBLES,
  CHARS_PER_SECOND,
  INTER_BUBBLE_PAUSE_MS,
};

export function interBubblePauseMs() {
  return INTER_BUBBLE_PAUSE_MS;
}
