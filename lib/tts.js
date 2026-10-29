// Text-to-speech: LLM normalization, Piper synthesis, sox playback.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { getSessionTitle } from "./session.js";
import { clearProcessingToast, showProcessingToast, updateProcessingToast } from "./stt.js";
import { createChatterboxClient, resolveTtsEngine } from "./chatterbox-server.js";
import { createVieneuClient } from "./vieneu-server.js";
import { createTtsPlayer, measurePcmDurationSec, measureWavDurationSec } from "./tts-player.js";
import { nextRate as nextTtsRate } from "./tts-status.js";
import { sttLog } from "./stt-log.js";

const VOICES_DIR = path.join(os.homedir(), ".local", "share", "piper-voices");

const TTS_VOICES = {
  ryan: { label: "Ryan (high)", file: "en_US-ryan-high.onnx" },
  bryce: { label: "Bryce (medium)", file: "en_US-bryce-medium.onnx" },
  vi: { label: "Vais (vi_VN medium)", file: "vi_VN-vais1000-medium.onnx" },
  vi_vivo: { label: "Vivos (vi_VN x_low)", file: "vi_VN-vivos-x_low.onnx" },
};
const DEFAULT_TTS_VOICE = "ryan";
// Vietnamese diacritics — used for auto vi/en detection
const VI_REGEX = /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđĐ]/;

const PIPER_RATE = 22050;
const PIPER_BITS = 16;
const PIPER_CHANNELS = 1;

// ---- Structured content: tables and diagrams are not speakable literally ----
// A literal read ("pipe name pipe status pipe...") is noise, so both the
// local cleanup and the LLM narrator summarize instead: what the table is
// about, then the few rows that matter. Pure functions, tested in tts.test.js.

// Structural-only guard: diagrams, tables, fences. Safe on clean text.
const MERMAID_FENCE_RE = /```mermaid[^\S\n]*\r?\n?([\s\S]*?)```/gi;
const MERMAID_DECL_RE =
  /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|mindmap|journey|gitGraph)\b/i;
const MERMAID_LINE_RE = /-->|---|==>|-\.->|==>|\[|\]|\(|\)/;
const MERMAID_DECL_MAX_LEN = 32;

const TABLE_ROW_CAP = 3;
const TABLE_TEXT_CAP = 320;
const MERMAID_LABEL_CAP = 6;

function splitTableCells(row) {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line) {
  const cells = splitTableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

export function summarizeMarkdownTable(block) {
  const lines = (block || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));
  const headerIdx = lines.findIndex((line) => !isTableSeparator(line));
  if (headerIdx === -1) return "Table.";
  const headers = splitTableCells(lines[headerIdx]).filter(Boolean);
  const rows = lines
    .slice(headerIdx + 1)
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

export function summarizeMermaidForSpeech(code) {
  const text = code || "";
  const firstLine =
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) || "";
  const kindMatch = /^(graph|flowchart)\b/i.exec(firstLine);
  const kind = kindMatch ? kindMatch[1].toLowerCase() : "";
  const labels = [...text.matchAll(/\[([^\[\]]+)\]/g)]
    .map((m) => m[1].trim())
    .filter(Boolean)
    .slice(0, MERMAID_LABEL_CAP);
  const what = kind ? `Diagram, ${kind}` : "Diagram";
  if (labels.length >= 2) return `${what}: ${labels.join(", ")}.`;
  if (labels.length === 1) return `${what}: ${labels[0]}.`;
  return `${what}.`;
}

// ---- Local (no-LLM) speech cleanup ----

// Deterministic markdown -> spoken-text transform. Zero network latency, so it
// backs streaming speech and ttsNormalizeMode "local". Less polished than the
// LLM narrator (no summarization), but instant.

function splitIdentifier(token) {
  return token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
}

function summarizeUnfencedMermaid(lines, start) {
  if (lines[start].trim().length > MERMAID_DECL_MAX_LEN) return null;
  const body = [];
  let i = start + 1;
  while (i < lines.length && lines[i].trim() === "") i++;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") break;
    if (!MERMAID_LINE_RE.test(line)) return null;
    body.push(line);
  }
  if (body.length === 0) return null;
  return {
    text: summarizeMermaidForSpeech([lines[start], ...body].join("\n")),
    end: i,
  };
}

export function sanitizeSpokenText(text) {
  if (!text) return "";
  let out = String(text);
  out = out.replace(MERMAID_FENCE_RE, (_, code) => ` ${summarizeMermaidForSpeech(code)} `);
  {
    const lines = out.split("\n");
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
      if (MERMAID_DECL_RE.test(lines[i].trim())) {
        const found = summarizeUnfencedMermaid(lines, i);
        if (found) {
          kept.push(found.text);
          i = found.end - 1;
          continue;
        }
      }
      kept.push(lines[i]);
    }
    out = kept.join("\n");
  }
  out = out.replace(
    /((?:^[ \t]*\|.*\|\s*$\n?){2,})/gm,
    (block) => ` ${summarizeMarkdownTable(block)} `,
  );
  out = out.replace(/```[\s\S]*?```/g, " code snippet ");
  return out;
}

export function localSpeechCleanup(text) {
  if (!text) return "";
  let out = sanitizeSpokenText(text);
  // (Diagrams, tables and generic fences were already handled by sanitizeSpokenText above.)
  // Tables next: runs of pipe lines become a short spoken summary.
  out = out.replace(
    /((?:^[ \t]*\|.*\|\s*$\n?){2,})/gm,
    (block) => ` ${summarizeMarkdownTable(block)} `,
  );
  out = out.replace(/```[\s\S]*?```/g, " code snippet ");
  out = out.replace(/`([^`]+)`/g, (_, code) => ` ${splitIdentifier(code)} `);
  out = out.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  out = out.replace(/<[^>]+>/g, " ");
  out = out.replace(/^#{1,6}\s+/gm, "");
  out = out.replace(/^[>\s]*[-*+]\s+/gm, "");
  out = out.replace(/(\*\*|__)(.*?)\1/g, "$2");
  out = out.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1$2");
  out = out
    .split(/(\s+)/)
    .map((tok) => {
      if (/^\s+$/.test(tok) || !tok) return tok;
      if (/^https?:\/\//i.test(tok)) {
        const domain = tok.replace(/^https?:\/\/([^/]+).*$/i, "$1");
        return domain.replace(/\./g, " dot ");
      }
      const base = tok.includes("/") ? tok.slice(tok.lastIndexOf("/") + 1) : tok;
      if (/^\w[\w.-]*\.[a-z0-9]{1,4}$/i.test(base)) {
        const dot = base.lastIndexOf(".");
        return `${splitIdentifier(base.slice(0, dot))} dot ${base.slice(dot + 1)}`;
      }
      return splitIdentifier(tok);
    })
    .join("");
  return out.replace(/\s+/g, " ").trim();
}

// ---- Speech must never depend on the LLM ----
// The narrator is a cosmetic polish layer on top of local Piper, which is
// always available. So when the narrator fails for any reason (quota
// exhausted, bad auth, unreachable endpoint, missing model, non-2xx) we speak
// the deterministic local cleanup instead of going silent - this is the one
// place the decision lives, so every caller benefits.
//
// Pure so it is testable without a TUI, a model, or piper.

export function resolveSpeechText(rawText, llmResult) {
  if (llmResult?.text) return { text: sanitizeSpokenText(llmResult.text) };
  return { text: localSpeechCleanup(rawText), error: llmResult?.error, fellBack: true };
}

// The llm-client retries with backoff (normalizeRetries in llm-client.js), so a
// model that is merely out of quota stalls for many seconds before admitting
// failure - waiting that long for a polish layer is worse than unpolished
// speech, so bound the wait. The timer is unref'd (same trick as
// wallTimeout in streaming-stt.js) and cleared on the happy path, so tests and
// short-lived processes never wait out the full bound.
const NORMALIZE_FALLBACK_TIMEOUT_MS = 12000;

async function normalizeWithinBound(promise) {
  let timer = null;
  const bound = new Promise((resolve) => {
    timer = setTimeout(() => {
      timer = null;
      resolve({ text: null, error: "LLM normalization timed out" });
    }, NORMALIZE_FALLBACK_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, bound]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Split streamed text into complete spoken sentences. Returns what is ready
// plus the trailing incomplete fragment to keep buffering. Sentences that
// look like code dumps (overlong, backticks) are skipped by the caller.

export function splitSpokenSentences(text) {
  const flat = (text || "").replace(/\s+/g, " ");
  // Only split where a new sentence plausibly starts (uppercase letter,
  // quote, or bracket). This keeps version numbers ("v1.2.3"), decimals,
  // and abbreviations ("e.g. this") inside one span so a fragment can't
  // be voice-routed on its own.
  const parts = flat.split(/(?<=[.!?…])\s+(?=[\p{Lu}"“'‘(\[])/u);
  if (parts.length === 0) return { sentences: [], rest: "" };
  const lastComplete = /[.!?…]\s*$/.test(flat);
  if (lastComplete) return { sentences: parts.filter(Boolean), rest: "" };
  const rest = parts.pop() || "";
  return { sentences: parts.filter(Boolean), rest };
}

export function isSpeakableSentence(sentence) {
  const s = (sentence || "").trim();
  if (!s || s.length > 400 || s.includes("`")) return false;
  return true;
}

