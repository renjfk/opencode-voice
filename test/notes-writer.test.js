import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildJsonlLine,
  buildMarkdownEntry,
  buildMarkdownHeader,
  buildSessionBaseName,
  createNotesWriter,
  formatClockTime,
  mergeOverlapText,
  resolveUniqueBaseName,
} from "../lib/notes-writer.js";

test("formats clock time as HH:MM:SS, including past an hour", () => {
  assert.equal(formatClockTime(0), "00:00:00");
  assert.equal(formatClockTime(8000), "00:00:08");
  assert.equal(formatClockTime(65000), "00:01:05");
  assert.equal(formatClockTime(3661000), "01:01:01");
});

test("mergeOverlapText drops the duplicated boundary words only", () => {
  assert.equal(
    mergeOverlapText("we will discuss the authentication migration", "migration plan next"),
    "plan next",
  );
  assert.equal(
    mergeOverlapText("hello there", "completely different text"),
    "completely different text",
  );
  assert.equal(mergeOverlapText("", "next text"), "next text");
  assert.equal(mergeOverlapText("prev text", ""), "");
  // Case/punctuation differences at the boundary still count as the same word.
  assert.equal(mergeOverlapText("...the Migration.", "migration continues now"), "continues now");
});

test("builds markdown header and entry", () => {
  const header = buildMarkdownHeader({
    startedAt: "2026-09-24T14:30:00.000Z",
    language: "en",
    model: "ggml.bin",
  });
  assert.match(header, /# Live notes/);
  assert.match(header, /Started: 2026-09-24T14:30:00.000Z/);
  assert.match(header, /Language: en/);
  assert.match(header, /Model: ggml.bin/);
  assert.match(header, /## Transcript/);

  assert.equal(buildMarkdownEntry({ startMs: 8000, text: "hello" }), "[00:00:08] hello\n\n");
  assert.equal(buildMarkdownEntry({ startMs: 0, text: "" }), "");
});

test("builds one JSON line per record", () => {
  const line = buildJsonlLine({ seq: 0, raw: "hi" });
  assert.equal(line.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(line), { seq: 0, raw: "hi" });
});

test("builds a slugified session base name from a start time and optional title", () => {
  const d = new Date(2026, 8, 24, 14, 30, 5); // local time, month is 0-indexed
  assert.equal(buildSessionBaseName(d), "2026-09-24-143005-notes");
  assert.equal(buildSessionBaseName(d, "Sprint Planning!"), "2026-09-24-143005-sprint-planning");
});

test("session basenames carry second resolution so same-minute sessions differ", () => {
  const a = buildSessionBaseName(new Date(2026, 8, 24, 14, 30, 5));
  const b = buildSessionBaseName(new Date(2026, 8, 24, 14, 30, 47));
  assert.notEqual(a, b);
});

test("resolveUniqueBaseName disambiguates a taken basename", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-notes-test-"));
  try {
    assert.equal(resolveUniqueBaseName(dir, "2026-09-24-143005-notes"), "2026-09-24-143005-notes");
    fs.writeFileSync(path.join(dir, "2026-09-24-143005-notes.md"), "# taken\n");
    assert.equal(
      resolveUniqueBaseName(dir, "2026-09-24-143005-notes"),
      "2026-09-24-143005-notes-2",
    );
    fs.writeFileSync(path.join(dir, "2026-09-24-143005-notes-2.raw.jsonl"), "");
    assert.equal(
      resolveUniqueBaseName(dir, "2026-09-24-143005-notes"),
      "2026-09-24-143005-notes-3",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("two writers with the same basename never share one file pair", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-notes-test-"));
  try {
    const common = {
      dir,
      baseName: "2026-09-24-143005-notes",
      startedAt: "2026-09-24T14:30:05.000Z",
      language: "en",
      model: "m",
    };
    const first = createNotesWriter(common);
    const second = createNotesWriter(common);
    assert.notEqual(first.mdPath, second.mdPath);
    assert.notEqual(first.jsonlPath, second.jsonlPath);
    first.appendChunk({ seq: 0, startMs: 0, endMs: 1000, forced: false, normalized: "one" });
    second.appendChunk({ seq: 0, startMs: 0, endMs: 1000, forced: false, normalized: "two" });
    const a = await first.close();
    const b = await second.close();
    assert.match(fs.readFileSync(a.mdPath, "utf-8"), /\bone\b/);
    assert.doesNotMatch(fs.readFileSync(a.mdPath, "utf-8"), /\btwo\b/);
    assert.match(fs.readFileSync(b.mdPath, "utf-8"), /\btwo\b/);
    assert.doesNotMatch(fs.readFileSync(b.mdPath, "utf-8"), /\bone\b/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("notes writer appends strictly in sequence order even when chunks arrive out of order", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-notes-test-"));
  try {
    const writer = createNotesWriter({
      dir,
      baseName: "session",
      startedAt: "2026-09-24T14:30:00.000Z",
      language: "auto",
      model: "test-model",
    });

    // Chunk 1 arrives before chunk 0 (slow normalize on 0, fast on 1).
    writer.appendChunk({
      seq: 1,
      startMs: 5000,
      endMs: 8000,
      forced: false,
      normalized: "second part.",
    });
    assert.equal(writer.entryCount(), 0); // withheld: chunk 0 missing
    assert.equal(writer.pendingCount(), 1);

    writer.appendChunk({
      seq: 0,
      startMs: 0,
      endMs: 5000,
      forced: false,
      normalized: "first part.",
    });
    assert.equal(writer.entryCount(), 2);
    assert.equal(writer.pendingCount(), 0);
    assert.equal(writer.lastText(), "second part.");
    assert.equal(writer.lastWrittenEndMs(), 8000);

    const { mdPath, jsonlPath } = await writer.close();
    const md = fs.readFileSync(mdPath, "utf-8");
    assert.match(md, /\[00:00:00\] first part\./);
    assert.match(md, /\[00:00:05\] second part\./);
    assert.ok(md.indexOf("first part") < md.indexOf("second part"));

    // JSONL is written by the same in-order flush as the markdown, so it is
    // also seq-ordered, not arrival-ordered.
    const jsonl = fs
      .readFileSync(jsonlPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      jsonl.map((r) => r.seq),
      [0, 1],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("notes writer dedupes overlap text only on forced chunks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-notes-test-"));
  try {
    const writer = createNotesWriter({
      dir,
      baseName: "session",
      startedAt: "2026-09-24T14:30:00.000Z",
      language: "en",
      model: "m",
    });

    writer.appendChunk({
      seq: 0,
      startMs: 0,
      endMs: 20000,
      forced: true,
      normalized: "we will discuss the authentication migration",
    });
    writer.appendChunk({
      seq: 1,
      startMs: 19600,
      endMs: 25000,
      forced: true,
      normalized: "migration plan for next quarter",
    });

    const { mdPath } = await writer.close();
    const md = fs.readFileSync(mdPath, "utf-8");
    assert.match(md, /we will discuss the authentication migration/);
    assert.match(md, /plan for next quarter/);
    // The duplicated overlap word ("migration") must not appear twice.
    assert.equal((md.match(/migration/gi) || []).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("notes writer skips empty/silent chunks but still advances ordering", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-notes-test-"));
  try {
    const writer = createNotesWriter({
      dir,
      baseName: "session",
      startedAt: "2026-09-24T14:30:00.000Z",
      language: "en",
      model: "m",
    });

    writer.appendChunk({
      seq: 0,
      startMs: 0,
      endMs: 20000,
      forced: true,
      raw: "",
      normalized: "",
      skipped: "silence",
    });
    writer.appendChunk({
      seq: 1,
      startMs: 20000,
      endMs: 25000,
      forced: false,
      normalized: "hello there",
    });

    assert.equal(writer.entryCount(), 1);
    const { mdPath } = await writer.close();
    const md = fs.readFileSync(mdPath, "utf-8");
    assert.match(md, /hello there/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("notes writer keeps hallucinated raw text out of the transcript, in the sidecar", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-notes-test-"));
  try {
    const writer = createNotesWriter({
      dir,
      baseName: "session",
      startedAt: "2026-09-24T14:30:00.000Z",
      language: "vi",
      model: "m",
    });

    // A skipped hallucination carries non-empty raw - it must still advance
    // ordering and land in JSONL, but never pollute the readable transcript.
    writer.appendChunk({
      seq: 0,
      startMs: 0,
      endMs: 5000,
      forced: false,
      raw: "Hãy subscribe cho kênh Ghiền Mì Gõ Để không bỏ lỡ những video hấp dẫn",
      normalized: "",
      skipped: "hallucination",
    });
    writer.appendChunk({
      seq: 1,
      startMs: 5000,
      endMs: 9000,
      forced: false,
      raw: "IoT là gì",
      normalized: "IoT là gì?",
    });

    assert.equal(writer.entryCount(), 1);
    const { mdPath, jsonlPath } = await writer.close();
    const md = fs.readFileSync(mdPath, "utf-8");
    assert.doesNotMatch(md, /Ghiền Mì Gõ/);
    assert.match(md, /IoT là gì\?/);
    const jsonl = fs.readFileSync(jsonlPath, "utf-8");
    assert.match(jsonl, /Ghiền Mì Gõ/);
    assert.match(jsonl, /"skipped":"hallucination"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
