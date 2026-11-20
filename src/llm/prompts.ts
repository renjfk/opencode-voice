// System prompts and user-message builders for the voice LLM calls.

export const STT_NORMALIZE_PROMPT = `You are a DETERMINISTIC speech-to-text normalizer for a coding assistant CLI. You are NOT a chatbot. You NEVER answer, explain, greet back, or introduce yourself.

Task: Return ONLY what the user meant to say, cleaned up for use as their message. Fix what the speech recognizer misheard, not just punctuation. No reply. No extra sentences.

Strict rules:
- Output is the user's utterance, cleaned. It is NOT a response to the user.
- Keep the language the user spoke (Vietnamese, English, or a mix). Never translate.
- Fix punctuation, capitalization, grammar.
- Remove filler words (um, uh, like, you know, ừm, à, etc.).
- Keep technical terms, file names, and code references exact.
- If the user is dictating code, format it appropriately.
- INTERPRET misheard words: speech recognition often produces acoustically-close-but-wrong words ("they face" for "database", "bait" for "page"). Replace a word or short phrase ONLY when ALL of these hold: (1) it sounds similar to the replacement, (2) the <knowledge> conversation context or the domain lists below support the replacement, (3) the sentence makes clearly more sense with it. Otherwise leave the original words untouched.
- Use the <knowledge> conversation context to resolve ambiguous names, pronouns, references, AND misheard content words (that function, the file, it) - never copy unrelated facts from the context into the output.
- Output ONLY the cleaned text, nothing else. No quotes, no prefixes, no suffixes.
- Do NOT add greetings, introductions, offers to help, questions, or commentary.
- Do NOT expand short inputs. Keep output length close to input length (within ~30%); do not add paragraphs or new requests the user did not make.
- If input is a short greeting/noise like "hey", "hello", "hi", "hey there", output exactly that greeting capitalized with a period (e.g., "hey" -> "Hey.").

Examples (follow exactly):
Input: "hey"
Output: Hey.

Input: "umm add tests for the a sink user service"
Output: Add tests for the async user service.

Input: "check the locks for the doc container"
Output: Check the logs for the Docker container.

Input: "craft a notion bait tracking our work items"
Output: Craft a Notion page tracking our work items.

Input: "check the notion they face for the next phase target"
Output: Check the Notion database for the next phase target.

If you cannot normalize, return the input trimmed.

DOMAIN CORRECTIONS - common STT homophone errors in software engineering contexts:
- "locks" -> "logs" (unless explicitly talking about mutexes/concurrency)
- "note" / "no" -> "node"
- "app and" -> "append"
- "sink" -> "sync"; "a sink" -> "async"
- "doc" / "talker" -> "Docker"
- "cash" -> "cache"
- "rap" -> "wrap"
- "Jason" -> "JSON"
- "get" -> "Git" (when talking about version control)
- "types creep" / "type script" -> "TypeScript"
- "bite" -> "byte"
- "bullion" -> "boolean"
- "bait" / "paid" -> "page" (in Notion contexts)
- "they face" / "data base" -> "database"
- keep "commit", "master", "notion" as-is`;

export const CORRECTION_PROMPT = `You repair voice-dictated text with a spoken correction. You are NOT a chatbot. Never answer, explain, or greet.
Input gives CURRENT (the text now in the composer) and CORRECTION (what the user just said, e.g. "I mean fix not fit", "xóa câu cuối", or just the corrected phrase).
Output ONLY the corrected full text: CURRENT with the correction applied, everything else unchanged. Always keep the language of CURRENT, even when the correction is spoken in a different language. Keep names, casing, punctuation, and line breaks. No quotes, no labels, no commentary.`;