// Per-sentence language routing: Vietnamese and English need different
// engines/voices (Chatterbox cannot speak vi; Piper vi mangles English),
// so an utterance is split into sentences and consecutive same-language
// sentences are grouped. Word order is preserved exactly; grouping only
// decides which voice synthesizes which span. Pure export for tests.
export function groupSentencesByLang(text) {
  const flat = (text || "").replace(/\s+/g, " ").trim();
  if (!flat) return [];
  const { sentences, rest } = splitSpokenSentences(flat);
  const parts = [...sentences];
  if (rest.trim()) parts.push(rest.trim());
  const groups = [];
  for (const part of parts) {
    const lang = detectLang(part);
    const last = groups[groups.length - 1];
    if (last && last.lang === lang) last.text = `${last.text} ${part}`;
    else groups.push({ lang, text: part });
  }
  return groups;
}

// Decide ONE language for the whole call (utterance or, during streaming,
// one completed sentence) and speak all of it with that single voice - no
// mid-utterance voice switching, since splicing separately synthesized clips
// sounds jarring (clicks/gaps between voices).
//
// Root-cause fix: the old rule was "any Vietnamese diacritic anywhere in the
// text -> vi voice". A single stray diacritic word in an English-dominant
// reply (e.g. a name) flipped the ENTIRE text to the Vietnamese voice, which
// then mispronounced every English word - and conversely, if the diacritics
// got normalized away, a Vietnamese reply flipped to the English voice. That
// is the "speaks Vietnamese with English (voice) and English with Vietnamese
// (voice)" bug. Fix: majority vote over words - only route to "vi" when a
// meaningful share of words actually carry Vietnamese diacritics, so one
// stray word can no longer flip the whole utterance.

const VI_LANG_WORD_THRESHOLD = 0.15;

export function detectLang(text) {
  if (!text) return "en";
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "en";
  const viWords = words.filter((w) => VI_REGEX.test(w)).length;
  return viWords / words.length >= VI_LANG_WORD_THRESHOLD ? "vi" : "en";
}

// ---- Conversation-mode hooks (wired by index.js) ----
// While voice conversation owns speaking, the TTS stop key pauses the loop
// instead of just silencing (which would auto-record again).

let conversationTtsHooks = { isActive: null, onStopKey: null };

export function __setConversationTtsHooks(hooks) {
  conversationTtsHooks = { ...conversationTtsHooks, ...hooks };
}

function conversationTtsActive() {
  try {
    return conversationTtsHooks.isActive?.() === true;
  } catch {
    return false;
  }
}

// ---- System prompts ----

const SYSTEM_AUTO = `You are a text-to-speech narrator for a coding assistant CLI. Your job is to convert the assistant's markdown output into natural spoken text that is useful and pleasant to listen to.

You have three modes depending on the content complexity:

1. NARRATE - For simple explanations, short answers, and conversational responses. Convert to natural spoken text, normalizing code references for speech.
   - camelCase/PascalCase identifiers: split into words (parseConfig -> "parse config")
   - File paths: use just the filename (src/utils/helpers.ts -> "helpers dot ts")
   - Short code snippets in backticks: read them naturally
   - Keep the narrative flow intact

2. SUMMARIZE - For responses with significant code blocks, multiple file changes, or complex technical details. Provide a brief spoken summary of what was done and tell the user to check the screen.
   - Mention what was changed and why
   - Do not try to describe code blocks verbatim
   - End with something like "check the details on your screen" or "take a look at the output for the specifics"

3. NOTIFY - For very short confirmations, status updates, or acknowledgments. Keep it to one brief sentence.

Choose the appropriate mode based on the content. Most responses with code blocks should use SUMMARIZE mode. Simple Q&A or short explanations use NARRATE. Build results, "done", confirmations use NOTIFY.

STRUCTURED CONTENT RULES (apply in every mode):
- TABLES: never read a markdown table cell by cell. First understand what the
  table lists, then say one short intro (the topic) plus the 2-3 most
  important rows in plain sentences. Skip long tables after the gist.
- DIAGRAMS: mermaid and other fenced diagrams are never read as syntax.
  Describe the flow in one or two sentences (what leads to what). Say the
  word "diagram" once so the listener knows what you summarized.
- CODE DUMPS: covered by SUMMARIZE above - never spell out code.

CODE-SWITCHING (Vietnamese matrix language with English technical terms):
- Keep technical terms, commands, identifiers, and proper nouns in English.
  Never translate them into Vietnamese.
- When a sentence mixes Vietnamese and English, prefer keeping the English
  term at the end or beginning of its own clause so it can be spoken with
  the right voice. Do not embed English terms mid-Vietnamese-phrase.
- Expand an acronym on first use only when it aids understanding, then use
  the term as-is. Never spell acronyms letter by letter unprompted.
- Do not narrate markdown table pipes or diagram arrows - see above.

Output ONLY the spoken text. Nothing else. No mode labels. No commentary.`;

