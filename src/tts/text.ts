// Text preparation for TTS: markdown -> speakable text, sentence/language
// segmentation, and chunking. Pure functions, no I/O.
//
// Ported from lib/tts.js (sanitizeSpokenText, localSpeechCleanup,
// summarizeMarkdownTable, summarizeMermaidForSpeech) and lib/tts/lang.js.

import type { SpeechLang, SpeechSegment } from "../types.ts";

export const MAX_SEGMENT_CHARS = 240;

// ---------------------------------------------------------------- markdown

const MERMAID_FENCE_RE = /```mermaid[^\S\n]*\r?\n?([\s\S]*?)```/gi;
const MERMAID_DECL_RE =
  /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|mindmap|journey|gitGraph)\b/i;
const MERMAID_LINE_RE = /-->|---|==>|-\.->|\[|\]|\(|\)/;
const MERMAID_DECL_MAX_LEN = 32;
const MERMAID_LABEL_CAP = 6;
const TABLE_BLOCK_RE = /((?:^[ \t]*\|.*\|[ \t]*$\n?){2,})/gm;
const TABLE_ROW_CAP = 3;
const TABLE_TEXT_CAP = 320;

function splitTableCells(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/** A literal table read is noise: say the columns and the first few rows. */
export function summarizeTable(block: string): string {
  const lines = block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));
  const headerLine = lines.find((line) => !isTableSeparator(line));
  if (headerLine === undefined) return "Table.";
  const headers = splitTableCells(headerLine).filter(Boolean);
  const rows = lines
    .slice(lines.indexOf(headerLine) + 1)
    .filter((line) => !isTableSeparator(line))
    .map((line) => splitTableCells(line).filter(Boolean))
    .filter((cells) => cells.length > 0);
  if (headers.length === 0 && rows.length === 0) return "Table.";
  const shown = rows.slice(0, TABLE_ROW_CAP).map((cells) => cells.join(", "));
  let out = headers.length > 0 ? `Table with columns ${headers.join(", ")}.` : "Table.";
  if (rows.length > 0) {
    out += ` ${rows.length} row${rows.length === 1 ? "" : "s"}: ${shown.join("; ")}.`;
    if (rows.length > shown.length) out += ` And ${rows.length - shown.length} more.`;
  }
  return out.length > TABLE_TEXT_CAP ? `${out.slice(0, TABLE_TEXT_CAP - 1)}…` : out;
}

export function summarizeMermaid(code: string): string {
  const firstLine =
    code
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const kind = /^(graph|flowchart)\b/i.exec(firstLine)?.[1]?.toLowerCase() ?? "";
  const labels = [...code.matchAll(/\[([^[\]]+)\]/g)]
    .map((m) => (m[1] ?? "").trim())
    .filter(Boolean)
    .slice(0, MERMAID_LABEL_CAP);
  const what = kind ? `Diagram, ${kind}` : "Diagram";
  return labels.length > 0 ? `${what}: ${labels.join(", ")}.` : `${what}.`;
}

function replaceUnfencedMermaid(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (MERMAID_DECL_RE.test(line.trim()) && line.trim().length <= MERMAID_DECL_MAX_LEN) {
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? "").trim() === "") j++;
      const body: string[] = [];
      let diagram = true;
      for (; j < lines.length; j++) {
        const next = lines[j] ?? "";
        if (next.trim() === "") break;
        if (!MERMAID_LINE_RE.test(next)) {
          diagram = false;
          break;
        }
        body.push(next);
      }
      if (diagram && body.length > 0) {
        kept.push(summarizeMermaid([line, ...body].join("\n")));
        i = j - 1;
        continue;
      }
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function splitIdentifier(token: string): string {
  return token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
}

