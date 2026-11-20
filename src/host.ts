// Typed facade over the OpenCode v2 TUI plugin Context. Only the surface the
// plugin uses is declared here (mirrors @opencode/plugin/tui context.d.ts),
// so the rest of the code never touches `any`.
import type { KvStore } from "./config.ts";
import { errorMessage } from "./types.ts";

// ------------------------------------------------------------ host types

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface SelectOption<V> {
  readonly title: string;
  readonly value: V;
  readonly description?: string;
  readonly category?: string;
}

export interface KeymapCommand {
  readonly id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly group?: string;
  readonly bind?: false | string;
  readonly palette?: true;
  readonly slash?: { readonly name: string; readonly aliases?: string[] };
  readonly run: (input?: string) => void | false | Promise<void>;
}

export type Route = { readonly type: string; readonly sessionID?: string };

/** The opentui textarea that owns keyboard focus (the composer, a dialog field...). */
export interface FocusedTextarea {
  readonly plainText: string;
  cursorOffset: number;
  readonly isDestroyed?: boolean;
  insertText(text: string): void;
  deleteRange(startLine: number, startCol: number, endLine: number, endCol: number): void;
  submit(): boolean;
  readonly editBuffer?: { offsetToPosition?(offset: number): { row: number; col: number } | null };
}

export interface HostContext {
  readonly options?: Readonly<Record<string, unknown>>;
  readonly location?: unknown;
  readonly app?: { readonly version: string };
  readonly renderer: { readonly currentFocusedRenderable?: unknown };
  readonly theme?: unknown;
  readonly client: {
    readonly session: {
      create(input: Record<string, unknown>): Promise<{ id: string }>;
      prompt(input: { sessionID: string; text: string }): Promise<unknown>;
    };
  };
  readonly data: {
    on(type: string, handler: (event: { data?: Record<string, unknown> }) => void): () => void;
    readonly session: {
      list(): Array<{ id: string; title?: string }>;
      get?(sessionID: string): { id: string; title?: string } | undefined;
      readonly message: { list(sessionID: string): unknown[] };
    };
    readonly location: {
      readonly provider: { list(): unknown[] | undefined };
      readonly model: { list(): unknown[] | undefined };
    };
  };
  readonly keymap: {
    layer(
      input: () => {
        mode?: string;
        commands?: readonly KeymapCommand[];
        bindings?: readonly string[];
      },
    ): void;
  };
  readonly storage: {
    store<V extends object>(
      key: string,
      options: { initial: V },
    ): readonly [V, (mutation: (draft: V) => void) => Promise<void>];
  };
  readonly ui: {
    readonly toast: {
      show(o: { message: string; variant?: ToastVariant; duration?: number; title?: string }): void;
    };
    readonly dialog: {
      alert(o: { title: string; message: string }): Promise<void>;
      select<V>(o: {
        title: string;
        placeholder?: string;
        options: readonly SelectOption<V>[];
        current?: V;
      }): Promise<V | undefined>;
    };
    readonly router: {
      current(): Route;
      navigate(d: { type: "session"; sessionID: string }): void;
    };
    readonly model?: { current(): { providerID: string; modelID: string } | undefined };
    slot(claim: { render: (input: unknown) => unknown } & Record<string, unknown>): () => void;
  };
}

// --------------------------------------------------------------- facade

export interface Host {
  toast(message: string, variant?: ToastVariant, durationMs?: number): void;
  readonly kv: KvStore;
  select<V>(
    title: string,
    options: readonly SelectOption<V>[],
    current?: V,
  ): Promise<V | undefined>;
  alert(title: string, message: string): void;
  currentSessionID(): string | null;
  /** Session id for gateway headers: current, last seen, or most recent. */
  anySessionID(): string | null;
  sessionTitle(sessionID: string): string | null;
  /** Text of the latest assistant message in a session ("" if none). */
  lastAssistantText(sessionID: string): string;
  /** Last few user/assistant turns, compact, for LLM context. */
  recentTurns(sessionID: string, maxChars?: number): string;
  onSessionIdle(handler: (sessionID: string) => void): () => void;
  sessionModel(): { providerID: string; modelID: string } | null;
  providers(): unknown[];
  models(): unknown[];
  focused(): FocusedTextarea | null;
  /** Submit text as a prompt without a composer (creates a session if needed). */
  promptSession(text: string): Promise<void>;
  registerCommands(commands: readonly KeymapCommand[]): void;
  slot(target: "session.composer.top" | "home.footer", render: () => unknown): () => void;
  readonly theme: unknown;
  dispose(): void;
}

