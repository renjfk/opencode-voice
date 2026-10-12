// Shared session helpers for the OpenCode V2 CLI plugin.

/**
 * Get the title of a specific session by ID. Returns "" if unknown or on error.
 */
export function getSessionTitle(context, sessionID) {
  if (!sessionID) return "";
  try {
    return context.data.session.get(sessionID)?.title || "";
  } catch {
    return "";
  }
}

/**
 * Get the title of the most recently updated session. Returns "" on error or
 * when there are no sessions.
 */
export function getActiveSessionTitle(context) {
  try {
    const sessions = context.data.session.list() ?? [];
    if (sessions.length === 0) return "";
    const active = [...sessions].sort((a, b) => b.time.updated - a.time.updated)[0];
    return active?.title || "";
  } catch {
    return "";
  }
}