/** One whitespace-free token -> how it should be read aloud. */
function speakToken(tok: string): string {
  const m = /^(.*?)([.,;:!?)]*)$/.exec(tok);
  const core = m?.[1] ?? tok;
  const tail = m?.[2] ?? "";
  if (/^https?:\/\//i.test(core)) {
    const domain = core.replace(/^https?:\/\/([^/?#]+).*$/i, "$1");
    return `${domain.replace(/\./g, " dot ")}${tail}`;
  }
  // Paths (/a/b, ~/a, ./a, a/b/c): only the last segment is worth hearing.
  const isPath = /^(~|\.{1,2})?\//.test(core) || /\/.*\//.test(core);
  const base = isPath || core.includes("/") ? core.slice(core.lastIndexOf("/") + 1) : core;
  if (/^\w[\w.-]*\.[a-z0-9]{1,4}$/i.test(base)) {
    const dot = base.lastIndexOf(".");
    return `${splitIdentifier(base.slice(0, dot))} dot ${base.slice(dot + 1)}${tail}`;
  }
  return `${splitIdentifier(isPath ? base : core)}${tail}`;
}

/** Headings and list items become their own sentences for better prosody. */
function terminateLine(line: string): string {
  const trimmed = line.trimEnd();
  if (!trimmed || /[.!?…:;,]$/.test(trimmed)) return trimmed;
  return `${trimmed}.`;
}

/**
 * Deterministic markdown -> spoken text. Code blocks become "code snippet",
 * inline code / identifiers are split into words, links keep their label,
 * URLs become their domain, paths their last segment, tables and diagrams a
 * short summary.
 */
export function prepareSpeech(markdown: string): string {
  if (!markdown) return "";
  let out = markdown.replace(/\r\n?/g, "\n");
  out = out.replace(MERMAID_FENCE_RE, (_m, code: string) => `\n${summarizeMermaid(code)}\n`);
  out = replaceUnfencedMermaid(out);
  out = out.replace(TABLE_BLOCK_RE, (block: string) => `\n${summarizeTable(block)}\n`);
  out = out.replace(/```[\s\S]*?```/g, " code snippet. ");
  // An unterminated fence (truncated message) hides everything after it.
  out = out.replace(/```[\s\S]*$/, " code snippet. ");
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => ` ${splitIdentifier(code)} `);
  out = out.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  out = out.replace(/<[^>]+>/g, " ");
  out = out.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "");
  const lines = out.split("\n");
  out = lines
    .map((line, i) => {
      const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
      if (heading) return terminateLine(heading[1] ?? "");
      const bullet = /^[>\s]*[-*+]\s+(.*)$/.exec(line);
      if (bullet) return terminateLine(bullet[1] ?? "");
      const quoted = line.replace(/^\s*>\s?/, "");
      const paragraphEnd = i === lines.length - 1 || (lines[i + 1] ?? "").trim() === "";
      return paragraphEnd || /^\s*\d+[.)]\s+\S/.test(quoted) ? terminateLine(quoted) : quoted;
    })
    .join("\n");
  out = out.replace(/(\*\*|__)(.*?)\1/g, "$2");
  out = out.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1$2");
  out = out
    .split(/(\s+)/)
    .map((tok) => (!tok || /^\s+$/.test(tok) ? tok : speakToken(tok)))
    .join("");
  return out
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/([.!?])(?:\s*\.)+/g, "$1")
    .trim();
}

// ---------------------------------------------------------------- language

const VI_CHAR_RE = /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/i;
const VI_WORD_THRESHOLD = 0.15;

/** "vi" when at least 15% of words carry Vietnamese diacritics, else "en". */
export function detectLang(text: string): SpeechLang {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "en";
  const vi = words.filter((w) => VI_CHAR_RE.test(w)).length;
  return vi / words.length >= VI_WORD_THRESHOLD ? "vi" : "en";
}

// ---------------------------------------------------------------- segments

function splitSentences(text: string): string[] {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return [];
  return flat
    .split(/(?<=[.!?…])\s+(?=[\p{Lu}\p{N}"“'‘([])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Split one over-long piece at `sep` boundaries, else words, else hard cut. */
function splitLong(piece: string, maxChars: number): string[] {
  if (piece.length <= maxChars) return [piece];
  for (const sep of [/(?<=[,;:])\s+/, /\s+/]) {
    const parts = piece.split(sep).filter(Boolean);
    if (parts.length < 2) continue;
    return packParts(
      parts.flatMap((p) => splitLong(p, maxChars)),
      maxChars,
    );
  }
  const out: string[] = [];
  for (let i = 0; i < piece.length; i += maxChars) out.push(piece.slice(i, i + maxChars));
  return out;
}

/** Greedily join parts with spaces while staying within maxChars. */
function packParts(parts: readonly string[], maxChars: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const part of parts) {
    if (current && current.length + 1 + part.length > maxChars) {
      out.push(current);
      current = "";
    }
    current = current ? `${current} ${part}` : part;
  }
  if (current) out.push(current);
  return out;
}

/**
 * Sentences grouped by language (adjacent same-language sentences join),
 * then every group chunked to <= maxChars at sentence, then comma, then word
 * boundaries.
 */
export function splitSegments(text: string, opts?: { maxChars?: number }): SpeechSegment[] {
  const maxChars = Math.max(20, opts?.maxChars ?? MAX_SEGMENT_CHARS);
  const groups: { lang: SpeechLang; sentences: string[] }[] = [];
  for (const sentence of splitSentences(text)) {
    const lang = detectLang(sentence);
    const last = groups.at(-1);
    if (last && last.lang === lang) last.sentences.push(sentence);
    else groups.push({ lang, sentences: [sentence] });
  }
  const out: SpeechSegment[] = [];
  for (const group of groups) {
    const pieces = group.sentences.flatMap((s) => splitLong(s, maxChars));
    for (const chunk of packParts(pieces, maxChars)) out.push({ lang: group.lang, text: chunk });
  }
  return out;
}

/**
 * VieNeu code-switches vi+en in one pass, so for it adjacent segments merge
 * up to maxChars regardless of language (lang = character majority). Piper
 * needs one voice per language, so its per-language segments stay as-is.
 */
export function mergeForEngine(
  segs: readonly SpeechSegment[],
  engineHandlesMixed: boolean,
  opts?: { maxChars?: number },
): SpeechSegment[] {
  if (!engineHandlesMixed) return [...segs];
  const maxChars = opts?.maxChars ?? MAX_SEGMENT_CHARS;
  const out: SpeechSegment[] = [];
  let parts: SpeechSegment[] = [];
  let length = 0;
  const flush = (): void => {
    if (parts.length === 0) return;
    let vi = 0;
    let en = 0;
    for (const p of parts) {
      if (p.lang === "vi") vi += p.text.length;
      else en += p.text.length;
    }
    const lang: SpeechLang = vi === en ? (parts[0]?.lang ?? "vi") : vi > en ? "vi" : "en";
    out.push({ lang, text: parts.map((p) => p.text).join(" ") });
    parts = [];
    length = 0;
  };
  for (const seg of segs) {
    if (!seg.text) continue;
    if (parts.length > 0 && length + 1 + seg.text.length > maxChars) flush();
    length += (parts.length > 0 ? 1 : 0) + seg.text.length;
    parts.push(seg);
  }
  flush();
  return out;
}
