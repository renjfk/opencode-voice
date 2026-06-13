export function createLogger(client) {
  async function log(scope, message, level = "debug") {
    try {
      await client?.app?.log?.({
        body: {
          service: "opencode-voice",
          level,
          message,
          extra: { scope },
        },
      });
    } catch {
      // Logging should never interrupt voice features.
    }
  }

  return { log };
}
