// Local file log for STT/streaming diagnosis (user-requested).
//
// Why this exists: v2 toasts are one-shot and the slot preview's fate is
// invisible from the UI. This log records which branch ran (batch vs
// streaming), what the preview did, and toast emissions, so the next
// recording answers "what happened" without guessing.
//
// Privacy: local /tmp only, never shipped. Free text (partials, messages)
// is truncated to 120 chars; options/endpoints/keys are never logged.
// Disable with OPENCODE_VOICE_DEBUG_LOG=0. Rotates at ~512KB.
import fs from "node:fs";

const LOG_PATH = "/tmp/opencode-voice-stt.log";
const MAX_BYTES = 512 * 1024;
const MAX_TEXT = 120;

function enabled() {
  return process.env.OPENCODE_VOICE_DEBUG_LOG !== "0";
}

export function trunc(value) {
  const s = String(value ?? "");
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s;
}

export function sttLog(event, details = "") {
  if (!enabled()) return;
  try {
    let header = "";
    try {
      if (fs.statSync(LOG_PATH).size > MAX_BYTES) {
        header = `--- rotated ${new Date().toISOString()} ---\n`;
        fs.writeFileSync(LOG_PATH, header);
      }
    } catch {}
    const line = `${new Date().toISOString()} pid=${process.pid} ${event}${details ? ` ${trunc(details)}` : ""}\n`;
    fs.appendFileSync(LOG_PATH, header + line);
  } catch {}
}
