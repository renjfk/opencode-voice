import { createV2Preview } from "./v2-preview.js";
import { createTtsStatus } from "./tts-status.js";
import { createConversationStatus } from "./conversation-status.js";

// OpenCode v2 compatibility shim.
//
// WHY this file exists: v2's TUI plugin `Context` renamed or replaced every
// v1 `TuiPluginApi` surface this plugin uses (see the drift table in the
// research goal's progress.md). Rather than forking every lib module, this
// adapter presents a v1-shaped `api` over a v2 `Context` so the SAME core
// modules run unmodified. Every mapping is capability-detected (feature
// presence, never version strings), and every surface with no v2 path
// degrades loudly (warn log + honest toast), never silently.
//
// Composer editing on v2: there is no plugin-reachable append-to-composer
// call (`tui.prompt.append` exists only as a server→TUI event type, not a
// client method), but `Context.renderer` IS the live `CliRenderer`. So the
// adapted api forwards it, and the shared `insertIntoFocusedInput` helper
// types at the cursor of whatever editable field currently has focus — the
// session composer, a dialog search box, or another plugin's input. Only an
// explicit submit (`/stt-submit`, `sttAutoSubmit`, conversation) presses
// Enter. With no editable field focused, text is retained in a recovery
// dialog instead of being sent as a prompt.

// Event renames with no same-named v2 equivalent. Values are the v2 event
// type to subscribe to instead (both verified present in the v2
// `OpenCodeEvent` union; `question.asked` has NO v2 counterpart —
// `form.created` is the closest gate signal and is best-effort, see below).
const EVENT_REMAP = {
  "message.part.delta": "session.text.delta",
  "question.asked": "form.created",
};

// Capability probe: v2 TUI `Context` has all three of these; v1 `api` has
// none under these paths. Never version-sniff.
export function isV2Context(ctx) {
  return (
    !!ctx &&
    typeof ctx?.keymap?.layer === "function" &&
    typeof ctx?.ui?.toast?.show === "function" &&
    !!ctx?.storage
  );
}

// Normalize a v2 `SessionMessageInfo` union member to the v1 message shape
// our lib modules read (`{id, role, time, summary?}` + v1-like `parts`).
// v2 uses `type: "user" | "assistant" | …` (no `role` field); assistant text
// lives in `content[]` (`{type: "text", text}`), user text in `text`.
// Without this, every v1 `msg.role === "assistant"` filter is empty on v2 —
// the root cause of "no assistant response to speak" and the dead
// conversation reply stream. v1 hosts never pass through here.
function normalizeV2Message(msg) {
  if (!msg || typeof msg !== "object") return msg;
  const type = msg?.type;
  const role = type === "assistant" ? "assistant" : type === "user" ? "user" : type;
  let parts = [];
  try {
    if (Array.isArray(msg.content)) {
      parts = msg.content
        .map((c, i) =>
          c && typeof c.text === "string"
            ? { id: `${msg.id}:${i}`, type: c.type === "text" ? "text" : c.type, text: c.text }
            : null,
        )
        .filter(Boolean);
    } else if (typeof msg.text === "string" && msg.text) {
      parts = [{ id: `${msg.id}:0`, type: "text", text: msg.text }];
    }
  } catch {
    parts = [];
  }
  return { ...msg, role, parts };
}

// Wrap a v2 event envelope `{type, data}` so v1-style handlers reading
// `event.properties` keep working. v1 handlers also read renamed fields,
// normalized per remapped type below.
function wrapHandler(type, fn) {
  return (event) => {
    const data = event?.data ?? event?.properties ?? {};
    let properties = { ...data };
    if (type === "message.part.delta") {
      // v2 `session.text.delta` data: {sessionID, assistantMessageID,
      // ordinal, delta}. v1 handler expects {sessionID, messageID, partID?,
      // delta, field}. `ordinal` is the content-block index, so synthesize
      // the part id the normalized parts carry (`${messageID}:${ordinal}`)
      // for the part-type guard; a missed lookup stays fail-open downstream.
      const messageID = data.assistantMessageID ?? data.messageID;
      properties = {
        ...properties,
        messageID,
        partID:
          data.partID ??
          (messageID !== undefined && data.ordinal !== undefined
            ? `${messageID}:${data.ordinal}`
            : data.partID),
        field: "text",
      };
    }
    if (type === "question.asked") {
      // v2 `form.created` data: {form}. The form may not carry a sessionID;
      // an absent sessionID matches the current session in our handlers
      // (`forSession` treats missing as match), which is correct for the
      // common single-session case. Multi-session over-triggering is
      // possible and documented in the README caveat list.
      properties = { ...data, ...data?.form, sessionID: data?.sessionID ?? data?.form?.sessionID };
    }
    try {
      fn({ ...event, properties });
    } catch {
      // Handlers are already internally guarded; never let a mapping throw.
    }
  };
}

