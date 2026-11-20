// Text-to-speech: LLM normalization, Piper synthesis, sox playback.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, exec } from "node:child_process";
import { getSessionTitle } from "./shared/session.js";
import { clearProcessingToast, showProcessingToast, updateProcessingToast } from "./stt.js";
import { createChatterboxClient } from "./sidecars/chatterbox-server.js";
import { createVieneuClient } from "./sidecars/vieneu-server.js";
import { createKokoroClient } from "./sidecars/kokoro-server.js";
import { createEngineRegistry } from "./tts-engines/registry.js";
import { createTtsContext } from "./tts/context.js";
import { createControllerMethods } from "./tts/controller.js";
import { createCommands } from "./tts/commands.js";
import { toLoadArg, measureAudioSec } from "./tts-engines/engine.js";
import { createAudioCache, cacheKey } from "./tts/cache.js";
import {
  detectLang,
  splitSpokenSentences,
  groupSentencesByLang,
  chunkLongGroups,
  MAX_GROUP_CHARS,
} from "./tts/lang.js";
import { createTtsPlayer } from "./tts/player.js";
import { getRemoteConfig, buildRemotePlayCmd } from "./stt/remote.js";
import { getAudioSampleRate } from "./stt/audio.js";
import { nextRate as nextTtsRate } from "./shared/tts-status.js";
import { sttLog } from "./shared/stt-log.js";

const VOICES_DIR = path.join(os.homedir(), ".local", "share", "piper-voices");