export function isFocusedTextarea(v: unknown): v is FocusedTextarea {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.insertText === "function" &&
    typeof o.plainText === "string" &&
    typeof o.deleteRange === "function" &&
    typeof o.submit === "function"
  );
}

/** Text of a v2 SessionMessageInfo, or null when it is not that role. */
export function messageText(msg: unknown, role: "assistant" | "user"): string | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  const kind = m.type ?? m.role;
  if (kind !== role) return null;
  if (Array.isArray(m.content)) {
    return m.content
      .map((c) =>
        c && typeof c === "object" && (c as Record<string, unknown>).type === "text"
          ? String((c as Record<string, unknown>).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (typeof m.text === "string") return m.text.trim();
  return "";
}

export function createHost(ctx: HostContext): Host {
  const disposers: Array<() => void> = [];

  // Same storage key and shape as the JS plugin, so settings carry over.
  let store: { values?: Record<string, unknown> } | null = null;
  let update: ((m: (d: { values: Record<string, unknown> }) => void) => Promise<void>) | null =
    null;
  const mem = new Map<string, unknown>();
  // Values written by this process but not yet confirmed by the store.
  const pending = new Map<string, unknown>();
  try {
    const pair = ctx.storage.store<{ values: Record<string, unknown> }>("opencode-voice", {
      initial: { values: {} },
    });
    store = pair[0];
    update = pair[1];
  } catch {
    store = null;
  }
  const kv: KvStore = {
    get(key) {
      if (pending.has(key)) return pending.get(key);
      // Read the live store each time: it is synced across TUI instances.
      const live = store?.values;
      if (live && Object.prototype.hasOwnProperty.call(live, key)) return live[key];
      return mem.get(key);
    },
    set(key, value) {
      mem.set(key, value);
      if (!update) return;
      pending.set(key, value);
      void update((draft) => {
        draft.values = { ...draft.values, [key]: value };
      })
        .catch(() => {})
        .finally(() => {
          if (pending.get(key) === value) pending.delete(key);
        });
    },
  };

  const toast: Host["toast"] = (message, variant = "info", durationMs) => {
    try {
      ctx.ui.toast.show({ message, variant, ...(durationMs ? { duration: durationMs } : {}) });
    } catch {}
  };

  let lastSeenSession: string | null = null;
  const currentSessionID = (): string | null => {
    try {
      const r = ctx.ui.router.current();
      const id = r.type === "session" && r.sessionID ? r.sessionID : null;
      if (id) lastSeenSession = id;
      return id;
    } catch {
      return null;
    }
  };
  const anySessionID = (): string | null => {
    const cur = currentSessionID();
    if (cur) return cur;
    if (lastSeenSession) return lastSeenSession;
    try {
      return ctx.data.session.list()[0]?.id ?? null;
    } catch {
      return null;
    }
  };

  const messages = (sessionID: string): unknown[] => {
    try {
      return ctx.data.session.message.list(sessionID) ?? [];
    } catch {
      return [];
    }
  };

  return {
    toast,
    kv,
    async select(title, options, current) {
      try {
        return await ctx.ui.dialog.select({
          title,
          options,
          ...(current !== undefined ? { current } : {}),
        });
      } catch (err) {
        toast(`Picker failed: ${errorMessage(err)}`, "error");
        return undefined;
      }
    },
    alert(title, message) {
      void ctx.ui.dialog.alert({ title, message }).catch(() => {});
    },
    currentSessionID,
    anySessionID,
    sessionTitle(sessionID) {
      try {
        const s =
          ctx.data.session.get?.(sessionID) ??
          ctx.data.session.list().find((x) => x.id === sessionID);
        return s?.title?.trim() || null;
      } catch {
        return null;
      }
    },
    lastAssistantText(sessionID) {
      const list = messages(sessionID);
      for (let i = list.length - 1; i >= 0; i--) {
        const t = messageText(list[i], "assistant");
        if (t !== null && t) return t;
        if (messageText(list[i], "user") !== null) return "";
      }
      return "";
    },
    recentTurns(sessionID, maxChars = 1500) {
      const list = messages(sessionID);
      const out: string[] = [];
      let used = 0;
      for (let i = list.length - 1; i >= 0 && out.length < 4; i--) {
        const a = messageText(list[i], "assistant");
        const u = a === null ? messageText(list[i], "user") : null;
        const text = (a ?? u ?? "").replace(/\s+/g, " ").trim();
        if (!text) continue;
        const line = `${a !== null ? "assistant" : "user"}: ${text.slice(0, 400)}`;
        if (used + line.length > maxChars) break;
        used += line.length;
        out.unshift(line);
      }
      return out.join("\n");
    },
    onSessionIdle(handler) {
      // Hosts differ in which "turn finished" event they emit; listen to all
      // and let the caller dedupe. A short delay lets the message store
      // receive the final text first.
      const fire = (id: unknown): void => {
        if (typeof id !== "string") return;
        setTimeout(() => handler(id), 400);
      };
      const offs: Array<() => void> = [];
      const sub = (type: string, pick: (d: Record<string, unknown>) => unknown): void => {
        try {
          offs.push(ctx.data.on(type, (event) => fire(pick(event?.data ?? {}))));
        } catch {}
      };
      sub("session.idle", (d) => d.sessionID);
      sub("session.execution.succeeded", (d) => d.sessionID);
      sub("session.status", (d) => {
        const st = d.status as { type?: unknown } | undefined;
        return st?.type === "idle" ? d.sessionID : undefined;
      });
      const off = (): void => {
        for (const o of offs.splice(0)) {
          try {
            o();
          } catch {}
        }
      };
      disposers.push(off);
      return off;
    },
    sessionModel() {
      try {
        const m = ctx.ui.model?.current();
        return m?.providerID && m.modelID ? { providerID: m.providerID, modelID: m.modelID } : null;
      } catch {
        return null;
      }
    },
    providers() {
      try {
        return ctx.data.location.provider.list() ?? [];
      } catch {
        return [];
      }
    },
    models() {
      try {
        return ctx.data.location.model.list() ?? [];
      } catch {
        return [];
      }
    },
    focused() {
      const f = ctx.renderer.currentFocusedRenderable;
      return isFocusedTextarea(f) && !f.isDestroyed ? f : null;
    },
    async promptSession(text) {
      let sessionID = currentSessionID();
      if (!sessionID) {
        const created = await ctx.client.session.create(
          ctx.location ? { location: ctx.location } : {},
        );
        sessionID = created.id;
        ctx.ui.router.navigate({ type: "session", sessionID });
      }
      await ctx.client.session.prompt({ sessionID, text });
    },
    registerCommands(commands) {
      const bindings = commands
        .filter((c) => typeof c.bind === "string" && c.bind && c.id)
        .map((c) => c.id as string);
      const register = (): void => {
        try {
          ctx.keymap.layer(() => ({ mode: "global", commands, bindings }));
        } catch (err) {
          toast(`Voice: keymap registration failed: ${errorMessage(err)}`, "error");
        }
      };
      // keymap.layer must run inside a component owner: claim an empty app slot.
      let done = false;
      try {
        const off = ctx.ui.slot({
          append: "app",
          render: () => {
            if (!done) {
              done = true;
              register();
            }
            return null;
          },
        });
        disposers.push(off);
      } catch {
        register();
      }
    },
    slot(target, render) {
      try {
        const off = ctx.ui.slot({ before: target, render: () => render() });
        disposers.push(off);
        return off;
      } catch (err) {
        toast(`Voice: status line unavailable: ${errorMessage(err)}`, "warning");
        return () => {};
      }
    },
    theme: ctx.theme,
    dispose() {
      for (const d of disposers.splice(0)) {
        try {
          d();
        } catch {}
      }
    },
  };
}