// Sync `kv` facade over v2 async `storage`. v2 `storage.store` is a
// solid-store pair; our lib modules need synchronous get/set, so the facade
// mirrors values in memory and persists fire-and-forget. Worst case (persist
// fails or storage shape differs) the in-memory values still work for the
// session — settings just don't survive restart.
function createKv(storage, warn) {
  const mem = new Map();
  let update = null;
  try {
    const pair = storage.store("opencode-voice", { initial: { values: {} } });
    const store = pair?.[0];
    update = typeof pair?.[1] === "function" ? pair[1] : null;
    for (const [k, v] of Object.entries(store?.values ?? {})) mem.set(k, v);
  } catch (err) {
    warn?.(`kv seed from v2 storage failed, using memory only: ${err?.message || err}`);
  }
  return {
    get(k, fb) {
      return mem.has(k) ? mem.get(k) : fb;
    },
    set(k, v) {
      mem.set(k, v);
      if (update) {
        const snapshot = Object.fromEntries(mem);
        void Promise.resolve()
          .then(() => update((draft) => void (draft.values = snapshot)))
          .catch(() => {});
      }
    },
  };
}

// `api.ui.dialog.replace(() => api.ui.DialogSelect(props))` over v2 promise
// `dialog.select`. Our 7 call sites all use option-level `onSelect` (no
// top-level `onSelect`), but both are honored. `dialog.clear()` inside an
// option handler is a no-op on v2 (promise dialogs close on resolve).
function createDialog(dialog, warn) {
  async function runSelect(props) {
    const options = (props?.options || []).map((o) => ({
      title: o?.title,
      value: o?.value,
      description: o?.description,
      footer: o?.footer,
      category: o?.category,
      disabled: o?.disabled,
    }));
    let chosen;
    try {
      chosen = await dialog.select({
        title: props?.title,
        placeholder: props?.placeholder,
        options,
        current: props?.current,
      });
    } catch (err) {
      warn?.(`dialog.select failed: ${err?.message || err}`);
      return;
    }
    if (chosen === undefined) return; // dismissed
    const match = (props?.options || []).find((o) => o?.value === chosen);
    try {
      if (match?.onSelect) await match.onSelect();
      else if (typeof props?.onSelect === "function") await props.onSelect(chosen);
    } catch (err) {
      warn?.(`dialog option handler failed: ${err?.message || err}`);
    }
  }
  return {
    replace(render) {
      let rendered;
      try {
        rendered = render();
      } catch (err) {
        warn?.(`dialog.replace render failed: ${err?.message || err}`);
        return;
      }
      const props = rendered?.__v2DialogSelect ? rendered.props : null;
      if (!props) {
        warn?.("dialog.replace called with non-DialogSelect content (no v2 path), ignored");
        return;
      }
      void runSelect(props);
    },
    clear() {},
  };
}

function DialogSelect(props) {
  return { __v2DialogSelect: true, props: props || {} };
}