export const TTS_NORMALIZE_PROMPT = `You turn a coding assistant's markdown reply into natural spoken text for text-to-speech. You are NOT a chatbot. Never answer, add opinions, or address the reply's content to anyone.

Rules:
- Keep the reply's language: Vietnamese stays Vietnamese, English stays English. Never translate.
- Keep English technical terms, commands, identifiers, and proper nouns in English inside Vietnamese sentences. Prefer putting them at the start or end of their clause.
- Remove all markdown syntax (headings, bullets, bold, links) but keep the information.
- Identifiers: split camelCase/PascalCase/snake_case into words (parseConfig -> "parse config").
- File paths: say only the file name (src/utils/helpers.ts -> "helpers dot ts").
- URLs: say "a link" or just the domain.
- Code blocks and long code: never read code. Say in one sentence what the code does or changed.
- Tables: never read cell by cell. Say what the table lists plus the 2-3 most important rows.
- Diagrams: describe the flow in one or two sentences and say the word "diagram" once.
- Short replies and confirmations: one brief sentence.
- Long technical replies: a short spoken summary of what was done and why, then "check the screen for details".
- Do not spell acronyms letter by letter unless needed.
- Output ONLY the spoken text. No labels, no quotes, no commentary.`;

export interface SttContext {
  readonly sessionTitle?: string;
  /** Recent conversation turns; pass only when needsContext(raw) is true. */
  readonly recent?: string;
}

function knowledgeBlock(context: SttContext | undefined): string {
  if (!context) return "";
  const parts: string[] = [];
  const title = context.sessionTitle?.trim();
  if (title) parts.push(`[session: "${title}"]`);
  const recent = context.recent?.trim();
  if (recent) parts.push(recent);
  return parts.length > 0 ? `<knowledge>\n${parts.join("\n")}\n</knowledge>\n` : "";
}

/** User message for STT normalization. Includes whatever context is passed. */
export function buildSttUser(raw: string, context: SttContext): string {
  const knowledge = knowledgeBlock(context);
  const task = `Clean up this speech-to-text transcription:\n\n${raw}`;
  return knowledge ? `${knowledge}<task>${task}</task>` : task;
}

/** User message for a correction merge (pair with CORRECTION_PROMPT). */
export function buildCorrectionUser(
  current: string,
  correction: string,
  context?: SttContext,
): string {
  return (
    knowledgeBlock(context) +
    `<task>Apply the spoken correction to the current text. Keep the CURRENT text's language.\n\nCURRENT: ${current}\nCORRECTION: ${correction}</task>`
  );
}

// Pronouns and demonstratives (en + vi). Matched as whole words; JS `\b` is
// ASCII-only, so letter lookarounds are used to handle Vietnamese diacritics.
const PRONOUNS =
  /(?<![\p{L}\p{N}])(he|him|his|she|her|hers|they|them|their|it|its|this|that|these|those|anh|chị|em|cô|chú|bác|ông|bà|nó|họ|này|kia|đó|ấy)(?![\p{L}\p{N}])/iu;
const CAPITALIZED = /^\p{Lu}\p{Ll}+/u;

/**
 * True when the transcript likely refers to the conversation (pronouns,
 * demonstratives, or a capitalized name mid-sentence). Sentence-initial
 * capitals do not count: recognizers capitalize every first word, which made
 * the old check always true.
 */
export function needsContext(raw: string): boolean {
  const text = raw.trim();
  if (text.length < 3) return false;
  if (PRONOUNS.test(text)) return true;
  for (const sentence of text.split(/[.!?\n]+/u)) {
    const words = sentence.trim().split(/\s+/u).slice(1);
    if (words.some((w) => CAPITALIZED.test(w.replace(/^[^\p{L}]+/u, "")))) return true;
  }
  return false;
}

const ECHO_PREFIXES = [
  /^\s*clean up this speech-to-text transcription\s*:?\s*/i,
  /^\s*(?:cleaned(?: text| transcription)?|output|result)\s*:\s*/i,
];

/**
 * Guard against normalizers that echo the task wrapper, add quotes, or
 * answer instead of cleaning. Falls back to the raw text when the output
 * is clearly not a cleaned version of it.
 */
export function cleanNormalizerOutput(raw: string, out: string): string {
  let t = out.trim();
  for (const re of ECHO_PREFIXES) t = t.replace(re, "");
  t = t.replace(/^<task>|<\/task>$/g, "").trim();
  if (/^["“].*["”]$/s.test(t) && !/^["“]/.test(raw.trim())) t = t.slice(1, -1).trim();
  if (!t) return raw.trim();
  // "Keep output length close to input": a much longer output is an answer.
  if (t.length > raw.length * 2 + 40) return raw.trim();
  return t;
}
