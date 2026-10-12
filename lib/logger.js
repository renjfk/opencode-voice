import fs from "node:fs";

const debugLogFile = process.env.OPENCODE_VOICE_LOG;

export function createLogger() {
  function log(scope, message, level = "debug") {
    if (!debugLogFile) return;
    try {
      fs.appendFileSync(
        debugLogFile,
        `${new Date().toISOString()} [${level}] ${scope}: ${message}\n`,
      );
    } catch {
      // Logging should never interrupt voice features.
    }
  }

  return { log };
}
