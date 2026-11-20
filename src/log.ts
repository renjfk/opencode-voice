// Private diagnostic log. Never contains transcript or speech text: callers
// log lengths, ids and error messages only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LogLevel, Logger } from "./types.ts";

const MAX_BYTES = 1_000_000;

export function defaultLogPath(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "opencode-voice", "voice.log");
}

export function createFileLogger(file = defaultLogPath(), minLevel: LogLevel = "debug"): Logger {
  const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  let ready = false;
  function ensure(): boolean {
    if (ready) return true;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      try {
        if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
      } catch {}
      // O_NOFOLLOW: refuse a pre-planted symlink at the log path.
      const fd = fs.openSync(
        file,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_APPEND |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      fs.closeSync(fd);
      ready = true;
    } catch {
      ready = false;
    }
    return ready;
  }
  return {
    log(scope, message, level = "debug") {
      if (order[level] < order[minLevel]) return;
      if (!ensure()) return;
      try {
        fs.appendFileSync(
          file,
          `${new Date().toISOString()} pid=${process.pid} ${level} [${scope}] ${message}\n`,
          { mode: 0o600 },
        );
      } catch {}
    },
  };
}

export const nullLogger: Logger = { log() {} };
