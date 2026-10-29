// Live-notes output: ordered Markdown transcript + lossless JSONL sidecar.
//
// Chunks are transcribed and normalized independently and may resolve out of
// order (a slow LLM normalize call on chunk N can finish after a fast one on
// chunk N+1). The writer buffers by sequence number and only appends once
// every earlier chunk has been written, so the files are always in
// recording order regardless of processing order.

import fs from "node:fs";
import path from "node:path";

export function formatClockTime(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function normalizeWord(w) {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Forced chunk splits carry ~overlapMs of duplicate audio into the next
 * chunk, so the transcribed text of consecutive chunks can share a few
 * words at the boundary. Drop the longest run (up to maxWords) of leading
 * words in `nextText` that exactly matches the trailing words of
 * `prevText`, so the merged transcript reads once, not twice.
 */
export function mergeOverlapText(prevText, nextText, options = {}) {
  const maxWords = options.maxWords ?? 8;
  const prevWords = (prevText || "").trim().split(/\s+/).filter(Boolean);
  const nextWords = (nextText || "").trim().split(/\s+/).filter(Boolean);
  if (prevWords.length === 0 || nextWords.length === 0) return nextText || "";

  const limit = Math.min(maxWords, prevWords.length, nextWords.length);
  let bestK = 0;
  for (let k = limit; k >= 1; k--) {
    const prevTail = prevWords.slice(-k).map(normalizeWord).join(" ");
    const nextHead = nextWords.slice(0, k).map(normalizeWord).join(" ");
    if (prevTail && prevTail === nextHead) {
      bestK = k;
      break;
    }
  }
  if (bestK === 0) return nextText || "";
  return nextWords.slice(bestK).join(" ");
}

export function buildMarkdownHeader({ startedAt, language, model }) {
  const lines = [
    "# Live notes",
    "",
    `Started: ${startedAt}`,
    `Language: ${language || "auto"}`,
    `Model: ${model || "unknown"}`,
    "",
    "## Transcript",
    "",
  ];
  return lines.join("\n");
}

export function buildMarkdownEntry({ startMs, text }) {
  if (!text) return "";
  return `[${formatClockTime(startMs)}] ${text}\n\n`;
}

export function buildJsonlLine(record) {
  return JSON.stringify(record) + "\n";
}

function slugifyBaseName(name) {
  return String(name || "notes")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Default session file base name: 2026-09-24-143005-notes (title optional).
 * Second resolution plus a per-process disambiguator so two sessions started
 * in the same minute (or the same second across restarts) never share one
 * append-only pair and mix their streams.
 */
export function buildSessionBaseName(startedAt, title) {
  const d = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const suffix = title ? slugifyBaseName(title) : "notes";
  return `${stamp}-${suffix}`;
}

/**
 * Resolve a collision-free basename: when a previous session already owns
 * `base` (same second, restarted process, or clock skew), append -2, -3, …
 * Keeps the documented one-pair-per-session invariant.
 */
export function resolveUniqueBaseName(dir, baseName) {
  let candidate = baseName;
  let n = 1;
  while (
    fs.existsSync(path.join(dir, `${candidate}.md`)) ||
    fs.existsSync(path.join(dir, `${candidate}.raw.jsonl`))
  ) {
    n += 1;
    candidate = `${baseName}-${n}`;
  }
  return candidate;
}

/**
 * Create a live-notes writer bound to one recording session. `dir` is
 * created if missing. Returns paths after `close()`.
 */
export function createNotesWriter({ dir, baseName, startedAt, language, model }) {
  fs.mkdirSync(dir, { recursive: true });
  // Atomically claim a collision-free basename: exclusive-create both files
  // synchronously, so two sessions racing in the same tick cannot both pass
  // an existsSync check and interleave appends into one pair.
  let uniqueBase = baseName;
  let mdPath;
  let jsonlPath;
  for (let n = 1; ; n += 1) {
    uniqueBase = n === 1 ? baseName : `${baseName}-${n}`;
    mdPath = path.join(dir, `${uniqueBase}.md`);
    jsonlPath = path.join(dir, `${uniqueBase}.raw.jsonl`);
    try {
      fs.writeFileSync(mdPath, "", { flag: "wx" });
      fs.writeFileSync(jsonlPath, "", { flag: "wx" });
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      // We may have created mdPath just now while the jsonl name is taken
      // (stale file from an older version): remove our half-claim so no
      // orphan accumulates, then try the next suffix.
      try {
        if (err?.path === jsonlPath) fs.unlinkSync(mdPath);
      } catch {}
    }
  }

  const mdStream = fs.createWriteStream(mdPath, { flags: "a" });
  const jsonlStream = fs.createWriteStream(jsonlPath, { flags: "a" });
  mdStream.write(buildMarkdownHeader({ startedAt, language, model }));

  let nextSeq = 0;
  const pending = new Map();
  let lastWrittenText = "";
  let lastWrittenEndMs = 0;
  let entriesWritten = 0;

  function writeOne(record) {
    jsonlStream.write(buildJsonlLine(record));
    lastWrittenEndMs = record.endMs ?? lastWrittenEndMs;
    // Skipped chunks (silence / hallucination / repeats) still advance the
    // sequence in the JSONL sidecar, but must never reach the readable
    // transcript - their `raw` is noise by definition.
    if (record.skipped) return;
    const text = record.normalized || record.raw || "";
    if (!text) return;
    const merged = record.forced ? mergeOverlapText(lastWrittenText, text) : text;
    if (!merged.trim()) return;
    mdStream.write(buildMarkdownEntry({ startMs: record.startMs, text: merged }));
    lastWrittenText = merged;
    entriesWritten += 1;
  }

  /**
   * Append a processed chunk. Written immediately if it is the next chunk in
   * sequence; otherwise held until earlier chunks arrive.
   */
  function appendChunk(record) {
    pending.set(record.seq, record);
    while (pending.has(nextSeq)) {
      writeOne(pending.get(nextSeq));
      pending.delete(nextSeq);
      nextSeq += 1;
    }
  }

  function pendingCount() {
    return pending.size;
  }

  function entryCount() {
    return entriesWritten;
  }

  function lastText() {
    return lastWrittenText;
  }

  function lastWrittenEndMsGetter() {
    return lastWrittenEndMs;
  }

  async function close() {
    // Flush anything still buffered (out-of-order arrivals that never got
    // their missing predecessor - e.g. a chunk whose transcription errored
    // silently) in sequence-number order, so nothing is silently dropped.
    for (const seq of [...pending.keys()].sort((a, b) => a - b)) {
      writeOne(pending.get(seq));
      pending.delete(seq);
    }
    await new Promise((resolve) => mdStream.end(resolve));
    await new Promise((resolve) => jsonlStream.end(resolve));
    return { mdPath, jsonlPath };
  }

  return {
    appendChunk,
    pendingCount,
    entryCount,
    lastText,
    lastWrittenEndMs: lastWrittenEndMsGetter,
    close,
    mdPath,
    jsonlPath,
  };
}