const SYSTEM_MANUAL = `You are a text-to-speech reader for a coding assistant. The user has explicitly requested this text be read aloud. Read the prose content faithfully and in detail.

Rules:
- Read all prose text naturally and completely
- Code identifiers: split camelCase/PascalCase/snake_case into words (parseConfig -> "parse config", my_variable -> "my variable")
- File paths: read just the filename with extension (src/utils/helpers.ts -> "helpers dot ts")
- Line references: keep as is ("line 42")
- URLs: say "a link" or just the domain name
- Code blocks: skip entirely, just say "code block" or "code snippet"
- Error codes: expand naturally (ECONNREFUSED -> "connection refused")
- Shell commands: read them naturally (npm test -> "npm test")
- List items: read each item
- Tables: read compactly, not cell by cell - headers once, then each row as a
  short phrase (max 5 rows), e.g. "Table with columns Name, Status. build,
  pass. test, fail."
- Diagrams (mermaid): summarize the flow in one or two sentences, never read
  the syntax. Say the word "diagram" once.
- Code-switched terms: keep English technical terms, commands, and identifiers
  in English. Never translate them.
- Remove markdown formatting but preserve all the informational content
- Do NOT summarize. Do NOT say "check the screen". Read everything that is prose.
- Output ONLY the spoken text`;

// ---- Session helpers ----

export async function getTurnAssistantText(client, api) {
  const route = api.route.current;
  if (route.name !== "session") return null;

  const sessionID = route.params.sessionID;
  const stateMessages = api.state.session.messages(sessionID);
  if (!stateMessages || stateMessages.length === 0) return null;

  const assistantIDs = [];
  for (let i = stateMessages.length - 1; i >= 0; i--) {
    if (stateMessages[i].role === "user") break;
    if (stateMessages[i].role === "assistant") {
      assistantIDs.unshift(stateMessages[i].id);
    }
  }
  if (assistantIDs.length === 0) return null;

  const allText = [];
  for (const msgID of assistantIDs) {
    try {
      const fullMsg = await client.session
        .message({ sessionID, messageID: msgID }, { throwOnError: true })
        .then((r) => r.data);

      const textParts = (fullMsg?.parts || []).filter((p) => p.type === "text");
      const text = textParts
        .map((p) => p.text || "")
        .join("\n\n")
        .trim();
      if (text) allText.push(text);
    } catch {
      // Skip messages that fail to fetch
    }
  }

  if (allText.length === 0) return null;

  return {
    lastMessageID: assistantIDs[assistantIDs.length - 1],
    text: allText.join("\n\n"),
  };
}

// ---- Public API for TUI plugin ----