const TTS_VOICES = {
  ryan: { label: "Ryan (high)", file: "en_US-ryan-high.onnx" },
  bryce: { label: "Bryce (medium)", file: "en_US-bryce-medium.onnx" },
  vi: { label: "Vais (vi_VN medium)", file: "vi_VN-vais1000-medium.onnx" },
  vi_vivo: { label: "Vivos (vi_VN x_low)", file: "vi_VN-vivos-x_low.onnx" },
};
const DEFAULT_TTS_VOICE = "ryan";
const PIPER_RATE = 22050;

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

  // The message cache can trail the execution-completed signal by a beat, so a
  // single read here can still show the previous turn and report "no reply".
  // Retry briefly instead of dropping the answer.
  let stateMessages = [];
  let assistantIDs = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    stateMessages = api.state.session.messages(sessionID) || [];
    assistantIDs = [];
    for (let i = stateMessages.length - 1; i >= 0; i -= 1) {
      if (stateMessages[i].role === "user") break;
      if (stateMessages[i].role === "assistant") {
        assistantIDs.unshift(stateMessages[i].id);
      }
    }
    if (assistantIDs.length > 0) break;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 150));
  }
  sttLog(
    "tts.conv",
    `getTurnAssistantText session=${sessionID} n=${stateMessages.length} assistants=${assistantIDs.length}`,
  );
  if (assistantIDs.length === 0) return null;

  // The answer is the last assistant message that finished WITHOUT asking for
  // more tool calls. Earlier ones are mid-turn commentary ("let me check...")
  // and reading them aloud reads half a thought. Fall back to the whole turn
  // when no message carries a terminal finish, or when the terminal one holds
  // no prose (a tool-only finish).
  const terminalIDs = assistantIDs.filter((id) => {
    const finish = stateMessages.find((m) => m?.id === id)?.finish;
    return !!finish && finish !== "tool-calls" && finish !== "tool_calls";
  });
  const answerID = terminalIDs.length > 0 ? terminalIDs[terminalIDs.length - 1] : null;

  const textOf = async (msgID) => {
    let fullMsg = stateMessages.find((m) => m?.id === msgID);
    if (!fullMsg || !(fullMsg.parts && fullMsg.parts.length)) {
      try {
        fullMsg = await client.session
          .message({ sessionID, messageID: msgID }, { throwOnError: true })
          .then((r) => r.data);
      } catch {
        fullMsg = null;
      }
    }
    try {
      const textParts = (fullMsg?.parts || []).filter((p) => p.type === "text");
      sttLog(
        "tts.conv",
        `msg=${msgID} parts=${fullMsg?.parts?.length ?? 0} textParts=${textParts.length}`,
      );
      return textParts
        .map((p) => p.text || "")
        .join("\n\n")
        .trim();
    } catch {
      return "";
    }
  };

  let spokenIDs = answerID ? [answerID] : assistantIDs;
  let allText = [];
  for (const msgID of spokenIDs) {
    const text = await textOf(msgID);
    if (text) allText.push(text);
  }
  if (allText.length === 0 && answerID) {
    spokenIDs = assistantIDs;
    for (const msgID of spokenIDs) {
      const text = await textOf(msgID);
      if (text) allText.push(text);
    }
  }

  if (allText.length === 0) return null;

  return {
    lastMessageID: spokenIDs[spokenIDs.length - 1],
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
  // ---- Remote audio backend (optional) ----
  function getTtsPlayCmd() {
    if (process.env.TTS_PLAY_CMD) {
      try {
        const p = JSON.parse(process.env.TTS_PLAY_CMD);
        if (Array.isArray(p) && p.length) return p;
      } catch {}
      return process.env.TTS_PLAY_CMD.split(/\s+/);
    }
    const direct = kv.get("tts.remotePlayCmd") ?? kv.get("ttsPlayCmd") ?? kv.get("tts.playCmd");
    if (Array.isArray(direct) && direct.length) return direct;
    if (kv.get("tts.output") === "remote") {
      const cmd = buildRemotePlayCmd(getRemoteConfig());
      if (cmd) return cmd;
    }
    if (Array.isArray(opts?.ttsPlayCmd) && opts.ttsPlayCmd.length) {
      return opts.ttsPlayCmd;
    }
    return null;
  }
  // The full utterance streams to the phone up front, so killing the local
  // ssh alone does not stop audio already buffered there. Pause/stop/preempt
  // on remote output must also kill the phone-side player. Best-effort and
  // fire-and-forget: local state already moved on, this just silences the phone.
  function killRemotePlayback() {
    try {
      const cfg = getRemoteConfig();
      if (!cfg?.host) return;
      const cmd =
        `ssh -T -o BatchMode=yes -o ConnectTimeout=3 -i ${cfg.key} -p ${cfg.port} ` +
        `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${cfg.host} ` +
        `'killall play 2>/dev/null; killall mpv 2>/dev/null; pkill -f playback.sh 2>/dev/null; true'`;
      exec(cmd, { timeout: 4000 }, () => {});
    } catch {}
  }

  function remotePlayCmd() {
    try {
      const cmd = getTtsPlayCmd();
      return Array.isArray(cmd) && cmd.length ? cmd : null;
    } catch {
      return null;
    }
  }

  logger?.log?.(
    "TTS",
    `Engine=${kv.get("tts.engine", "piper")} opts.engine=${opts?.ttsEngine ?? "none"}`,
    "debug",
  );
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
  // Measured media controller (lib/tts/player.js): every utterance is
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
  // The output command is resolved on EVERY spawn/feed (not once at
  // registration) so /tts-output switches between phone and speaker live,
  // without a TUI restart.
  function realPlayerHooks() {
    const remoteCmd = () => {
      const playCmd = getTtsPlayCmd();
      return Array.isArray(playCmd) && playCmd.length ? playCmd : null;
    };
    const spawnRemote = (playCmd) => {
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
        child = spawn(playCmd[0], playCmd.slice(1), {
          stdio: ["pipe", "ignore", "pipe"],
        });
      } catch (err) {
        logger?.log?.("TTS", `remote play error: ${err.message}`, "error");
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
      child.on("error", (err) => {
        logger?.log?.("TTS", `remote play error: ${err.message}`, "error");
        sttLog("tts.play", `spawn error event: ${err.message}`);
        finish(-1);
      });
      child.on("close", (code) => {
        if (code !== 0 && code !== null) {
          logger?.log?.(
            "TTS",
            `remote play exited code=${code} stderr=${playStderr.trim()}`,
            "error",
          );
        } else {
          logger?.log("TTS", "remote playback finished", "debug");
        }
        sttLog("tts.play", `close code=${code} stderr=${playStderr.trim().slice(-160)}`);
        finish(code);
      });
      return handle;
    };
    const spawnLocal = (argv) => {
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
    };
    return {
      spawn(argv) {
        const playCmd = remoteCmd();
        return playCmd ? spawnRemote(playCmd) : spawnLocal(argv);
      },
      signal: (pid, sig) => {
        try {
          process.kill(pid, sig);
        } catch {}
      },
      now: () => Date.now(),
      feed: (handle, { wav, offsetSec }) => {
        if (!remoteCmd()) {
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
          return;
        }
        try {
          if (!handle.stdin || handle.stdin.destroyed) {
            sttLog("tts.play", "feed skipped: stdin missing/destroyed");
            return;
          }
          sttLog("tts.play", `feed bytes=${wav?.length ?? 0}`);
          // Resume/seek on remote: the phone has no local `play trim`, so
          // skip here with ffmpeg input seeking before piping to ssh.
          const off = Number(offsetSec) || 0;
          const inArgs = off > 0 ? ["-ss", String(off)] : [];
          const ff = spawn(
            "ffmpeg",
            [
              "-hide_banner",
              "-loglevel",
              "error",
              ...inArgs,
              "-i",
              "pipe:0",
              "-f",
              "s16le",
              "-acodec",
              "pcm_s16le",
              "-ar",
              String(getAudioSampleRate()),
              "-ac",
              "1",
              "pipe:1",
            ],
            { stdio: ["pipe", "pipe", "pipe"] },
          );
          ff.stdout.on("data", (chunk) => {
            try {
              handle.stdin.write(chunk);
            } catch {}
          });
          ff.on("close", () => {
            try {
              handle.stdin.end();
            } catch {}
          });
          ff.on("error", () => {
            try {
              handle.stdin.end();
            } catch {}
          });
          try {
            ff.stdin.end(wav);
          } catch {}
        } catch (err) {
          sttLog("tts.play", `feed throw: ${err?.message || err}`);
          try {
            handle.stdin.end();
          } catch {}
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
  // True from the moment a manual read-aloud is requested until its audio
  // finishes: covers the LLM normalization phase, when no player exists yet
  // and isSpeaking() would otherwise report idle (button looked unresponsive).
  let speakPipeline = false;

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
  // is routed to Piper regardless of variant - see the engine registry.
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
      const defaultChatterboxPython =
        "/Users/duytrinh/.local/share/opencode-voice/chatterbox-venv/bin/python";
      chatterboxClient = createChatterbox({
        variant: opts?.ttsChatterboxVariant,
        python:
          opts?.ttsChatterboxPython ||
          (fs.existsSync(defaultChatterboxPython) ? defaultChatterboxPython : undefined),
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
      const defaultVieneuPython =
        "/Users/duytrinh/.local/share/opencode-voice/vieneu-venv/bin/python";
      vieneuClient = createVieneu({
        python:
          opts?.ttsVieneuPython ||
          (fs.existsSync(defaultVieneuPython) ? defaultVieneuPython : undefined),
        voice: kv.get("tts.vieneuVoice", opts?.ttsVieneuVoice || "Mai Anh"),
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

  // ---- Optional Kokoro-TTS engine (lib/kokoro-server.js) ----
  const createKokoro = deps.createKokoroClient ?? createKokoroClient;
  let kokoroClient = null;
  let kokoroStarting = null;
  let kokoroToastShown = false; // failure notice latch
  let kokoroPreparingShown = false; // first-run preparing notice
  let kokoroPythonResolved = opts?.ttsKokoroPython ?? null;

  function runKokoroCommand(bin, args) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        // stderr is piped (not ignored) so a failed install carries its reason
        // into SETUP_FAILED instead of a bare exit code.
        child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
      } catch (err) {
        reject(err);
        return;
      }
      let stderr = "";
      try {
        child.stderr?.on("data", (chunk) => {
          stderr += chunk.toString();
        });
      } catch {}
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve(undefined);
        else {
          const tail = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
          reject(new Error(`${bin} exited with code ${code}${tail ? `: ${tail}` : ""}`));
        }
      });
    });
  }

  // Does this interpreter actually have the packages the sidecar imports?
  // A venv directory alone proves nothing: a partial/aborted first run leaves
  // bin/python behind with no kokoro module, which used to skip setup and
  // fail every speak straight to Piper.
  async function kokoroPythonUsable(bin) {
    // An injected client factory (tests, native host) owns its own runtime;
    // probing would reject a fake python path that never needs to exist.
    if (deps.createKokoroClient) return true;
    if (!bin || !fs.existsSync(bin)) return false;
    try {
      await runKokoroCommand(bin, ["-c", "import kokoro, soundfile"]);
      return true;
    } catch (err) {
      sttLog(
        "kokoro.setup",
        `python ${bin} lacks kokoro/soundfile: ${String(err?.message || err).slice(0, 120)}`,
      );
      return false;
    }
  }

  // Kokoro's stack (torch/scipy) has no builds for very new interpreters
  // (e.g. Python 3.15). uv fetches a compatible one instead of inheriting
  // whatever `python3` happens to be.
  const KOKORO_PYTHON_VERSION = "3.12";

  async function setupKokoroVenv() {
    const venvDir = path.join(os.homedir(), ".local/share/opencode-voice/kokoro-venv");
    const defaultPython = path.join(venvDir, "bin", "python");
    if (kokoroPythonResolved) {
      if (await kokoroPythonUsable(kokoroPythonResolved)) {
        sttLog("kokoro.setup", `using configured python: ${kokoroPythonResolved}`);
        return kokoroPythonResolved;
      }
      sttLog("kokoro.setup", `configured python unusable, reinstalling: ${kokoroPythonResolved}`);
      kokoroPythonResolved = null;
    }
    if (fs.existsSync(defaultPython)) {
      if (await kokoroPythonUsable(defaultPython)) {
        kokoroPythonResolved = defaultPython;
        sttLog("kokoro.setup", `using existing venv python: ${defaultPython}`);
        return kokoroPythonResolved;
      }
      sttLog("kokoro.setup", "existing venv is missing packages - recreating it");
    } else {
      sttLog("kokoro.setup", "no venv found - creating it");
    }
    if (!kokoroPreparingShown) {
      kokoroPreparingShown = true;
      toast("Kokoro is preparing (~350 MB, first run only)...");
    }
    try {
      // Start clean: a partial venv (dir without working packages) is what
      // stranded users on Piper with no visible reason.
      sttLog("kokoro.setup", `uv venv --python ${KOKORO_PYTHON_VERSION}`);
      try {
        fs.rmSync(venvDir, { recursive: true, force: true });
      } catch {}
      fs.mkdirSync(path.dirname(venvDir), { recursive: true });
      await runKokoroCommand("uv", ["venv", "--python", KOKORO_PYTHON_VERSION, venvDir]);
      const freshPython = path.join(venvDir, "bin", "python");
      // The pipeline needs misaki's spacy model too; without it KPipeline
      // init tries to fetch it at runtime and dies (SystemExit), which used
      // to strand the sidecar on "loading" until the ready timeout.
      sttLog("kokoro.setup", `uv pip install kokoro soundfile spacy-model`);
      await runKokoroCommand("uv", [
        "pip",
        "install",
        "--python",
        freshPython,
        "kokoro",
        "soundfile",
        "https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl",
      ]);
      kokoroPythonResolved = freshPython;
      sttLog("kokoro.setup", `venv ready: ${kokoroPythonResolved}`);
      return kokoroPythonResolved;
    } catch (err) {
      sttLog("kokoro.setup", `SETUP_FAILED: ${String(err?.message || err).slice(0, 200)}`);
      noteKokoroFailure(`Kokoro unavailable (SETUP_FAILED: ${err?.message || err})`);
      kokoroPythonResolved = null;
      throw err;
    }
  }

  function noteKokoroFailure(message) {
    logger?.log?.("TTS", message, "warn");
    if (kokoroToastShown) return;
    kokoroToastShown = true;
    toast(`${message} - using Piper`);
  }

  function noteKokoroOk() {
    kokoroToastShown = false;
    kokoroPreparingShown = false;
  }

  function getKokoroClient() {
    if (kokoroClient) return kokoroClient;
    // Only a python verified by ensureKokoroReady may start a sidecar: an
    // unverified default path is how a broken venv reached the spawn.
    const python = kokoroPythonResolved;
    if (!python) return null;
    kokoroClient = createKokoro({
      python,
      voice: kv.get("tts.kokoroVoice", opts?.ttsKokoroVoice || "af_heart"),
      logger,
    });
    return kokoroClient;
  }

  async function ensureKokoroReady() {
    if (kokoroClient?.isRunning()) return true;
    if (kokoroStarting) return kokoroStarting;
    kokoroStarting = (async () => {
      let python = kokoroPythonResolved;
      if (python && !(await kokoroPythonUsable(python))) python = null;
      if (!python) {
        try {
          python = await setupKokoroVenv();
        } catch {
          python = null;
        }
      }
      if (!python) {
        sttLog("kokoro.ready", "no python available - cannot start");
        return false;
      }
      kokoroPythonResolved = python;
      const client = getKokoroClient();
      if (!client) {
        sttLog("kokoro.ready", "no client (no python resolved)");
        return false;
      }
      try {
        const ok = await client.start();
        if (ok) {
          sttLog("kokoro.ready", `sidecar ready port=${client.getPort?.() ?? "?"}`);
          noteKokoroOk();
          return true;
        }
        const err = client.getLastError?.();
        sttLog(
          "kokoro.ready",
          `start failed code=${err?.code || "START_FAILED"} msg=${String(err?.message || "unknown").slice(0, 200)}`,
        );
        noteKokoroFailure(
          `Kokoro unavailable (${err?.code || "START_FAILED"}: ${err?.message || "unknown"})`,
        );
        return false;
      } catch (err) {
        noteKokoroFailure(`Kokoro unavailable (${err?.message || err})`);
        return false;
      }
    })();
    try {
      return await kokoroStarting;
    } finally {
      kokoroStarting = null;
    }
  }

  // One registry per registration: adapters wrap the closures above (lazy
  // client construction, toast helpers) so behavior is unchanged in Phase 1.
  // Repeat playback without re-inference: group assets keyed by engine +
  // language + voice selection + text. Per-registration so one utterance
  // never hears another session's audio.
  const audioCache = createAudioCache();
  const registry = createEngineRegistry({
    opts,
    kv,
    logger,
    toast,
    deps: {
      ...deps,
      api,
      getChatterboxClient,
      ensureChatterboxReady,
      getVieneuClient,
      ensureVieneuReady,
      resetVieneuClient: () => {
        vieneuClient = null;
      },
      disposeChatterbox: () => {
        try {
          chatterboxClient?.stop?.();
        } catch {}
        chatterboxClient = null;
      },
      disposeVieneu: () => {
        try {
          vieneuClient?.stop?.();
        } catch {}
        vieneuClient = null;
      },
      getKokoroClient,
      ensureKokoroReady,
      resetKokoroClient: () => {
        kokoroClient = null;
      },
      disposeKokoro: () => {
        try {
          kokoroClient?.stop?.();
        } catch {}
        kokoroClient = null;
      },
      synthPiperToPcm,
      resolveVoice: resolveVoiceOrWarn,
      getVoiceRate,
      piperOnPath,
    },
  });

  // Adapter-contributed commands (e.g. /tts-vieneu-voice) are collected once
  // here so they appear exactly once in the returned command list.
  const adapterCommands = registry
    .list()
    .flatMap((engine) =>
      typeof engine.commands === "function"
        ? engine.commands()
        : Array.isArray(engine.commands)
          ? engine.commands
          : [],
    );

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
    if (takingOver) {
      statusClear();
      if (remotePlayCmd()) killRemotePlayback();
    }

    // VieNeu-TTS handles bilingual code-switching in one pass, so the
    // whole utterance goes as a single group (no per-sentence routing).
    // Every engine still gets long spans chunked: same-language pieces only,
    // so code-switching and voice selection are unchanged.
    const engine = kv.get("tts.engine", opts?.ttsEngine);
    const groups = chunkLongGroups(
      engine === "vieneu" ? [{ lang: "vi", text: line }] : groupSentencesByLang(line),
    );
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
      // Every group failed: never leave the "Loading voice" line spinning.
      utterReset();
      statusClear();
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
      // A preempted utterance settles AFTER the next speak() mounted its
      // status line; only the current generation may tear it down.
      if (myGen === speechGen) {
        utterReset();
        statusClear();
      }
    }
  }

  // Per-engine failure/success notifiers. Adding an engine only requires an
  // entry here (plus its adapter) - no per-engine branch in the synthesis path.
  const ENGINE_NOTIFIERS = {
    chatterbox: {
      label: "Chatterbox",
      noteFailure: noteChatterboxFailure,
      noteOk: noteChatterboxOk,
      onSuccess: (group, audio) => {
        logger?.log?.(
          "TTS",
          `Speak via Chatterbox chars=${group.text.length} lang=${group.lang} wavBytes=${audio?.wav?.length ?? 0}`,
          "debug",
        );
      },
    },
    vieneu: {
      label: "VieNeu-TTS",
      noteFailure: noteVieneuFailure,
      noteOk: noteVieneuOk,
    },
    kokoro: {
      label: "Kokoro",
      noteFailure: noteKokoroFailure,
      noteOk: noteKokoroOk,
    },
  };

  // Voice selection as the adapters see it: a voice change must miss the
  // cache, otherwise yesterday's voice replays for today's setting.
  function voiceKeyFor() {
    try {
      return [
        kv.get("tts.voice", opts?.ttsVoice || ""),
        kv.get("tts.vieneuVoice", opts?.ttsVieneuVoice || ""),
        kv.get("tts.kokoroVoice", opts?.ttsKokoroVoice || ""),
        kv.get("tts.chatterboxVariant", opts?.ttsChatterboxVariant || ""),
      ].join("~");
    } catch {
      return "";
    }
  }

  // Buffer one language group to a measured asset. Chatterbox failure falls
  // back to Piper for THIS group only; other groups are unaffected. Returns
  // null when stopped, when no voice exists, or when nothing is speakable -
  // callers skip null groups instead of going silent.
  async function synthGroupAsset(group, resolveGroupVoice, myGen) {
    const effectiveOpts = { ...opts, ttsEngine: kv.get("tts.engine", opts?.ttsEngine) };
    const route = registry.resolve(effectiveOpts.ttsEngine, group.lang);
    sttLog("tts.synth", `lang=${group.lang} engine=${route.engine.id} chars=${group.text.length}`);

    // Run one engine to a measured, playable asset. Returns null when the
    // generation was invalidated mid-flight (caller drops the whole utterance),
    // { ok: false } when the engine declined (so the caller can fall back),
    // or { ok: true, totalSec, loadArg } on success.
    async function run(engine) {
      if (myGen !== speechGen) return null;
      const key = cacheKey({
        engineId: engine.id,
        lang: group.lang,
        voiceKey: voiceKeyFor(),
        text: group.text,
      });
      const cached = audioCache.get(key);
      if (cached) {
        if (myGen !== speechGen) return null;
        sttLog("tts.synth", `${engine.id} cache hit chars=${group.text.length}`);
        const loadArg = toLoadArg(cached.audio);
        if (loadArg) loadArg.rate = currentRate();
        if (loadArg) return { ok: true, totalSec: cached.totalSec, loadArg };
        // Corrupt entry shape: drop it and synthesize fresh.
      }
      if (engine.tracksPending) piperSynthPending = true;
      let result;
      try {
        result = await engine.synthesize(group.text, { lang: group.lang });
      } catch (err) {
        result = { ok: false, code: "REQUEST_FAILED", message: err?.message || String(err) };
      } finally {
        if (engine.tracksPending) piperSynthPending = false;
      }
      if (myGen !== speechGen) return null;
      const notifier = ENGINE_NOTIFIERS[engine.id];
      if (!result?.ok) {
        sttLog(
          "tts.synth",
          `${engine.id} failed code=${result?.code} msg=${String(result?.message ?? "").slice(0, 200)} - falling back as configured`,
        );
        // Last line of defense against non-string adapter messages: without
        // this an object error renders as the useless "[object Object]".
        const detail =
          typeof result?.message === "string" && result.message
            ? result.message
            : (() => {
                try {
                  return JSON.stringify(result?.message)?.slice(0, 300) || String(result?.code);
                } catch {
                  return String(result?.code);
                }
              })();
        const msg = notifier
          ? `${notifier.label} synthesis failed (${result?.code}: ${detail})`
          : null;
        if (msg) notifier.noteFailure(msg);
        return { ok: false, engine };
      }
      const audio = result.audio;
      const loadArg = toLoadArg(audio);
      if (loadArg) loadArg.rate = currentRate();
      const totalSec = measureAudioSec(audio);
      if (!loadArg || !(totalSec > 0)) {
        const msg = notifier
          ? `${notifier.label} synthesis failed (BAD_WAV: unreadable audio)`
          : null;
        if (msg) notifier.noteFailure(msg);
        return { ok: false, engine };
      }
      audioCache.set(key, { audio, totalSec });
      notifier?.noteOk?.();
      notifier?.onSuccess?.(group, audio);
      sttLog(
        "tts.synth",
        `${engine.id} ok=true wavBytes=${audio?.wav?.length ?? audio?.pcm?.length ?? 0}`,
      );
      return { ok: true, totalSec, loadArg };
    }

    // First attempt on the resolved engine.
    const first = await run(route.engine);
    if (first === null) return null;
    if (first.ok) return { totalSec: first.totalSec, loadArg: first.loadArg };

    // Fall back to Piper for this group only when a non-Piper engine declined.
    if (route.engine !== registry.get("piper")) {
      const piper = registry.get("piper");
      const second = await run(piper);
      if (second === null) return null;
      if (second.ok) return { totalSec: second.totalSec, loadArg: second.loadArg };
    }
    return null;
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
    if (remotePlayCmd()) killRemotePlayback();
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

  async function speakLastResponse() {
    // Conversation owns TTS while it is on: a manual read would preempt the
    // loop's playback, and the loop would then reopen the mic while the manual
    // audio is still playing (the mic hears its own voice).
    if (conversationActive) {
      toast("Conversation mode speaks replies automatically - use the conversation key to talk");
      return;
    }
    speakPipeline = true;
    try {
      const result = await getTurnAssistantText(client, api);
      if (!result || !result.text) {
        toast("No assistant response to speak", "warning");
        return;
      }
      await speakManualText(result.text);
    } finally {
      speakPipeline = false;
    }
  }

  // Shared tail for any manual read-aloud: normalize, announce, speak.
  async function speakManualText(text) {
    if (!text) {
      toast("No assistant response to speak", "warning");
      return;
    }
    showProcessingToast("Normalizing response...");
    const manualGen = speechGen;
    const llmResult = await normalizeOrLocal(text, systemManual, 4096);
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

  async function getAssistantMessageText(sessionID, messageID) {
    let fullMsg = (api.state.session.messages(sessionID) || []).find((m) => m?.id === messageID);
    if (!fullMsg || !(fullMsg.parts && fullMsg.parts.length)) {
      try {
        fullMsg = await client.session
          .message({ sessionID, messageID }, { throwOnError: true })
          .then((r) => r.data);
      } catch {
        fullMsg = null;
      }
    }
    const textParts = (fullMsg?.parts || []).filter((p) => p.type === "text");
    return textParts
      .map((p) => p.text || "")
      .join("\\n\\n")
      .trim();
  }

  async function speakPastResponse() {
    if (conversationActive) {
      toast("Conversation mode speaks replies automatically - use the conversation key to talk");
      return;
    }
    const route = api.route.current;
    if (route?.name !== "session") {
      toast("No session open", "warning");
      return;
    }
    const sessionID = route.params.sessionID;
    const messages = api.state.session.messages(sessionID) || [];
    const assistantMsgs = messages.filter((m) => m?.role === "assistant");
    if (assistantMsgs.length === 0) {
      toast("No past assistant response to speak", "warning");
      return;
    }
    const ordered = [...assistantMsgs].reverse();
    const options = ordered.map((m, i) => {
      const parts = (api.state.part ? api.state.part(m.id) : m.parts) || [];
      const text = (parts || [])
        .filter((p) => p.type === "text")
        .map((p) => p.text || "")
        .join(" ")
        .trim();
      const preview = text ? text.replace(/\\s+/g, " ").slice(0, 70) : `Assistant reply ${i + 1}`;
      return {
        title: preview,
        value: m.id,
        onSelect: async () => {
          api.ui.dialog.clear();
          const fullText = await getAssistantMessageText(sessionID, m.id);
          await speakManualText(fullText);
        },
      };
    });
    api.ui.dialog.replace(() =>
      api.ui.DialogSelect({
        title: "Select a past response to speak",
        options,
      }),
    );
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
    sttLog("tts.conv", "speakAssistantTurn start");
    const tFetch = Date.now();
    const result = await getTurnAssistantText(client, api);
    sttLog("tts.conv", `speakAssistantTurn result=${!!result} text=${result?.text?.length ?? 0}`);
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
      sttLog("tts.conv", "announceNormalize failed");
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

  // Threaded context (Phase C2): built once here so the extracted
  // controller/commands modules take a single object instead of 40 closure
  // vars. Behavior is unchanged - the context is additive.
  const ttsCtx = createTtsContext({
    api,
    kv,
    complete,
    prompts,
    opts,
    logger,
    toast,
    deps,
    state: {},
  });
  // Shared mutable flags + helpers (all defined above).
  ttsCtx.player = player;
  ttsCtx.piperProc = () => piperProc;
  ttsCtx.setPiperProc = (v) => {
    piperProc = v;
  };
  ttsCtx.piperSynthPending = () => piperSynthPending;
  ttsCtx.setPiperSynthPending = (v) => {
    piperSynthPending = v;
  };
  ttsCtx.synthPending = () => synthPending;
  ttsCtx.setSynthPending = (v) => {
    synthPending = v;
  };
  ttsCtx.speechGen = () => speechGen;
  ttsCtx.setSpeechGen = (v) => {
    speechGen = v;
  };
  ttsCtx.utterDoneSec = () => utterDoneSec;
  ttsCtx.setUtterDoneSec = (v) => {
    utterDoneSec = v;
  };
  ttsCtx.utterTotalSec = () => utterTotalSec;
  ttsCtx.setUtterTotalSec = (v) => {
    utterTotalSec = v;
  };
  ttsCtx.utterActive = () => utterActive;
  ttsCtx.setUtterActive = (v) => {
    utterActive = v;
  };
  ttsCtx.utterLoading = () => utterLoading;
  ttsCtx.setUtterLoading = (v) => {
    utterLoading = v;
  };
  ttsCtx.conversationActive = () => conversationActive;
  ttsCtx.setConversationActive = (v) => {
    conversationActive = v;
  };
  ttsCtx.conversationTtsActive = conversationTtsActive;
  // Live getter: tests (and conversation mode) mutate the hooks after
  // registration via __setConversationTtsHooks, so a captured value would
  // be stale and the pause/mode commands would never see the conversation.
  Object.defineProperty(ttsCtx, "conversationTtsHooks", {
    get: () => conversationTtsHooks,
    enumerable: true,
  });
  ttsCtx.__setConversationTtsHooks = __setConversationTtsHooks;
  ttsCtx.eventUnsubs = eventUnsubs;
  ttsCtx.currentRate = currentRate;
  ttsCtx.nextTtsRate = nextTtsRate;
  ttsCtx.progressLabel = progressLabel;
  ttsCtx.collapseUtteranceToPlayer = collapseUtteranceToPlayer;
  ttsCtx.utteranceState = utteranceState;
  ttsCtx.utterReset = utterReset;
  ttsCtx.statusBegin = statusBegin;
  ttsCtx.statusUpdate = statusUpdate;
  ttsCtx.statusClear = statusClear;
  ttsCtx.killProcs = killProcs;
  ttsCtx.speak = speak;
  ttsCtx.speakAssistantTurn = speakAssistantTurn;
  ttsCtx.isSpeaking = () =>
    speakPipeline ||
    player.getState().status !== "idle" ||
    piperProc !== null ||
    piperSynthPending ||
    synthPending;
  ttsCtx.pause = () => {
    const remote = remotePlayCmd();
    const ok = remote ? player.pauseHard() : player.pause();
    if (ok) {
      if (remote) killRemotePlayback();
      statusUpdate();
    }
    return ok;
  };
  ttsCtx.resume = () => {
    const ok = player.resume();
    if (ok) statusUpdate();
    return ok;
  };
  ttsCtx.replay = () => {
    const ok = player.replay();
    if (ok) {
      collapseUtteranceToPlayer();
      statusUpdate();
    }
    return ok;
  };
  ttsCtx.forward = (sec) => {
    const at = player.forward(sec);
    collapseUtteranceToPlayer();
    statusUpdate();
    return at;
  };
  ttsCtx.rewind = (sec) => {
    const at = player.rewind(sec);
    collapseUtteranceToPlayer();
    statusUpdate();
    return at;
  };
  ttsCtx.setRate = (rate) => {
    const applied = player.setRate(rate);
    kv.set("tts.rate", applied);
    statusUpdate();
    return applied;
  };
  ttsCtx.getState = () => player.getState();
  ttsCtx.setConversationActive = (v) => {
    conversationActive = !!v;
  };
  ttsCtx.speakGroups = speakGroups;
  ttsCtx.synthGroupAsset = synthGroupAsset;
  ttsCtx.stopSpeech = stopSpeech;
  ttsCtx.killRemotePlayback = killRemotePlayback;
  ttsCtx.remotePlayCmd = remotePlayCmd;
  ttsCtx.getTtsPlayCmd = getTtsPlayCmd;
  ttsCtx.getRemoteConfig = getRemoteConfig;
  ttsCtx.buildRemotePlayCmd = buildRemotePlayCmd;
  ttsCtx.getAudioSampleRate = getAudioSampleRate;
  ttsCtx.speakManualText = speakManualText;
  ttsCtx.speakLastResponse = speakLastResponse;
  ttsCtx.speakPastResponse = speakPastResponse;
  ttsCtx.speakWithSessionPrefix = speakWithSessionPrefix;
  ttsCtx.getTurnAssistantText = (client, api) => getTurnAssistantText(client, api);
  ttsCtx.getAssistantMessageText = (sid, mid) => getAssistantMessageText(sid, mid);
  ttsCtx.announceNormalize = announceNormalize;
  ttsCtx.normalizeForSpeech = normalizeForSpeech;
  ttsCtx.normalizeOrLocal = normalizeOrLocal;
  ttsCtx.getVoiceModel = getVoiceModel;
  ttsCtx.piperOnPath = piperOnPath;
  ttsCtx.getVoiceRate = getVoiceRate;
  ttsCtx.resolveVoiceOrWarn = resolveVoiceOrWarn;
  ttsCtx.synthPiperToPcm = synthPiperToPcm;
  ttsCtx.getChatterboxClient = getChatterboxClient;
  ttsCtx.noteChatterboxFailure = noteChatterboxFailure;
  ttsCtx.noteChatterboxOk = noteChatterboxOk;
  ttsCtx.getVieneuClient = getVieneuClient;
  ttsCtx.noteVieneuFailure = noteVieneuFailure;
  ttsCtx.noteVieneuOk = noteVieneuOk;
  ttsCtx.getKokoroClient = getKokoroClient;
  ttsCtx.noteKokoroFailure = noteKokoroFailure;
  ttsCtx.noteKokoroOk = noteKokoroOk;
  ttsCtx.ensureChatterboxReady = ensureChatterboxReady;
  ttsCtx.ensureVieneuReady = ensureVieneuReady;
  ttsCtx.ensureKokoroReady = ensureKokoroReady;
  ttsCtx.disposeChatterbox = () => {
    try {
      chatterboxClient?.stop?.();
    } catch {}
    chatterboxClient = null;
  };
  ttsCtx.disposeVieneu = () => {
    try {
      vieneuClient?.stop?.();
    } catch {}
    vieneuClient = null;
  };
  ttsCtx.disposeKokoro = () => {
    try {
      kokoroClient?.stop?.();
    } catch {}
    kokoroClient = null;
  };
  ttsCtx.resetVieneuClient = () => {
    vieneuClient = null;
  };
  ttsCtx.resetKokoroClient = () => {
    kokoroClient = null;
  };
  ttsCtx.kb = kb;
  ttsCtx.TTS_VOICES = TTS_VOICES;
  ttsCtx.DEFAULT_TTS_VOICE = DEFAULT_TTS_VOICE;
  ttsCtx.VOICES_DIR = VOICES_DIR;
  ttsCtx.fs = fs;
  ttsCtx.path = path;
  ttsCtx.sttLog = sttLog;
  ttsCtx.SEEK_STEP_SEC = SEEK_STEP_SEC;
  ttsCtx.PLAYER_RATE_MIN = 0.75;
  ttsCtx.PLAYER_RATE_MAX = 2;
  ttsCtx.voicesDir = VOICES_DIR;
  ttsCtx.registry = registry;
  ttsCtx.adapterCommands = adapterCommands;
  ttsCtx.kv = kv;
  ttsCtx.api = api;
  ttsCtx.opts = opts;
  ttsCtx.logger = logger;
  ttsCtx.deps = deps;
  ttsCtx.complete = complete;
  ttsCtx.prompts = prompts;
  ttsCtx.toast = toast;

  const controller = createControllerMethods(ttsCtx);

  const commands = createCommands(ttsCtx);

  ttsCtx.controller = controller;

  // cancel.js delegation: expose actions.stopAll so cancelEverything can call it.
  if (typeof deps.setVoiceActions === "function")
    deps.setVoiceActions({ stopAll: () => stopSpeech() });

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
    try {
      chatterboxClient?.stop?.();
    } catch {}
    chatterboxClient = null;
    try {
      vieneuClient?.stop?.();
    } catch {}
    vieneuClient = null;
    try {
      kokoroClient?.stop?.();
    } catch {}
    kokoroClient = null;
  });

  return { commands, controller, context: ttsCtx };
}

// Re-exports of relocated helpers (kept for existing test imports).
export {
  detectLang,
  splitSpokenSentences,
  groupSentencesByLang,
  chunkLongGroups,
  MAX_GROUP_CHARS,
  isSpeakableSentence,
} from "./tts/lang.js";
