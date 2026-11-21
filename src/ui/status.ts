// One status line above the composer (and on the home footer). It is a pure
// function of the two state machines, re-rendered on every state change and
// on a short tick while something is running (timers, level meter).
import type { SttView } from "../stt/session.ts";
import type { TtsView } from "../tts/session.ts";

export type Action =
  | "stt.toggle"
  | "stt.finish"
  | "stt.correct"
  | "stt.pause"
  | "stt.cancel"
  | "stt.autoSubmit"
  | "stt.autoEnd"
  | "stt.mode"
  | "stt.engine"
  | "voice.device"
  | "tts.toggle"
  | "tts.pause"
  | "tts.stop"
  | "tts.replay"
  | "tts.auto"
  | "tts.back"
  | "tts.forward"
  | "tts.rate";

export type Tone = "text" | "muted" | "accent" | "danger" | "success" | "warning";

export interface Segment {
  readonly text: string;
  readonly tone: Tone;
  readonly action?: Action;
}

export interface StatusInput {
  readonly stt: SttView;
  readonly tts: TtsView;
  readonly autoSubmit: boolean;
  /** Finish dictation after 2.5 s of silence. */
  readonly autoEnd: boolean;
  readonly sttMode: "batch" | "streaming";
  /** Short transcription engine label, e.g. "turbo" or "API". */
  readonly sttEngine: string;
  /** Where audio goes when a voice node is used ("Phone"), else null. */
  readonly audioDevice?: { readonly label: string; readonly pinned: boolean } | null;
  readonly ttsAuto: boolean;
  readonly now: number;
}