export function registerTTS(api, kv, complete, prompts, opts, logger, deps = {}) {
  // Seed engine from opts if the host delivered it (same pattern as sttMode).
  try {
    if (opts?.ttsEngine && kv.get("tts.engine") == null) {
      kv.set("tts.engine", opts.ttsEngine);
    }
  } catch {}
  logger?.log?.("TTS", `Engine=${kv.get("tts.engine", "piper")} opts.engine=${opts?.ttsEngine ?? "none"}`, "debug");
  if (deps.isConversationActive || deps.onConversationStopKey) {
    __setConversationTtsHooks({
      isActive: deps.isConversationActive,
      onStopKey: deps.onConversationStopKey,
    });
  }
  const client = api.client;
  const systemAuto = prompts?.ttsAuto || SYSTEM_AUTO;
  const systemManual = prompts?.ttsManual || SYSTEM_MANUAL;

  function toast(message, variant = "info") {
    api.ui.toast({ message, variant, duration: 3000 });
  }

  function getVoiceModel(text) {
    const lang = detectLang(text);
    if (lang === "vi") {
      // prefer explicit vi voice from kv, else default vi
      const viKey = kv.get("tts.voice.vi", "vi");
      const viEntry = TTS_VOICES[viKey] || TTS_VOICES.vi;
      const viPath = path.join(VOICES_DIR, viEntry.file);
      if (fs.existsSync(viPath)) return viPath;
      // fallback: any vi file present
      for (const k of ["vi", "vi_vivo"]) {
        const p = path.join(VOICES_DIR, TTS_VOICES[k].file);
        if (fs.existsSync(p)) return p;
      }
    }
    const voice = kv.get("tts.voice", DEFAULT_TTS_VOICE);
    // if voice is a vi key but text is en, still respect en
    const entry = TTS_VOICES[voice];
    // if current kv is vi but text is en, use en default
    if (entry && entry.file.includes("vi_VN") && lang === "en") {
      return path.join(VOICES_DIR, TTS_VOICES[DEFAULT_TTS_VOICE].file);
    }
    return path.join(VOICES_DIR, (entry || TTS_VOICES[DEFAULT_TTS_VOICE]).file);
  }

  function piperOnPath() {
    const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
    return pathDirs.some((dir) => fs.existsSync(path.join(dir, "piper")));
  }

  async function normalizeForSpeech(text, systemPrompt, maxTokens = 4096) {
    logger?.log?.("TTS", `Normalizing speech chars=${text.length}`, "debug");
    return complete({
      system: systemPrompt,
      prompt: `Convert for text-to-speech:\n\n${text}`,
      config: { maxTokens },
    });
  }

  function getVoiceRate(voicePath) {
    try {
      const j = JSON.parse(fs.readFileSync(`${voicePath}.json`, "utf-8"));
      return j?.audio?.sample_rate || PIPER_RATE;
    } catch {
      return PIPER_RATE;
    }
  }

  // ---- Audio pipeline ----
  // Measured media controller (lib/tts-player.js): every utterance is
  // synthesized to a complete buffered asset first, its total measured from
  // real audio frames, then played through ONE owned `play` process. Totals
  // are exact; the cursor is wall-clock derived and explicitly approximate.
  // Pause/resume use SIGSTOP/SIGCONT (no restart), speed uses sox `tempo`,
  // seeks respawn with `trim`. Stale completions are fenced twice: speechGen
  // here for synthesis, the player's generation token for playback.

  let piperProc = null;
  // A Piper utterance is "speaking" from the moment synthesis starts, even
  // when synthesis is injected (tests) and owns no OS process handle.
  let piperSynthPending = false;
  // Invalidated by stopSpeech (and by a preempting speak): a cancel landing
  // between LLM normalization/synthesis and playback must prevent the stale
  // speech from starting afterwards.
  let speechGen = 0;

  function currentRate() {
    const raw = Number(kv.get("tts.rate", 1));
    if (!Number.isFinite(raw)) return 1;
    return Math.min(2, Math.max(0.75, raw));
  }

  // Real process adapters for the player core. `feed` hands the buffered WAV
  // to the owned play process; stderr is tapped so failed launches stay
  // visible in the log exactly like the previous inline pipeline.
  function realPlayerHooks() {
    return {
      spawn(argv) {
        let child = null;
        let closeCb = null;
        const handle = {
          pid: -1,
          stdin: null,
          onClose: (cb) => {
            closeCb = cb;
          },
        };
        const finish = (code) => {
          try {
            closeCb?.(code);
          } catch {}
        };
        try {
          child = spawn("play", argv, { stdio: ["pipe", "ignore", "pipe"] });
        } catch (err) {
          logger?.log?.("TTS", `play error: ${err.message}`, "error");
          sttLog("tts.play", `spawn throw: ${err.message}`);
          queueMicrotask(() => finish(-1));
          return handle;
        }
        handle.pid = child.pid;
        handle.stdin = child.stdin;
        let playStderr = "";
        try {
          child.stderr.on("data", (chunk) => {
            playStderr += chunk.toString();
          });
        } catch {}
        // A failed launch emits 'error' and may never emit 'close': settle
        // on both so playback never hangs. The player's generation token
        // makes a second settle a harmless no-op.
        child.on("error", (err) => {
          logger?.log?.("TTS", `play error: ${err.message}`, "error");
          sttLog("tts.play", `spawn error event: ${err.message}`);
          finish(-1);
        });
        child.on("close", (code) => {
          if (code !== 0 && code !== null) {
            logger?.log?.("TTS", `play exited code=${code} stderr=${playStderr.trim()}`, "error");
          } else {
            logger?.log?.("TTS", "playback finished", "debug");
          }
          sttLog("tts.play", `close code=${code} stderr=${playStderr.trim().slice(-160)}`);
          finish(code);
        });
        return handle;
      },
      signal: (pid, sig) => {
        try {
          process.kill(pid, sig);
        } catch {}
      },
      now: () => Date.now(),
      feed: (handle, { wav }) => {
        try {
          if (!handle.stdin || handle.stdin.destroyed) {
            sttLog("tts.play", "feed skipped: stdin missing/destroyed");
            return;
          }
          sttLog("tts.play", `feed bytes=${wav?.length ?? 0}`);
          handle.stdin.end(wav);
        } catch (err) {
          sttLog("tts.play", `feed throw: ${err?.message || err}`);
        }
      },
    };
  }

  const player = createTtsPlayer(deps.playerHooks ?? realPlayerHooks());

  // Utterance-level progress across language groups: the player holds one
  // group asset at a time, so completed-group seconds accumulate here. The
  // media snapshot drives api.ttsStatus (v2 slot) and stays null when idle
  // so v1 toast progress is untouched. Manual transport ops (replay/forward/
  // rewind) collapse back to the current single asset.
  let utterDoneSec = 0;
  let utterTotalSec = 0;
  let utterActive = false;
  // True from speak() until the first measured total exists. The slot shows
  // a "Loading voice" line during sidecar startup and long synthesis so a
  // slow engine never looks dead.
  let utterLoading = false;

  function utterReset() {
    utterDoneSec = 0;
    utterTotalSec = 0;
    utterActive = false;
    utterLoading = false;
  }

  function utteranceState() {
    const s = player.getState();
    if (!utterActive || !(utterTotalSec > 0)) return s;
    const live = s.status === "playing" || s.status === "paused" ? s.cursorSec : 0;
    return {
      ...s,
      status: s.status === "idle" ? "playing" : s.status,
      cursorSec: Math.min(utterDoneSec + live, utterTotalSec),
      totalSec: utterTotalSec,
    };
  }

  function collapseUtteranceToPlayer() {
    const s = player.getState();
    utterDoneSec = 0;
    utterTotalSec = s.totalSec;
    utterActive = s.totalSec > 0;
  }

  const ttsStatus = api.ttsStatus || null;
  if (api.setTtsStatusReader) {
    try {
      api.setTtsStatusReader(() => {
        if (utterLoading)
          return { status: "loading", cursorSec: 0, totalSec: 0, rate: currentRate() };
        if (!utterActive || !(utterTotalSec > 0)) return null;
        const s = utteranceState();
        return { status: s.status, cursorSec: s.cursorSec, totalSec: s.totalSec, rate: s.rate };
      });
    } catch {}
  }
  if (api.setTtsStatusActions) {
    try {
      api.setTtsStatusActions({
        toggle: () => {
          const s = player.getState();
          if (s.status === "playing") controller.pause();
          else if (s.status === "paused") controller.resume();
        },
        rewind: () => controller.rewind(SEEK_STEP_SEC),
        forward: () => controller.forward(SEEK_STEP_SEC),
        rate: () => controller.setRate(nextTtsRate(currentRate())),
      });
    } catch {}
  }
  function statusBegin() {
    try {
      sttLog("tts.status", "begin");
      ttsStatus?.begin?.();
    } catch {}
  }
  function statusUpdate() {
    try {
      ttsStatus?.update?.();
    } catch {}
  }
  function statusClear() {
    try {
      sttLog("tts.status", "clear");
      ttsStatus?.clear?.();
    } catch {}
  }

  function killProcs() {
    if (piperProc) {
      try {
        piperProc.kill("SIGKILL");
      } catch {}
      piperProc = null;
    }
    player.stop();
  }

  // Buffered Piper synthesis: run piper to completion, collect raw PCM, and
  // hand the bytes back. Playback starts only after measurement, so the
  // total is exact before the first sample sounds. Returns null on failure.
  // Test seam: deps.synthPiperToPcm replaces the real piper spawn.
  const synthPiperToPcm =
    deps.synthPiperToPcm ??
    ((voiceModel, line) =>
      new Promise((resolve) => {
        let chunks = [];
        let piperStderr = "";
        let child = null;
        try {
          child = spawn("piper", ["-m", voiceModel, "--output_raw"], {
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (err) {
          logger?.log?.("TTS", `piper error: ${err.message}`, "error");
          resolve(null);
          return;
        }
        piperProc = child;
        child.stdout.on("data", (chunk) => chunks.push(chunk));
        child.stderr.on("data", (chunk) => {
          piperStderr += chunk.toString();
        });
        child.on("close", (code) => {
          if (child === piperProc) piperProc = null;
          if (code !== 0 && code !== null) {
            logger?.log?.("TTS", `piper exited code=${code} stderr=${piperStderr.trim()}`, "error");
            resolve(null);
          } else {
            resolve(Buffer.concat(chunks));
          }
        });
        child.on("error", (err) => {
          logger?.log?.("TTS", `piper error: ${err.message}`, "error");
          if (child === piperProc) piperProc = null;
          resolve(null);
        });
        try {
          child.stdin.write(line + "\n");
          child.stdin.end();
        } catch {
          resolve(null);
        }
      }));

  function resolveVoiceOrWarn(line) {
    const voiceModel = getVoiceModel(line);
    if (!piperOnPath()) {
      logger?.log?.("TTS", `Piper binary not found on PATH`, "warn");
      toast(`Piper binary not found on PATH`, "warning");
      return null;
    }
    if (!fs.existsSync(voiceModel)) {
      logger?.log?.("TTS", `Voice model not found: ${voiceModel}`, "warn");
      toast(`Voice model not found: ${voiceModel}`, "warning");
      return null;
    }
    return voiceModel;
  }

  // ---- Optional Chatterbox engine (lib/chatterbox-server.js) ----
  // Piper stays the default and stays the fallback: this is an opt-in quality
  // upgrade, never a new dependency. Piper has a Vietnamese voice and is
  // already installed; Chatterbox does not speak Vietnamese at all (its
  // multilingual model covers 23 languages, vi is not one), so a vi utterance
  // is routed to Piper regardless of variant - see resolveTtsEngine.
  const createChatterbox = deps.createChatterboxClient ?? createChatterboxClient;
  let chatterboxClient = null;
  // Shared in-flight start so two utterances never load the model twice.
  let chatterboxStarting = null;
  // A synthesis that is waiting on the sidecar is still "speaking" as far as
  // stop/isSpeaking are concerned, so a cancel lands exactly as it would on
  // Piper's stdout stream.
  let synthPending = false;
  // One toast per availability state change, not one per utterance.
  let chatterboxToastShown = false;

  function chatterboxWarn(message) {
    logger?.log?.("TTS", message, "warn");
  }

  function noteChatterboxFailure(message) {
    logger?.log?.("TTS", message, "warn");
    if (chatterboxToastShown) return;
    chatterboxToastShown = true;
    toast(`${message} - using Piper`);
  }

  // Recovering (or simply working) re-arms the toast, so a later outage is
  // reported once again instead of staying silent for the rest of the session.
  function noteChatterboxOk() {
    chatterboxToastShown = false;
  }

  function getChatterboxClient() {
    if (!chatterboxClient) {
      chatterboxClient = createChatterbox({
        variant: opts?.ttsChatterboxVariant,
        python: opts?.ttsChatterboxPython,
        voiceRef: opts?.ttsChatterboxVoiceRef,
        logger,
      });
    }
    return chatterboxClient;
  }

  // Start the sidecar lazily, on the first utterance that actually needs it.
  // Never at plugin load: the first run downloads model weights, so eagerly
  // loading would mean every opencode session pays for a TTS nobody asked for.
  async function ensureChatterboxReady() {
    if (chatterboxClient?.isRunning()) return true;
    if (!chatterboxStarting) {
      chatterboxStarting = getChatterboxClient()
        .start()
        .then((ok) => {
          if (ok) {
            noteChatterboxOk();
            return true;
          }
          const err = chatterboxClient.getLastError?.();
          noteChatterboxFailure(
            `Chatterbox unavailable (${err?.code || "START_FAILED"}: ${err?.message || "unknown"})`,
          );
          return false;
        })
        .catch((err) => {
          noteChatterboxFailure(`Chatterbox unavailable (${err.message})`);
          return false;
        })
        .finally(() => {
          chatterboxStarting = null;
        });
    }
    return chatterboxStarting;
  }

  // ---- Optional VieNeu-TTS engine (lib/vieneu-server.js) ----
  // Bilingual Vietnamese-English with code-switching. Unlike Chatterbox
  // (which cannot speak vi) and Piper (which needs separate voices), VieNeu
  // handles mixed-language text in a single pass. Runs as a Python sidecar
  // serving an OpenAI-compatible API at /v1/audio/speech.
  const createVieneu = deps.createVieneuClient ?? createVieneuClient;
  let vieneuClient = null;
  let vieneuStarting = null;
  let vieneuToastShown = false;

  function vieneuWarn(message) {
    logger?.log?.("TTS", message, "warn");
  }

  function noteVieneuFailure(message) {
    logger?.log?.("TTS", message, "warn");
    if (vieneuToastShown) return;
    vieneuToastShown = true;
    toast(`${message} - using Piper`);
  }

  function noteVieneuOk() {
    vieneuToastShown = false;
  }

  function getVieneuClient() {
    if (!vieneuClient) {
      vieneuClient = createVieneu({
        python: opts?.ttsVieneuPython,
        voice: opts?.ttsVieneuVoice,
        logger,
      });
    }
    return vieneuClient;
  }

  async function ensureVieneuReady() {
    if (vieneuClient?.isRunning()) return true;
    if (!vieneuStarting) {
      vieneuStarting = getVieneuClient()
        .start()
        .then((ok) => {
          if (ok) {
            noteVieneuOk();
            return true;
          }
          const err = vieneuClient.getLastError?.();
          noteVieneuFailure(
            `VieNeu-TTS unavailable (${err?.code || "START_FAILED"}: ${err?.message || "unknown"})`,
          );
          return false;
        })
        .catch((err) => {
          noteVieneuFailure(`VieNeu-TTS unavailable (${err.message})`);
          return false;
        })
        .finally(() => {
          vieneuStarting = null;
        });
    }
    return vieneuStarting;
  }

  function speak(text) {
    if (!text) return Promise.resolve();
    const line = text.replace(/\n/g, " ").trim();
    if (!line) return Promise.resolve();

    // Preempt: a new utterance invalidates any in-flight synthesis so stale
    // audio can never reach the speaker after this call.
    const takingOver =
      player.getState().status !== "idle" ||
      piperProc !== null ||
      piperSynthPending ||
      synthPending;
    speechGen += 1;
    const myGen = speechGen;
    killProcs();
    utterReset();
    if (takingOver) statusClear();

    // VieNeu-TTS handles bilingual code-switching in one pass, so the
    // whole utterance goes as a single group (no per-sentence routing).
    const engine = kv.get("tts.engine", opts?.ttsEngine);
    const groups = engine === "vieneu" ? [{ lang: "vi", text: line }] : groupSentencesByLang(line);
    if (groups.length === 0) return Promise.resolve();
    sttLog(
      "tts.speak",
      `chars=${line.length} groups=${groups.length} langs=${groups.map((g) => g.lang).join(",")}`,
    );
    // Mount the status line before the slow part (sidecar startup, long
    // synthesis) so the utterance never looks dead while working.
    utterLoading = true;
    statusBegin();
    return speakGroups(groups, myGen);
  }

  // Synthesize every group BEFORE any audio sounds: totals are exact up
  // front, a stop during synthesis drops the whole utterance, and playback
  // order always matches text order. One voice per group (vi groups get the
  // vi voice, en groups the configured engine) - no mid-sentence switching.
  async function speakGroups(groups, myGen) {
    synthPending = true;
    const voiceCache = new Map();
    const resolveGroupVoice = (group) => {
      if (voiceCache.has(group.lang)) return voiceCache.get(group.lang);
      const voice = (deps.resolveVoice ?? resolveVoiceOrWarn)(group.text);
      voiceCache.set(group.lang, voice || null);
      return voiceCache.get(group.lang);
    };
    let assets = null;
    try {
      assets = [];
      for (const group of groups) {
        if (myGen !== speechGen) return;
        const asset = await synthGroupAsset(group, resolveGroupVoice, myGen);
        if (myGen !== speechGen) return;
        if (asset) assets.push(asset);
      }
    } finally {
      synthPending = false;
    }
    if (myGen !== speechGen) {
      sttLog("tts.synth", "dropped: preempted before playback");
      return;
    }
    if (!assets || assets.length === 0) {
      sttLog("tts.synth", "dropped: no speakable assets");
      return;
    }
    utterLoading = false;
    utterTotalSec = assets.reduce((sum, a) => sum + a.totalSec, 0);
    utterDoneSec = 0;
    utterActive = true;
    sttLog("tts.play", `groups=${assets.length} totalSec=${utterTotalSec.toFixed(1)}`);
    try {
      for (const asset of assets) {
        if (myGen !== speechGen) {
          sttLog("tts.play", "dropped: preempted mid-chain");
          return;
        }
        if (!player.load(asset.loadArg)) {
          logger?.log?.("TTS", "Skipping unloadable group asset", "debug");
          sttLog("tts.play", "skipped: unloadable group asset");
          continue;
        }
        statusUpdate();
        await player.play();
        if (myGen !== speechGen) return;
        utterDoneSec = Math.min(utterDoneSec + asset.totalSec, utterTotalSec);
        sttLog("tts.play", `group done cursor=${utterDoneSec.toFixed(1)}`);
        statusUpdate();
      }
    } finally {
      utterReset();
      statusClear();
    }
  }

  // Buffer one language group to a measured asset. Chatterbox failure falls
  // back to Piper for THIS group only; other groups are unaffected. Returns
  // null when stopped, when no voice exists, or when nothing is speakable -
  // callers skip null groups instead of going silent.
  async function synthGroupAsset(group, resolveGroupVoice, myGen) {
    const effectiveOpts = { ...opts, ttsEngine: kv.get("tts.engine", opts?.ttsEngine) };
    const route = resolveTtsEngine(effectiveOpts, group.lang, chatterboxWarn);
    sttLog("tts.synth", `lang=${group.lang} engine=${route.engine} chars=${group.text.length}`);
    if (route.engine === "chatterbox") {
      const ready = await ensureChatterboxReady();
      if (myGen !== speechGen) return null;
      if (ready) {
        let result;
        try {
          result = await getChatterboxClient().synthesize(group.text, group.lang);
        } catch (err) {
          result = { ok: false, code: "REQUEST_FAILED", message: err.message };
        }
        if (myGen !== speechGen) return null;
        if (result?.ok) {
          const totalSec = measureWavDurationSec(result.wav);
          sttLog("tts.synth", `chatterbox ok=${!!result?.ok} wavBytes=${result?.wav?.length ?? 0}`);
          if (totalSec !== null && totalSec > 0) {
            noteChatterboxOk();
            logger?.log?.(
              "TTS",
              `Speak via Chatterbox chars=${group.text.length} lang=${group.lang} wavBytes=${result.wav.length}`,
              "debug",
            );
            return {
              totalSec,
              loadArg: { wav: result.wav, rate: currentRate() },
            };
          }
          noteChatterboxFailure(`Chatterbox synthesis failed (BAD_WAV: unreadable audio)`);
        } else {
          noteChatterboxFailure(
            `Chatterbox synthesis failed (${result?.code}: ${result?.message})`,
          );
        }
        // Fall through to Piper for this group.
      }
    }
    if (route.engine === "vieneu") {
      const ready = await ensureVieneuReady();
      if (myGen !== speechGen) return null;
      if (ready) {
        let result;
        try {
          result = await getVieneuClient().synthesize(group.text);
        } catch (err) {
          result = { ok: false, code: "REQUEST_FAILED", message: err.message };
        }
        if (myGen !== speechGen) return null;
        if (result?.ok) {
          const totalSec = measureWavDurationSec(result.wav);
          sttLog("tts.synth", `vieneu ok=${!!result?.ok} wavBytes=${result?.wav?.length ?? 0}`);
          if (totalSec !== null && totalSec > 0) {
            noteVieneuOk();
            return {
              totalSec,
              loadArg: { wav: result.wav, rate: currentRate() },
            };
          }
          noteVieneuFailure(`VieNeu-TTS synthesis failed (BAD_WAV: unreadable audio)`);
        } else {
          noteVieneuFailure(`VieNeu-TTS synthesis failed (${result?.code}: ${result?.message})`);
        }
        // Fall through to Piper for this group.
      }
    }
    // Piper path (default, vi, and Chatterbox fallback): buffer the whole
    // group, measure the exact total from real PCM frames, then play.
    // Test seam: resolveVoice replaces the PATH/model-filesystem probe so
    // buffering is exercisable without installed voices.
    const voiceModel = resolveGroupVoice(group);
    sttLog("tts.synth", `piper voice=${voiceModel ? "resolved" : "MISSING"}`);
    if (!voiceModel) return null;
    if (myGen !== speechGen) return null;
    logger?.log?.("TTS", `Speak requested chars=${group.text.length} voice=${voiceModel}`, "debug");
    piperSynthPending = true;
    let pcm;
    try {
      pcm = await synthPiperToPcm(voiceModel, group.text);
    } finally {
      piperSynthPending = false;
    }
    // Stopped (or preempted) during synthesis: the bytes are stale, drop them.
    if (myGen !== speechGen) return null;
    if (!pcm || pcm.length === 0) {
      sttLog("tts.synth", "piper empty audio");
      return null;
    }
    const rate = getVoiceRate(voiceModel);
    const totalSec = measurePcmDurationSec({ bytes: pcm }, rate, PIPER_CHANNELS, PIPER_BITS);
    if (!(totalSec > 0)) return null;
    return {
      totalSec,
      loadArg: {
        pcm,
        sampleRate: rate,
        channels: PIPER_CHANNELS,
        bits: PIPER_BITS,
        rate: currentRate(),
      },
    };
  }

  // ---- Session-prefixed announcements ----

  async function speakWithSessionPrefix(sessionID, message, suffix) {
    const sessionTitle = await getSessionTitle(client, sessionID);
    const parts = [];
    if (sessionTitle) parts.push(`Session: ${sessionTitle}.`);
    parts.push(message);
    if (suffix) parts.push(suffix);
    await speak(parts.join(" "));
  }

  function stopSpeech() {
    // Always invalidate: a pending normalize handoff must not speak after
    // the cancel even when nothing is currently playing.
    speechGen += 1; // A waiting Chatterbox synthesis counts as playing, so /tts-stop and the
    // global cancel kill it exactly like Piper playback. Paused playback
    // counts too: stopping it is a real state change.
    const wasPlaying =
      player.getState().status !== "idle" ||
      piperProc !== null ||
      piperSynthPending ||
      synthPending;
    sttLog("tts.stop", `wasPlaying=${wasPlaying}`);
    synthPending = false;
    piperSynthPending = false;
    utterReset();
    statusClear();
    killProcs();
    return wasPlaying;
  }

  // ---- Auto mode ----

  let lastSpokenMessageID = null;
  let wasBusy = false;
  // Set by the voice-conversation loop while it owns speaking, and by live
  // notes while it owns the mic. Auto TTS stays out of the way (and consumes
  // the busy flag) in both cases so replies are not spoken twice, and so a
  // live-notes recording session is never interrupted by an unrelated auto
  // TTS reply.
  let conversationActive = false;
  let liveNotesActive = false;

  // Auto-mode session subscriptions. The unsubscribe handles are kept so
  // plugin unload (resumed session / reload) removes them: without this a
  // second registration doubled auto-TTS speech and stale handlers fired
  // cross-session. api.event.on may return nothing (older host), so guard.
  const eventUnsubs = [];
  function subscribe(name, fn) {
    try {
      const unsub = api.event.on(name, fn);
      if (typeof unsub === "function") eventUnsubs.push(unsub);
    } catch {}
  }

  subscribe("session.status", (event) => {
    if (event.properties?.status?.type === "busy") wasBusy = true;
  });

  subscribe("session.idle", async (event) => {
    if (conversationActive || liveNotesActive) {
      wasBusy = false;
      return;
    }
    if (kv.get("tts.mode", "off") !== "on") return;
    if (!wasBusy) return;
    wasBusy = false;

    const sessionID = event.properties?.sessionID;
    const result = await getTurnAssistantText(client, api);
    if (!result || !result.text) return;

    if (result.lastMessageID === lastSpokenMessageID) return;
    lastSpokenMessageID = result.lastMessageID;

    showProcessingToast("Normalizing response...");
    const genBeforeNormalize = speechGen;
    const llmResult = await normalizeOrLocal(result.text, systemAuto, 4096);
    if (genBeforeNormalize !== speechGen) {
      clearProcessingToast();
      return;
    }
    if (!announceNormalize("Auto", llmResult)) {
      clearProcessingToast();
      return;
    }

    clearProcessingToast();
    await speakWithSessionPrefix(sessionID, llmResult.text, "Ready for your input.");
  });

  subscribe("permission.asked", async (event) => {
    if (conversationActive || liveNotesActive) return;
    if (kv.get("tts.mode", "off") !== "on") return;
    await speakWithSessionPrefix(
      event.properties?.sessionID,
      "Permission requested. Please check your screen.",
    );
  });

  subscribe("question.asked", async (event) => {
    if (conversationActive || liveNotesActive) return;
    if (kv.get("tts.mode", "off") !== "on") return;
    await speakWithSessionPrefix(
      event.properties?.sessionID,
      "A question needs your answer. Please check your screen.",
    );
  });

  // ---- Manual mode ----

  async function speakLastResponse() {
    const result = await getTurnAssistantText(client, api);
    if (!result || !result.text) {
      toast("No assistant response to speak", "warning");
      return;
    }

    showProcessingToast("Normalizing response...");
    const manualGen = speechGen;
    const llmResult = await normalizeOrLocal(result.text, systemManual, 4096);
    if (manualGen !== speechGen) {
      clearProcessingToast();
      return;
    }
    if (!announceNormalize("Manual", llmResult)) {
      clearProcessingToast();
      return;
    }

    updateProcessingToast("Speaking...");
    await speak(llmResult.text);
    clearProcessingToast();
  }

  // Speak the current assistant turn for the voice-conversation loop. Uses the
  // auto (narrate/summarize) prompt and no session prefix - the loop already
  // announces its own state via toasts.

  // ttsNormalizeMode "local" skips the LLM entirely (instant, less polished).
  const ttsLocal = opts?.ttsNormalizeMode === "local";

  async function normalizeOrLocal(text, systemPrompt, maxTokens) {
    if (ttsLocal) return { text: localSpeechCleanup(text) };
    const llmResult = await normalizeWithinBound(normalizeForSpeech(text, systemPrompt, maxTokens));
    return resolveSpeechText(text, llmResult);
  }

  // Shared tail for all three normalize call sites: one informational toast
  // when we are speaking the local fallback, and - when the cleanup left
  // nothing speakable (a pure code dump) - a quiet debug log, because nothing
  // failed there, there was just nothing to read. Returns whether to speak.

  function announceNormalize(label, result) {
    if (!result.text) {
      logger?.log?.("TTS", `${label}: nothing speakable (${result.error})`, "debug");
      return false;
    }
    if (result.fellBack) {
      logger?.log?.(
        "TTS",
        `${label} narration unavailable (${result.error}); speaking local cleanup`,
        "warn",
      );
      toast("Model unavailable - speaking text as-is");
      return true;
    }
    logger?.log?.("TTS", `${label} normalization succeeded chars=${result.text.length}`, "debug");
    return true;
  }

  async function speakAssistantTurn() {
    const tFetch = Date.now();
    const result = await getTurnAssistantText(client, api);
    if (!result || !result.text) {
      logger?.log?.("TTS", "Conversation: no assistant text to speak", "warn");
      return { spoken: false };
    }
    const fetchMs = Date.now() - tFetch;

    showProcessingToast("Normalizing response...");
    const tNormalize = Date.now();
    const turnGen = speechGen;
    // Auto replies are narrated/summarized, so a tight cap is safe here (the
    // manual read-aloud keeps the full 4096).
    const llmResult = await normalizeOrLocal(result.text, systemAuto, 2048);
    const normalizeMs = Date.now() - tNormalize;
    if (turnGen !== speechGen) {
      clearProcessingToast();
      return { spoken: false };
    }
    if (!announceNormalize("Conversation", llmResult)) {
      clearProcessingToast();
      return { spoken: false };
    }

    updateProcessingToast("Speaking...");
    const tSpeak = Date.now();
    await speak(llmResult.text);
    const speakMs = Date.now() - tSpeak;
    clearProcessingToast();
    logger?.log?.(
      "TTS",
      `Conversation timings fetchMs=${fetchMs} normalizeMs=${normalizeMs} speakMs=${speakMs} replyChars=${result.text.length}`,
      "debug",
    );
    return { spoken: true };
  }

  const DEFAULT_KEYBINDS = {
    "tts.speak-last": "<leader>]",
    // No default bind for tts.stop: the global voice-cancel (<leader>.)
    // already stops TTS playback, and pause (<leader>p) freezes it. The
    // command stays available via palette/slash for explicit use or
    // custom rebinding through the `keybinds` option.
    "tts.pause": "<leader>p",
    "tts.rewind": "<leader>-",
    "tts.forward": "<leader>=",
    "tts.replay": "<leader>0",
  };
  // Media-style seek step for the rewind/forward commands.
  const SEEK_STEP_SEC = 5;

  function fmtClock(totalSec) {
    const s = Math.max(0, Math.floor(Number(totalSec) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function progressLabel() {
    const state = utteranceState();
    return `${fmtClock(state.cursorSec)} / ${fmtClock(state.totalSec)}${state.rate !== 1 ? ` @${state.rate}x` : ""}`;
  }
  function kb(value) {
    const kb = opts?.keybinds;
    if (!kb || typeof kb !== "object" || Array.isArray(kb)) return DEFAULT_KEYBINDS[value];
    if (!Object.prototype.hasOwnProperty.call(kb, value)) return DEFAULT_KEYBINDS[value];
    const v = kb[value];
    if (!v || v === "none") return undefined;
    return v;
  }

  const controller = {
    speak: (text) => speak(text),
    speakAssistantTurn,
    stop: () => stopSpeech(),
    // A Chatterbox utterance is "speaking" from the moment it is handed to
    // the sidecar, not only once audio reaches sox. A Piper utterance is
    // "speaking" from synthesis start (piperProc alive) for the same reason.
    isSpeaking: () =>
      player.getState().status !== "idle" ||
      piperProc !== null ||
      piperSynthPending ||
      synthPending,
    pause: () => {
      const ok = player.pause();
      if (ok) statusUpdate();
      return ok;
    },
    resume: () => {
      const ok = player.resume();
      if (ok) statusUpdate();
      return ok;
    },
    replay: () => {
      const ok = player.replay();
      if (ok) {
        collapseUtteranceToPlayer();
        statusUpdate();
      }
      return ok;
    },
    forward: (sec = SEEK_STEP_SEC) => {
      const at = player.forward(sec);
      collapseUtteranceToPlayer();
      statusUpdate();
      return at;
    },
    rewind: (sec = SEEK_STEP_SEC) => {
      const at = player.rewind(sec);
      collapseUtteranceToPlayer();
      statusUpdate();
      return at;
    },
    setRate: (rate) => {
      const applied = player.setRate(rate);
      kv.set("tts.rate", applied);
      statusUpdate();
      return applied;
    },
    getState: () => player.getState(),
    setConversationActive: (v) => {
      conversationActive = !!v;
    },
    setLiveNotesActive: (v) => {
      liveNotesActive = !!v;
    },
  };

  // The Chatterbox sidecar holds a multi-hundred-MB torch model; leaving it
  // running past the session would strand that memory. Same lifecycle hook the
  // STT and live-notes servers use. Also drops the session subscriptions (no
  // duplicate auto-speech after re-registration), kills owned piper/play
  // audio, and invalidates in-flight normalization so a late completion can
  // never speak after unload.
  api.lifecycle?.onDispose?.(() => {
    for (const unsub of eventUnsubs) {
      try {
        unsub();
      } catch {}
    }
    eventUnsubs.length = 0;
    try {
      stopSpeech();
    } catch {}
    chatterboxClient?.stop();
    chatterboxClient = null;
    vieneuClient?.stop();
    vieneuClient = null;
  });

  // ---- Commands ----

  const commands = [
    {
      title: "TTS: speak last response",
      value: "tts.speak-last",
      category: "opencode-voice",
      description: "Read the last assistant response aloud (detailed)",
      ...(kb("tts.speak-last") ? { keybind: kb("tts.speak-last") } : {}),
      slash: { name: "tts-speak" },
      onSelect() {
        speakLastResponse();
      },
    },
    {
      title: "TTS: toggle",
      value: "tts.mode",
      category: "opencode-voice",
      description: "Toggle auto text-to-speech on/off",
      ...(kb("tts.mode") ? { keybind: kb("tts.mode") } : {}),
      slash: { name: "tts-mode" },
      onSelect() {
        const current = kv.get("tts.mode", "off");
        const next = current === "on" ? "off" : "on";
        kv.set("tts.mode", next);
        if (next === "off") stopSpeech();
        if (next === "on") {
          const enVoice =
            TTS_VOICES[kv.get("tts.voice", DEFAULT_TTS_VOICE)] || TTS_VOICES[DEFAULT_TTS_VOICE];
          const viPath = path.join(VOICES_DIR, TTS_VOICES.vi.file);
          const hasVi = fs.existsSync(viPath);
          toast(
            hasVi
              ? `TTS on (auto: ${enVoice.label} / ${TTS_VOICES.vi.label})`
              : `TTS on (${enVoice.label})`,
          );
        } else {
          toast("TTS off");
        }
      },
    },
    {
      title: "TTS: stop playback",
      value: "tts.stop",
      category: "opencode-voice",
      description: "Stop current TTS playback",
      ...(kb("tts.stop") ? { keybind: kb("tts.stop") } : {}),
      slash: { name: "tts-stop" },
      onSelect() {
        if (conversationTtsActive() && conversationTtsHooks.onStopKey?.()) return;
        if (stopSpeech()) toast("TTS stopped");
      },
    },
    {
      title: "TTS: pause / resume playback",
      value: "tts.pause",
      category: "opencode-voice",
      description: "Pause speaking mid-speech, resume when paused",
      ...(kb("tts.pause") ? { keybind: kb("tts.pause") } : {}),
      slash: { name: "tts-pause" },
      onSelect() {
        const state = player.getState();
        if (state.status === "playing" && player.pause()) toast("Paused");
        else if (state.status === "paused" && player.resume()) toast("Resumed");
        else toast("Nothing playing", "warning");
      },
    },
    {
      title: "TTS: replay from start",
      value: "tts.replay",
      category: "opencode-voice",
      description: "Restart the current utterance from zero",
      ...(kb("tts.replay") ? { keybind: kb("tts.replay") } : {}),
      slash: { name: "tts-replay" },
      onSelect() {
        if (player.replay()) toast(`Replaying from start (${progressLabel()})`);
        else toast("Nothing to replay", "warning");
      },
    },
    {
      title: "TTS: rewind 5 seconds",
      value: "tts.rewind",
      category: "opencode-voice",
      description: "Jump back 5 seconds in the current utterance",
      ...(kb("tts.rewind") ? { keybind: kb("tts.rewind") } : {}),
      slash: { name: "tts-rewind" },
      onSelect() {
        if (player.getState().exactTotal) {
          player.rewind(SEEK_STEP_SEC);
          toast(`Rewound (${progressLabel()})`);
        } else toast("Nothing to rewind", "warning");
      },
    },
    {
      title: "TTS: forward 5 seconds",
      value: "tts.forward",
      category: "opencode-voice",
      description: "Jump ahead 5 seconds in the current utterance",
      ...(kb("tts.forward") ? { keybind: kb("tts.forward") } : {}),
      slash: { name: "tts-forward" },
      onSelect() {
        if (player.getState().exactTotal) {
          player.forward(SEEK_STEP_SEC);
          toast(`Forwarded (${progressLabel()})`);
        } else toast("Nothing to skip", "warning");
      },
    },
    {
      title: "TTS: playback speed",
      value: "tts.rate",
      category: "opencode-voice",
      description: "Choose playback speed 0.75x-2x (persisted)",
      slash: { name: "tts-rate" },
      onSelect() {
        const current = String(currentRate());
        api.ui.dialog.replace(() =>
          api.ui.DialogSelect({
            title: "Select playback speed",
            current,
            options: ["0.75", "1", "1.25", "1.5", "1.75", "2"].map((label) => ({
              title: `${label}x`,
              value: label,
              onSelect() {
                const applied = controller.setRate(Number(label));
                toast(`Playback speed: ${applied}x`);
                api.ui.dialog.clear();
              },
            })),
          }),
        );
      },
    },
    {
      title: "TTS: select voice",
      value: "tts.voice",
      category: "opencode-voice",
      description: "Choose TTS voice",
      slash: { name: "tts-voice" },
      onSelect() {
        const current = kv.get("tts.voice", DEFAULT_TTS_VOICE);
        api.ui.dialog.replace(() =>
          api.ui.DialogSelect({
            title: "Select voice (auto vi/en)",
            current,
            options: Object.entries(TTS_VOICES).map(([key, v]) => ({
              title: v.label,
              value: key,
              onSelect() {
                if (key.startsWith("vi")) kv.set("tts.voice.vi", key);
                else kv.set("tts.voice", key);
                toast(`Voice: ${v.label} (auto vi/en)`);
                api.ui.dialog.clear();
              },
            })),
          }),
        );
      },
    },
    {
      title: "TTS: select engine",
      value: "tts.engine",
      category: "opencode-voice",
      description: "Choose TTS engine (piper, chatterbox, vieneu) - persisted",
      slash: { name: "tts-engine" },
      onSelect() {
        const current = kv.get("tts.engine", opts?.ttsEngine || "piper");
        api.ui.dialog.replace(() =>
          api.ui.DialogSelect({
            title: "Select TTS engine",
            current,
            options: [
              { title: "Piper (default, local, vi+en separate voices)", value: "piper" },
              { title: "Chatterbox (English, voice cloning)", value: "chatterbox" },
              { title: "VieNeu-TTS (bilingual vi+en code-switching)", value: "vieneu" },
            ].map((o) => ({
              title: o.title,
              value: o.value,
              onSelect() {
                kv.set("tts.engine", o.value);
                sttLog("tts.engine.set", o.value);
                toast(`TTS engine: ${o.value}`);
                api.ui.dialog.clear();
              },
            })),
          }),
        );
      },
    },
  ];

  return { commands, controller };
}
