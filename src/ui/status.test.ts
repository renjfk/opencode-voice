import { describe, expect, test } from "bun:test";
import type { SttView } from "../stt/session.ts";
import type { TtsView } from "../tts/session.ts";
import {
  formatClock,
  isAnimating,
  meter,
  mountStatus,
  paletteFrom,
  statusSegments,
  type StatusInput,
} from "./status.ts";

const idleStt: SttView = {
  phase: { kind: "idle" },
  level: 0,
  partial: "",
  micLabel: "mac",
  last: null,
};
const idleTts: TtsView = {
  phase: { kind: "idle" },
  positionSec: 0,
  durationSec: 0,
  durationFinal: true,
  engine: null,
  canReplay: false,
  rate: 1,
};
const base: StatusInput = {
  stt: idleStt,
  tts: idleTts,
  autoSubmit: true,
  autoEnd: false,
  sttMode: "streaming",
  sttEngine: "turbo",
  ttsAuto: false,
  now: 10_000,
};
const texts = (i: StatusInput) =>
  statusSegments(i)
    .map((s) => s.text)
    .join(" ");

describe("status segments", () => {
  test("idle shows the main buttons", () => {
    expect(texts(base)).toBe(
      "[● Speak] [✎ Fix] [⏹ Auto-stop ✗] [⏎ Auto-send ✓] [Live] [turbo] │ [▶ Reply] [1x] [Read ✗]",
    );
  });

  test("auto-stop button reflects the setting and toggles it", () => {
    const seg = statusSegments({ ...base, autoEnd: true }).find((s) =>
      s.text.includes("Auto-stop"),
    );
    expect(seg?.text).toBe("[⏹ Auto-stop ✓]");
    expect(seg?.action).toBe("stt.autoEnd");
  });

  test("recording shows timer, meter, done and cancel", () => {
    const s = texts({
      ...base,
      stt: {
        ...idleStt,
        level: 0.05,
        phase: { kind: "recording", purpose: "dictate", since: 3_000 },
      },
    });
    expect(s).toContain("● REC 0:07");
    expect(s).toContain("[■ Done]");
    expect(s).toContain("[✕ Cancel]");
  });

  test("live paused shows resume", () => {
    const s = texts({
      ...base,
      stt: { ...idleStt, phase: { kind: "live", purpose: "dictate", since: 0, paused: true } },
    });
    expect(s).toContain("⏸ PAUSED");
    expect(s).toContain("[▶ Resume]");
  });

  test("live partial is shown when it cannot be typed into a field", () => {
    const s = texts({
      ...base,
      stt: {
        ...idleStt,
        partial: "xin chào",
        phase: { kind: "live", purpose: "dictate", since: 0, paused: false },
      },
    });
    expect(s).toContain("“xin chào”");
  });

  test("result is shown for a few seconds after finishing", () => {
    const withResult = {
      ...base,
      stt: { ...idleStt, last: { kind: "ok" as const, message: "Inserted 12 chars", at: 9_000 } },
    };
    expect(texts(withResult)).toContain("✓ Inserted 12 chars");
    expect(texts({ ...withResult, now: 20_000 })).not.toContain("Inserted");
    expect(isAnimating(withResult)).toBe(true);
    expect(isAnimating({ ...withResult, now: 20_000 })).toBe(false);
  });

  test("correction and processing labels", () => {
    expect(
      texts({
        ...base,
        stt: { ...idleStt, phase: { kind: "recording", purpose: "correct", since: 10_000 } },
      }),
    ).toContain("● FIX");
    expect(
      texts({
        ...base,
        stt: { ...idleStt, phase: { kind: "normalizing", purpose: "correct", since: 8_000 } },
      }),
    ).toContain("Merging fix 0:02");
    expect(
      texts({
        ...base,
        stt: { ...idleStt, phase: { kind: "transcribing", purpose: "dictate", since: 9_000 } },
      }),
    ).toContain("Transcribing 0:01");
  });

  test("tts playing shows whole-reply time (no part number) and controls", () => {
    const tts = {
      phase: { kind: "playing", part: 2, parts: 3 } as const,
      positionSec: 5,
      durationSec: 12,
      durationFinal: false,
      engine: null,
      canReplay: true,
      rate: 1,
    };
    // "+" while later parts are still being synthesized.
    expect(texts({ ...base, tts })).toContain("♪ 0:05/0:12+ [«5]");
    expect(texts({ ...base, tts: { ...tts, durationFinal: true } })).toContain("♪ 0:05/0:12 [«5]");
  });

  test("tts playing shows the piper engine and speed", () => {
    const s = texts({
      ...base,
      tts: {
        phase: { kind: "playing", part: 2, parts: 3 },
        positionSec: 5,
        durationSec: 12,
        durationFinal: true,
        engine: "piper",
        canReplay: true,
        rate: 1.25,
      },
    });
    expect(s).toContain("♪ 0:05/0:12 piper");
    expect(s).toContain("[«5] [⏸] [5»] [1.25x] [■]");
  });

  test("helpers", () => {
    expect(formatClock(65_000)).toBe("1:05");
    expect(meter(0)).toHaveLength(3);
    expect(paletteFrom({ error: "#ff0000", primary: { base: "#00f" } }).danger).toBe("#ff0000");
    expect(paletteFrom({ primary: { base: "#00f" } }).accent).toBe("#00f");
    expect(paletteFrom(null).text).toBe("#cdd6f4");
  });
});

test("mountStatus renders into both slots and re-renders on refresh", async () => {
  const created: Array<{ tag: string; props: Record<string, unknown>; children: unknown }> = [];
  let accessor: (() => unknown) | null = null;
  let setV: ((v: number) => void) | null = null;
  const renders: Array<() => unknown> = [];
  let current = base;
  const actions: string[] = [];
  const mount = await mountStatus({
    slot: (_t, render) => {
      renders.push(render);
      return () => {};
    },
    read: () => current,
    onAction: (a) => void actions.push(a),
    theme: null,
    onError: () => {},
    load: async () => ({
      solid: {
        createSignal<T>(v: T): [() => T, (v: T) => void] {
          let x = v;
          setV = (n) => void (x = n as unknown as T);
          return [() => x, (n: T) => void (x = n)];
        },
      },
      tui: {
        createElement(tag: string) {
          const n = { tag, props: {} as Record<string, unknown>, children: null as unknown };
          created.push(n);
          return n;
        },
        setProp(node: unknown, name: string, value: unknown) {
          (node as { props: Record<string, unknown> }).props[name] = value;
        },
        insert(_parent: unknown, fn: () => unknown) {
          accessor = fn;
        },
      },
    }),
  });
  expect(renders.length).toBe(2);
  renders[0]?.();
  const nodes = (accessor as unknown as () => Array<{ props: Record<string, unknown> }>)();
  expect(nodes[0]?.props.content).toBe("[● Speak]");
  const click = nodes[0]?.props.onMouseUp as () => void;
  click();
  click(); // double fire is debounced
  expect(actions).toEqual(["stt.toggle"]);
  current = {
    ...base,
    stt: {
      ...idleStt,
      phase: { kind: "starting", purpose: "dictate", mode: "batch", since: 10_000 },
    },
  };
  mount.refresh();
  const again = (accessor as unknown as () => Array<{ props: Record<string, unknown> }>)();
  expect(String(again[0]?.props.content)).toContain("Opening mac mic");
  expect(setV).not.toBeNull();
  mount.dispose();
});

test("engine button opens the engine picker", () => {
  const seg = statusSegments(base).find((x) => x.text === "[turbo]");
  expect(seg?.action).toBe("stt.engine");
});