export const RESULT_SHOW_MS = 4000;
const BARS = "▁▂▃▄▅▆▇█";

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}x`;
}

export function meter(level: number): string {
  // Speech RMS sits around 0.01-0.2; map log-ish onto 4 bars.
  const v = Math.max(0, Math.min(1, Math.sqrt(Math.max(0, level) * 5)));
  const idx = Math.round(v * (BARS.length - 1));
  const ch = BARS[idx] ?? BARS[0];
  const lo = BARS[Math.max(0, idx - 2)] ?? BARS[0];
  return `${lo}${ch}${BARS[Math.max(0, idx - 1)] ?? lo}`;
}

function tail(text: string, max = 48): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

const btn = (label: string, action: Action, tone: Tone = "accent"): Segment => ({
  text: `[${label}]`,
  tone,
  action,
});
const txt = (text: string, tone: Tone = "text"): Segment => ({ text, tone });

export function sttSegments(i: StatusInput): Segment[] {
  const { phase, last } = i.stt;
  const secs = (since: number): string => formatClock(i.now - since);
  switch (phase.kind) {
    case "idle": {
      const out: Segment[] = [];
      if (last && i.now - last.at < RESULT_SHOW_MS) {
        const tone: Tone =
          last.kind === "ok"
            ? "success"
            : last.kind === "error"
              ? "danger"
              : last.kind === "cancelled"
                ? "muted"
                : "warning";
        const mark = last.kind === "ok" ? "✓ " : last.kind === "error" ? "✕ " : "";
        out.push(txt(`${mark}${tail(last.message, 60)}`, tone));
      }
      out.push(btn("● Speak", "stt.toggle"));
      out.push(btn("✎ Fix", "stt.correct"));
      out.push(
        btn(
          i.autoEnd ? "⏹ Auto-stop ✓" : "⏹ Auto-stop ✗",
          "stt.autoEnd",
          i.autoEnd ? "success" : "muted",
        ),
      );
      out.push(
        btn(
          i.autoSubmit ? "⏎ Auto-send ✓" : "⏎ Auto-send ✗",
          "stt.autoSubmit",
          i.autoSubmit ? "success" : "muted",
        ),
      );
      out.push(btn(i.sttMode === "streaming" ? "Live" : "Batch", "stt.mode", "muted"));
      out.push(btn(i.sttEngine, "stt.engine", "muted"));
      if (i.audioDevice) {
        out.push(
          btn(
            `${i.audioDevice.pinned ? "📌" : "🎙"} ${i.audioDevice.label}`,
            "voice.device",
            "accent",
          ),
        );
      }
      return out;
    }
    case "starting":
      return [
        txt(`◌ Opening ${i.stt.micLabel} mic…`, "warning"),
        btn("✕ Cancel", "stt.cancel", "muted"),
      ];
    case "recording":
      return [
        txt(
          `● ${phase.purpose === "correct" ? "FIX" : "REC"} ${secs(phase.since)} ${meter(i.stt.level)}`,
          "danger",
        ),
        btn("■ Done", "stt.finish", "danger"),
        btn("✕ Cancel", "stt.cancel", "muted"),
      ];
    case "live": {
      const label = phase.purpose === "correct" ? "FIX" : "LIVE";
      const head = phase.paused
        ? txt(`⏸ PAUSED ${secs(phase.since)}`, "warning")
        : txt(`● ${label} ${secs(phase.since)} ${meter(i.stt.level)}`, "danger");
      const out = [
        head,
        btn(phase.paused ? "▶ Resume" : "⏸ Pause", "stt.pause", "accent"),
        btn("■ Done", "stt.finish", "danger"),
        btn("✕ Cancel", "stt.cancel", "muted"),
      ];
      if (i.stt.partial) out.push(txt(`“${tail(i.stt.partial)}”`, "muted"));
      return out;
    }
    case "transcribing":
      return [
        txt(`… Transcribing ${secs(phase.since)}`, "warning"),
        btn("✕ Cancel", "stt.cancel", "muted"),
      ];
    case "normalizing":
      return [
        txt(
          `… ${phase.purpose === "correct" ? "Merging fix" : "Polishing"} ${secs(phase.since)}`,
          "warning",
        ),
        btn("✕ Cancel", "stt.cancel", "muted"),
      ];
  }
}

export function ttsSegments(i: StatusInput): Segment[] {
  const { phase } = i.tts;
  switch (phase.kind) {
    case "idle": {
      const out: Segment[] = [btn("▶ Reply", "tts.toggle")];
      if (i.tts.canReplay) out.push(btn("↺", "tts.replay", "muted"));
      out.push(btn(formatRate(i.tts.rate), "tts.rate", i.tts.rate === 1 ? "muted" : "accent"));
      out.push(btn(i.ttsAuto ? "Read ✓" : "Read ✗", "tts.auto", i.ttsAuto ? "success" : "muted"));
      return out;
    }
    case "preparing":
      return [
        txt(
          `… ${phase.step === "normalizing" ? "Preparing reply" : "Synthesizing"} ${formatClock(i.now - phase.since)}`,
          "warning",
        ),
        btn("■ Stop", "tts.stop", "danger"),
      ];
    case "playing":
    case "paused": {
      const pos = `${formatClock(i.tts.positionSec * 1000)}/${formatClock(i.tts.durationSec * 1000)}`;
      const part = phase.parts > 1 ? ` ${phase.part}/${phase.parts}` : "";
      const eng = i.tts.engine === "piper" ? " piper" : "";
      return [
        txt(
          `${phase.kind === "paused" ? "⏸" : "♪"} ${pos}${part}${eng}`,
          phase.kind === "paused" ? "warning" : "accent",
        ),
        btn("«5", "tts.back"),
        btn(phase.kind === "paused" ? "▶" : "⏸", "tts.pause"),
        btn("5»", "tts.forward"),
        btn(formatRate(i.tts.rate), "tts.rate", i.tts.rate === 1 ? "muted" : "accent"),
        btn("■", "tts.stop", "danger"),
      ];
    }
  }
}

export function statusSegments(i: StatusInput): Segment[] {
  return [...sttSegments(i), txt("│", "muted"), ...ttsSegments(i)];
}

export function isAnimating(i: StatusInput): boolean {
  return (
    i.stt.phase.kind !== "idle" ||
    i.tts.phase.kind !== "idle" ||
    (i.stt.last !== null && i.now - i.stt.last.at < RESULT_SHOW_MS + 500)
  );
}

// ------------------------------------------------------------- renderer

export interface Palette {
  readonly [tone: string]: string;
}

export function paletteFrom(theme: unknown): Record<Tone, string> {
  const pick = (keys: string[], fallback: string): string => {
    if (!theme || typeof theme !== "object") return fallback;
    const t = theme as Record<string, unknown>;
    for (const k of keys) {
      const v = t[k];
      if (typeof v === "string" && v) return v;
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        for (const sub of ["base", "default", "fg"]) {
          if (typeof o[sub] === "string") return o[sub] as string;
        }
      }
    }
    return fallback;
  };
  return {
    text: pick(["text"], "#cdd6f4"),
    muted: pick(["textMuted", "muted"], "#7f849c"),
    accent: pick(["primary", "accent"], "#89b4fa"),
    danger: pick(["error"], "#f38ba8"),
    success: pick(["success"], "#a6e3a1"),
    warning: pick(["warning"], "#f9e2af"),
  };
}

interface SolidRuntime {
  createSignal<T>(v: T): [() => T, (v: T) => void];
}
interface OpentuiRuntime {
  createElement(tag: string): unknown;
  setProp(node: unknown, name: string, value: unknown): void;
  insert(parent: unknown, accessor: () => unknown): void;
}

export interface StatusMount {
  /** Re-render now (call on every state change). */
  refresh(): void;
  dispose(): void;
}

export async function mountStatus(input: {
  slot: (target: "session.composer.top" | "home.footer", render: () => unknown) => () => void;
  read: () => StatusInput;
  onAction: (a: Action) => void;
  theme: unknown;
  onError: (message: string) => void;
  load?: () => Promise<{ solid: SolidRuntime; tui: OpentuiRuntime }>;
}): Promise<StatusMount> {
  const load =
    input.load ??
    (async () => {
      // Host-provided modules: literal specifiers so the host loader maps them.
      const [solid, tui] = await Promise.all([import("solid-js"), import("@opentui/solid")]);
      return { solid: solid as unknown as SolidRuntime, tui: tui as unknown as OpentuiRuntime };
    });
  const { solid, tui } = await load();
  const [version, setVersion] = solid.createSignal(0);
  let v = 0;
  const palette = paletteFrom(input.theme);
  const lastPress = new Map<Action, number>();
  let errorShown = false;

  const press = (a: Action): void => {
    const t = Date.now();
    if (t - (lastPress.get(a) ?? 0) < 350) return; // mouse up can fire twice
    lastPress.set(a, t);
    input.onAction(a);
  };

  const render = (): unknown => {
    try {
      const box = tui.createElement("box");
      tui.setProp(box, "flexDirection", "row");
      tui.setProp(box, "height", 1);
      tui.setProp(box, "flexShrink", 0);
      tui.setProp(box, "width", "100%");
      tui.insert(box, () => {
        version();
        return statusSegments(input.read()).map((seg, idx) => {
          const node = tui.createElement("text");
          tui.setProp(node, "content", idx === 0 ? seg.text : ` ${seg.text}`);
          tui.setProp(node, "fg", palette[seg.tone]);
          tui.setProp(node, "flexShrink", 0);
          if (seg.action) {
            const action = seg.action;
            tui.setProp(node, "onMouseUp", () => press(action));
          }
          return node;
        });
      });
      return box;
    } catch (err) {
      if (!errorShown) {
        errorShown = true;
        input.onError(err instanceof Error ? err.message : String(err));
      }
      return null;
    }
  };

  const offs = [input.slot("session.composer.top", render), input.slot("home.footer", render)];
  let timer: ReturnType<typeof setInterval> | null = null;

  const refresh = (): void => {
    v += 1;
    setVersion(v);
    const animate = isAnimating(input.read());
    if (animate && !timer) {
      timer = setInterval(() => {
        v += 1;
        setVersion(v);
        if (!isAnimating(input.read()) && timer) {
          clearInterval(timer);
          timer = null;
          v += 1;
          setVersion(v);
        }
      }, 250);
      timer.unref?.();
    }
  };

  return {
    refresh,
    dispose() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const off of offs) {
        try {
          off();
        } catch {}
      }
    },
  };
}