export function adaptV2Context(ctx) {
  const disposers = [];
  const preview = createV2Preview(ctx);
  disposers.push(() => preview.clear());
  // v1 has no additive media surface: toasts stay the progress carrier
  // there. v2 gets the persistent now-playing line (same slot pattern as
  // the voice preview); tts.js drives it through api.ttsStatus and degrades
  // to toasts when the surface is absent.
  const ttsStatusReader = { current: () => null };
  const ttsStatusActions = {};
  const ttsStatus = createTtsStatus(ctx, () => ttsStatusReader.current(), ttsStatusActions);
  const setTtsStatusReader = (fn) => {
    ttsStatusReader.current = typeof fn === "function" ? fn : () => null;
  };
  const setTtsStatusActions = (next) => {
    for (const key of Object.keys(ttsStatusActions)) delete ttsStatusActions[key];
    if (next && typeof next === "object") Object.assign(ttsStatusActions, next);
  };
  disposers.push(() => ttsStatus.clear());

  // Conversation status: phase-aware slot line with phase-appropriate
  // clickable buttons. Driven by api.conversationPhase / api.setConversationPhase.
  const convStatusReader = { current: () => "idle" };
  const convStatusActions = {};
  const convStatus = createConversationStatus(ctx, () => convStatusReader.current(), convStatusActions);
  const setConvPhase = (phase) => {
    convStatusReader.current = typeof phase === "string" ? () => phase : convStatusReader.current;
  };
  const setConvActions = (next) => {
    for (const key of Object.keys(convStatusActions)) delete convStatusActions[key];
    if (next && typeof next === "object") Object.assign(convStatusActions, next);
  };
  disposers.push(() => convStatus.clear());
  const warned = new Set();
  const warnMessages = [];
  let disposed = false;
  let submission = null;
  let submissionText = null;
  // Loud degradation: warn logs are collected for evidence and also sent
  // through the real logger once boot creates it (wired via onWarn below).
  let warnSink = null;
  const warn = (message) => {
    if (warned.has(message)) return;
    warned.add(message);
    warnMessages.push(message);
    try {
      warnSink?.(`v2-compat: ${message}`);
    } catch {}
  };

  const toast = (input) => {
    try {
      const options = typeof input === "string" ? { message: input } : input || {};
      ctx.ui.toast.show({
        title: options.title,
        message: options.message ?? "",
        variant: options.variant,
        duration: options.duration,
        sessionID: options.sessionID,
      });
    } catch {}
  };

  function currentSessionID() {
    try {
      const route = ctx.ui.router.current();
      return route?.type === "session" ? route?.sessionID : undefined;
    } catch {
      return undefined;
    }
  }

  function submitTextAsPrompt(text, isCurrent = () => true) {
    const captured = String(text || "");
    if (submission) {
      return captured === submissionText
        ? submission
        : Promise.reject(new Error("Voice submission already in progress"));
    }
    const alive = () => !disposed && isCurrent();
    const check = () => {
      if (!alive()) throw new Error("Voice submission cancelled");
    };
    const task = (async () => {
      check();
      if (!captured.trim()) throw new Error("No transcript to submit");
      const selected = ctx.ui.model?.current();
      const model = selected
        ? {
            id: selected.modelID,
            providerID: selected.providerID,
            ...(selected.variant ? { variant: selected.variant } : {}),
          }
        : undefined;
      let sessionID = currentSessionID();
      try {
        if (!sessionID) {
          const created = await ctx.client.session.create({
            ...(ctx.location ? { location: ctx.location } : {}),
            ...(model ? { model } : {}),
          });
          check();
          sessionID = created.id;
          ctx.ui.router.navigate({ type: "session", sessionID });
        }
        check();
        // Model/agent belong to session metadata in v2, not prompt input.
        await ctx.client.session.prompt({ sessionID, text: captured });
        check();
      } catch (err) {
        if (alive()) {
          // A dialog retains the full transcript for recovery; a short toast
          // alone would lose long recordings on create/prompt failure.
          void ctx.ui.dialog.alert({
            title: "Voice transcript — not submitted",
            message: captured,
          });
        }
        throw err;
      }
    })();
    submission = task;
    submissionText = captured;
    void task
      .finally(() => {
        if (submission === task) submission = null;
      })
      .catch(() => {});
    return task;
  }

  // Reached only when no focused renderable accepts text. Never redirect the
  // transcript into a chat prompt the user did not ask for: keep it visible
  // in a recovery dialog and let the caller report `retained`.
  function retainTranscript(text) {
    const captured = String(text || "");
    try {
      void ctx.ui.dialog.alert({
        title: "Voice transcript — no text field focused",
        message: captured,
      });
    } catch {}
    return { data: null, retained: true };
  }

  // `Object.create` (not spread) so client methods keep their `this`.
  // v2 `session.message` is a `{get}` namespace, not the v1 callable, so
  // the v1 call shape `client.session.message({sessionID, messageID})` is
  // shimmed onto `message.get` with the result normalized (see above).
  const session = Object.create(ctx.client.session, {
    message: {
      value: async (input) => {
        const full = await ctx.client.session.message.get({
          sessionID: input?.sessionID,
          messageID: input?.messageID,
        });
        return { data: normalizeV2Message(full) };
      },
    },
  });
  const client = Object.create(ctx.client, {
    session: { value: session },
    // `client.app.log` has no v2 path — silent no-op (pre-existing `?.`
    // tolerance in createLogger already expects absence).
    app: { value: { log: async () => {} } },
    tui: {
      value: {
        // Marker for v1-shaped callers: this host has no composer-append API
        // and dispatches prompts through `session.prompt` below (an explicit
        // submit may resolve after the reply stream has started).
        v2: true,
        // Called only after `insertIntoFocusedInput` found no editable field.
        // Accepts both v1 call shapes ({body:{text}} and {text}) used by
        // stt.js. Explicit submits still go out via `session.prompt`; plain
        // appends are retained visibly instead of being sent.
        appendPrompt: async (input) => {
          const text = input?.body?.text ?? input?.text ?? "";
          if (input?.submit === true) {
            await submitTextAsPrompt(text, input?.isCurrent);
            return { data: null, submitted: true };
          }
          return retainTranscript(text);
        },
        submitPrompt: async () => {},
      },
    },
  });

  const dialog = createDialog(ctx.ui.dialog, warn);

  const api = {
    client,
    // The live CliRenderer: `currentFocusedRenderable` lets the shared
    // `insertIntoFocusedInput` helper type into the focused composer, dialog
    // search box, or plugin input. Streaming display is separate:
    // voicePreview uses additive slots without composer editing.
    renderer: ctx.renderer ?? null,
    voicePreview: preview,
    ttsStatus,
    setTtsStatusReader,
    setTtsStatusActions,
    conversationStatus: convStatus,
    setConvPhase,
    setConvActions,
    ui: { toast, dialog, DialogSelect },
    event: {
      on: (type, fn) => {
        const remapped = EVENT_REMAP[type];
        if (remapped) warn(`event "${type}" remapped to v2 "${remapped}"`);
        if (type === "question.asked") {
          warn(
            'event "question.asked" has no v2 equivalent; best-effort mapping to "form.created" ' +
              "(may over-trigger with multiple sessions)",
          );
        }
        try {
          return ctx.data.on(remapped || type, wrapHandler(type, fn));
        } catch (err) {
          warn(`event subscribe "${type}" failed: ${err?.message || err}`);
          return () => {};
        }
      },
    },
    lifecycle: {
      onDispose: (fn) => void disposers.push(fn),
    },
    kv: createKv(ctx.storage, warn),
    route: {
      get current() {
        const route = ctx.ui.router.current();
        if (route?.type === "session") {
          return { name: "session", params: { sessionID: route.sessionID } };
        }
        return { name: route?.type || "home", params: {} };
      },
    },
    state: {
      session: {
        messages: (sessionID) => {
          try {
            return (ctx.data.session.message.list(sessionID) || []).map(normalizeV2Message);
          } catch {
            return [];
          }
        },
      },
      // v1 `state.part(messageID)` over live v2 embedded content. Resolve
      // through the current session first, then known sessions (message ids
      // are unique). Never cache text: content changes while replies stream.
      part: (messageID) => {
        try {
          const sessionIDs = [];
          const current = currentSessionID();
          if (current) sessionIDs.push(current);
          for (const s of ctx.data.session.list() || []) {
            if (s?.id && !sessionIDs.includes(s.id)) sessionIDs.push(s.id);
          }
          for (const sid of sessionIDs) {
            let msg;
            try {
              msg = ctx.data.session.message.get(sid, messageID);
            } catch {
              msg = undefined;
            }
            if (msg) {
              return normalizeV2Message(msg)?.parts || [];
            }
          }
        } catch {
          // Fall through to [] below.
        }
        return [];
      },
      path: {
        // v2 `location` is a LocationRef, not a directory string.
        get directory() {
          try {
            return ctx.location?.directory || process.cwd();
          } catch {
            return process.cwd();
          }
        },
      },
    },
    command: {
      register: (getCommands) => {
        let commands = [];
        try {
          commands = getCommands() || [];
        } catch (err) {
          warn(`command registration failed: ${err?.message || err}`);
          return;
        }
        // v1 `{title, value, category, description, keybind?, slash?, onSelect}`
        // → v2 `KeymapCommand {id, title, group, bind, palette, slash, run}`
        // + layer `bindings`. Every command joins palette + slash so all
        // stay reachable; keybinds are translated below (invalid binds are
        // reported by the host parser, not here).
        // v1 bind strings use a `<leader>X` token for two-key sequences; the
        // v2 keymap resolves the `<leader>` token itself (leader defaults to
        // ctrl+x, configurable as `keybinds.leader`), so v1 binds pass
        // through UNTOUCHED — including v2-native "ctrl+r" style customs.
        // (An earlier revision translated to `ctrl+x X`; that form never
        // dispatches on the host and was the actual shortcut bug.)
        // "none"/falsy disables: reported as bind:false so no automatic
        // binding is configured, and the layer builder omits it.
        const toV2Bind = (bind) => {
          if (typeof bind !== "string" || bind.length === 0 || bind === "none") return false;
          return bind;
        };
        const mapped = commands.map((c) => ({
          id: c?.value,
          title: c?.title,
          description: c?.description,
          group: c?.category,
          bind: toV2Bind(c?.keybind),
          palette: true,
          slash: c?.slash ? { name: c.slash.name, aliases: c.slash.aliases } : undefined,
          run: (...args) => c?.onSelect?.(...args),
        }));
        const registerLayer = () => {
          try {
            ctx.keymap.layer(() => ({
              mode: "global",
              commands: mapped.map((c) => {
                const cmd = {
                  id: c.id,
                  title: c.title,
                  group: c.group,
                  palette: true,
                  slash: c.slash,
                  run: c.run,
                };
                if (c.description) cmd.description = c.description;
                if (typeof c.bind === "string" && c.bind.length > 0) cmd.bind = c.bind;
                return cmd;
              }),
              // Binds are displayed from command.bind but only become
              // ACTIVE when listed here — verified live: without this the
              // palette shows the shortcut yet the keystroke does nothing.
              // Only ids with a real bind string join (binding a bind-less
              // id is contradictory).
              bindings: mapped
                .filter((c) => typeof c.bind === "string" && c.bind.length > 0)
                .map((c) => c.id),
            }));
          } catch (err) {
            warn(`keymap.layer rejected commands: ${err?.message || err}`);
          }
        };
        // layer() must run inside a component: the host resolves the layer
        // against the ambient Keymap provider, and a direct call in setup()
        // never registers (the failure surfaces only as missing commands,
        // never as an error). So claim the always-mounted "app" slot with
        // a null-render component as the mount point and register once
        // from its render. Unclaiming on dispose removes the layer.
        if (typeof ctx.ui?.slot === "function") {
          let claimed = false;
          try {
            const unclaim = ctx.ui.slot({
              append: "app",
              render: () => {
                if (!claimed) {
                  claimed = true;
                  registerLayer();
                }
                return null;
              },
            });
            disposers.push(() => {
              try {
                unclaim();
              } catch {}
            });
            return;
          } catch (err) {
            warn(`slot claim for keymap failed, trying direct layer: ${err?.message || err}`);
          }
        }
        registerLayer();
      },
    },
  };

  // v1 reads `api.state.provider` as an array of `{models, env, options}`
  // (`voice-model.js` / `llm-client.js`). v2 splits those across collections:
  // providers carry NO models (they live in `location.model`), auth env names
  // live on the provider's integration method `{type:"env", names}`, and the
  // endpoint is `settings.baseURL` (`options` in v1). Recombining them here is
  // what keeps /voice-model from seeing every provider as model-less.
  Object.defineProperty(api.state, "provider", {
    get() {
      try {
        const providers = ctx.data.location.provider.list() || [];
        const models = ctx.data.location.model?.list?.() || [];
        const integrations = ctx.data.location.integration?.list?.() || [];
        const envByIntegration = new Map();
        for (const integration of integrations) {
          const names = (integration?.methods || [])
            .filter((method) => method?.type === "env")
            .flatMap((method) => method?.names || []);
          if (names.length > 0) envByIntegration.set(integration.id, names);
        }
        const modelsByProvider = new Map();
        for (const model of models) {
          const providerID = model?.providerID;
          if (!providerID) continue;
          const list = modelsByProvider.get(providerID);
          if (list) list.push(model);
          else modelsByProvider.set(providerID, [model]);
        }
        return providers.map((provider) => {
          const own = modelsByProvider.get(provider.id) || [];
          return {
            ...provider,
            models: Object.fromEntries(own.map((model) => [model.id, model])),
            env:
              envByIntegration.get(provider.integrationID ?? provider.id) ??
              (Array.isArray(provider.env) ? provider.env : []),
            options: provider.settings || {},
          };
        });
      } catch {
        return [];
      }
    },
    enumerable: true,
  });

  function cleanup() {
    disposed = true;
    for (const fn of disposers.splice(0)) {
      try {
        const r = fn();
        if (r?.then) void r.catch(() => {});
      } catch {}
    }
  }

  return {
    api,
    cleanup,
    warnMessages,
    onWarn: (sink) => void (warnSink = sink),
  };
}
