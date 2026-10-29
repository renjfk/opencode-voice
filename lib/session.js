// Shared session helpers for OpenCode TUI plugin.

/**
 * Get the title of a specific session by ID. Returns "" if unknown or on error.
 */
export async function getSessionTitle(client, sessionID) {
  if (!sessionID) return "";
  try {
    const result = await client.session.list();
    const session = result.data?.find((s) => s.id === sessionID);
    return session?.title || "";
  } catch {
    return "";
  }
}

/**
 * Get the title of the most recently updated session. Returns "" on error or
 * when there are no sessions.
 */
export async function getActiveSessionTitle(client) {
  try {
    const result = await client.session.list();
    if (!result.data || result.data.length === 0) return "";
    const active = result.data.sort((a, b) => b.time.updated - a.time.updated)[0];
    return active?.title || "";
  } catch {
    return "";
  }
}

async function resolveSessionID(client, api) {
  const route = api?.route?.current;
  if (route?.name === "session" && route?.params?.sessionID) {
    return route.params.sessionID;
  }
  try {
    const result = await client.session.list();
    if (!result.data || result.data.length === 0) return null;
    const active = result.data.sort((a, b) => b.time.updated - a.time.updated)[0];
    return active?.id || null;
  } catch {
    return null;
  }
}

function messageText(api, msg) {
  try {
    const parts = api?.state?.part?.(msg.id) || [];
    const text = parts
      .filter((p) => p?.type === "text" && p?.text)
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  } catch {}
  // Compact sessions may only carry summaries on the message itself.
  const summary = msg?.summary
    ? [msg.summary.title, msg.summary.body].filter(Boolean).join(" — ")
    : "";
  return summary || "";
}

/**
 * Get a compact, bounded slice of recent conversation turns for LLM context
 * (e.g. STT normalization that must resolve names/pronouns like Cristina).
 *
 * Returns "user: ...\nassistant: ..." lines, newest last, capped at
 * maxMessages turns and maxChars total (tail kept on overflow). Returns ""
 * whenever context is unavailable - callers must treat that as "no context"
 * and proceed without it.
 */
export async function getRecentConversationContext(client, api, options = {}) {
  const maxMessages = Number(options.maxMessages) > 0 ? Math.floor(Number(options.maxMessages)) : 8;
  const maxChars = Number(options.maxChars) > 0 ? Math.floor(Number(options.maxChars)) : 3000;
  const PER_MESSAGE_CHARS = 800;
  try {
    const sessionID = await resolveSessionID(client, api);
    if (!sessionID) return "";
    const messages = api?.state?.session?.messages?.(sessionID) || [];
    if (!Array.isArray(messages) || messages.length === 0) return "";
    const lines = [];
    for (const msg of messages.slice(-maxMessages)) {
      const role = msg?.role === "assistant" ? "assistant" : "user";
      let text = messageText(api, msg).trim().replace(/\s+/g, " ");
      if (!text) continue;
      if (text.length > PER_MESSAGE_CHARS) text = text.slice(0, PER_MESSAGE_CHARS) + "…";
      lines.push(`${role}: ${text}`);
    }
    if (lines.length === 0) return "";
    let joined = lines.join("\n");
    if (joined.length > maxChars) {
      let cut = joined.slice(joined.length - maxChars);
      const newline = cut.indexOf("\n");
      if (newline !== -1) cut = cut.slice(newline + 1);
      joined = cut;
    }
    return joined;
  } catch {
    return "";
  }
}
