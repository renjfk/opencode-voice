import { describe, expect, test } from "bun:test";
import { createSettings, memoryKv, parseOptions } from "../config.ts";
import { fakeLlm, fakePlayer, fakeSynth, flush } from "../testing/fakes.ts";
import { SynthError, type SpeechSegment, type SynthName } from "../types.ts";
import { createTtsMachine, needsLlmSpeech } from "./session.ts";

function harness(
  o: {
    vieneu?: (seg: SpeechSegment) => Promise<Buffer>;
    reply?: string;
    llm?: ReturnType<typeof fakeLlm>;
    recording?: boolean;
    engine?: "vieneu" | "piper";
  } = {},
) {
  const kv = memoryKv();
  const settings = createSettings(kv, parseOptions({ ttsEngine: o.engine ?? "vieneu" }));
  const toasts: string[] = [];
  const idle: Array<(id: string) => void> = [];
  const player = fakePlayer();
  const vieneu = fakeSynth("vieneu", o.vieneu);
  const piper = fakeSynth("piper");
  let reply = o.reply ?? "Xin chào. Hello world.";
  const machine = createTtsMachine({
    host: {
      toast: (m) => void toasts.push(m),
      currentSessionID: () => "ses_1",
      anySessionID: () => "ses_1",
      lastAssistantText: () => reply,
      onSessionIdle: (h) => {
        idle.push(h);
        return () => {};
      },
      kv,
    },
    settings,
    logger: { log() {} },
    llm: o.llm ?? fakeLlm("", false),
    normalizePrompt: "N",
    prepareSpeech: (t) => t,
    // One segment per sentence, language by diacritics, for predictable tests.
    splitSegments: (t) =>
      t
        .split(/(?<=\.)\s+/)
        .filter(Boolean)
        .map((s) => ({ lang: /[à-ỹđ]/i.test(s) ? "vi" : "en", text: s }) as SpeechSegment),
    mergeForEngine: (segs) => segs,
    synth: (n: SynthName) => (n === "vieneu" ? vieneu : piper),
    player,
    clipDuration: () => 2,
    isRecording: () => o.recording === true,
  });
  return {
    machine,
    settings,
    toasts,
    player,
    vieneu,
    piper,
    kv,
    fireIdle: (id = "ses_1") => idle.forEach((h) => h(id)),
    setReply: (r: string) => void (reply = r),
  };
}

describe("tts machine", () => {
  test("reads parts in order and returns to idle", async () => {
    const h = harness();
    h.machine.toggle();
    expect(h.machine.view().phase.kind).toBe("preparing");
    await flush();
    expect(h.machine.view().phase.kind).toBe("playing");
    expect(h.player.plays.map(String)).toEqual(["vieneu:Xin chào."]);
    h.player.finish();
    await flush();
    expect(h.player.plays.map(String)).toEqual(["vieneu:Xin chào.", "vieneu:Hello world."]);
    h.player.finish();
    await flush();
    expect(h.machine.view().phase.kind).toBe("idle");
    expect(h.machine.view().canReplay).toBe(true);
  });

  test("prefetches the next part while the current one plays", async () => {
    const h = harness();
    h.machine.toggle();
    await flush();
    expect(h.vieneu.calls.length).toBe(2);
  });

  test("toggle while busy stops immediately", async () => {
    const h = harness();
    h.machine.toggle();
    await flush();
    h.machine.toggle();
    expect(h.machine.view().phase.kind).toBe("idle");
    await flush();
    expect(h.player.plays.length).toBe(1);
  });

  test("VieNeu failure falls back to Piper per language, one notice", async () => {
    const h = harness({
      vieneu: async () => {
        throw new SynthError("VieNeu unavailable (exited) — using Piper", "UNAVAILABLE");
      },
    });
    h.machine.toggle();
    await flush();
    expect(String(h.player.plays[0])).toBe("piper:Xin chào.");
    expect(h.toasts.filter((t) => t.includes("using Piper")).length).toBe(1);
    h.player.finish();
    await flush();
    expect(String(h.player.plays[1])).toBe("piper:Hello world.");
    expect(h.toasts.filter((t) => t.includes("using Piper")).length).toBe(1);
    expect(h.machine.view().engine).toBe("piper");
  });

  test("a new speech supersedes the old one; the stale part never plays", async () => {
    let release: (b: Buffer) => void = () => {};
    let first = true;
    const h = harness({
      vieneu: (seg) => {
        if (first) {
          first = false;
          return new Promise((r) => (release = r));
        }
        return Promise.resolve(Buffer.from(`v:${seg.text}`));
      },
    });
    h.machine.speakText("Old one.");
    await flush();
    h.machine.speakText("New one.");
    await flush();
    release(Buffer.from("stale"));
    await flush();
    expect(h.player.plays.map(String)).toEqual(["v:New one."]);
  });

  test("pause and resume", async () => {
    const h = harness();
    h.machine.toggle();
    await flush();
    expect(h.machine.pause()).toBe(true);
    expect(h.machine.view().phase.kind).toBe("paused");
    expect(h.machine.pause()).toBe(true);
    expect(h.machine.view().phase.kind).toBe("playing");
  });

  test("replay plays the last reading again", async () => {
    const h = harness({ reply: "One." });
    h.machine.toggle();
    await flush();
    h.player.finish();
    await flush();
    expect(h.machine.replay()).toBe(true);
    expect(h.player.plays.map(String)).toEqual(["vieneu:One.", "vieneu:One."]);
  });

  test("auto-read speaks each reply once, skips other sessions, waits while dictating", async () => {
    const h = harness({ reply: "Done." });
    h.fireIdle();
    expect(h.player.plays.length).toBe(0); // auto-read off
    h.settings.setTtsAuto(true);
    h.fireIdle("ses_other");
    await flush();
    expect(h.player.plays.length).toBe(0);
    h.fireIdle();
    await flush();
    expect(h.player.plays.length).toBe(1);
    h.player.finish();
    await flush();
    h.fireIdle(); // same reply again (e.g. another TUI or a duplicate event)
    await flush();
    expect(h.player.plays.length).toBe(1);

    const r = harness({ reply: "Busy.", recording: true });
    r.settings.setTtsAuto(true);
    r.fireIdle();
    await flush();
    expect(r.player.plays.length).toBe(0);
    expect(r.toasts.at(-1)).toContain("press Reply");
  });

  test("normalization uses the LLM and falls back locally on failure", async () => {
    const ok = harness({ reply: "**Hi** see `src/a.ts`.", llm: fakeLlm("Hi there.") });
    ok.machine.toggle();
    await flush();
    expect(String(ok.player.plays[0])).toBe("vieneu:Hi there.");

    const bad = harness({ reply: "Run `x`.", llm: fakeLlm(new Error("down")) });
    bad.machine.toggle();
    await flush();
    expect(String(bad.player.plays[0])).toBe("vieneu:Run `x`.");

    const plain = harness({ reply: "Xong rồi.", llm: fakeLlm("SHOULD NOT BE USED") });
    plain.machine.toggle();
    await flush();
    expect(String(plain.player.plays[0])).toBe("vieneu:Xong rồi.");
  });

  test("player failure ends in idle with an error toast", async () => {
    const h = harness({ reply: "One." });
    h.player.play = () => Promise.reject(new Error("sox not found"));
    h.machine.toggle();
    await flush();
    expect(h.machine.view().phase.kind).toBe("idle");
    expect(h.toasts.at(-1)).toContain("sox not found");
  });

  test("no reply: friendly message, stays idle", async () => {
    const h = harness({ reply: "" });
    h.machine.toggle();
    expect(h.machine.view().phase.kind).toBe("idle");
    expect(h.toasts.at(-1)).toContain("No assistant reply");
  });
});

test("needsLlmSpeech only flags code, markup, paths and links", () => {
  expect(needsLlmSpeech("Xong rồi, tôi đã sửa lỗi.")).toBe(false);
  expect(needsLlmSpeech("Done. All tests pass.")).toBe(false);
  expect(needsLlmSpeech("Edit `parseConfig` in src/helpers.ts")).toBe(true);
  expect(needsLlmSpeech("```ts\nx\n```")).toBe(true);
  expect(needsLlmSpeech("See https://example.com")).toBe(true);
  expect(needsLlmSpeech("| a | b |")).toBe(true);
});

test("stopping mid-reply keeps the heard parts replayable", async () => {
  const h = harness();
  h.machine.toggle();
  await flush();
  h.machine.stop();
  await flush();
  expect(h.machine.view().canReplay).toBe(true);
});

test("auto-read retries once when the reply text lands after the idle event", async () => {
  const h = harness({ reply: "" });
  h.settings.setTtsAuto(true);
  h.fireIdle();
  await flush();
  expect(h.player.plays.length).toBe(0);
  h.setReply("Late reply.");
  await new Promise((r) => setTimeout(r, 1600));
  await flush();
  expect(h.player.plays.length).toBe(1);
});

describe("speed and seeking", () => {
  test("saved speed is applied to the player at start and changes are saved", () => {
    const h = harness();
    expect(h.player.rate()).toBe(1);
    h.machine.setRate(1.5);
    expect(h.player.rateValue).toBe(1.5);
    expect(h.settings.ttsRate()).toBe(1.5);
    expect(h.machine.view().rate).toBe(1.5);
    expect(h.machine.cycleRate()).toBe(1.75);
    h.machine.setRate(2);
    expect(h.machine.cycleRate()).toBe(0.75); // wraps
    h.machine.setRate(9);
    expect(h.machine.view().rate).toBe(2); // clamped
  });

  test("seek within a part moves the player", async () => {
    const h = harness();
    expect(h.machine.seekBy(5)).toBe(false); // nothing playing
    h.machine.toggle();
    await flush();
    h.player.pos = 1;
    expect(h.machine.seekBy(0.5)).toBe(true);
    expect(h.player.seeks).toEqual([1.5]);
    h.machine.seekBy(-5);
    expect(h.player.seeks.at(-1)).toBe(0); // first part: clamp at 0
  });

  test("forward past the end of a part continues with the next part", async () => {
    const h = harness();
    h.machine.toggle();
    await flush();
    h.machine.seekBy(5);
    await flush();
    expect(h.player.plays.map(String)).toEqual(["vieneu:Xin chào.", "vieneu:Hello world."]);
  });

  test("rewind past the start of a part jumps back into the previous part", async () => {
    const h = harness();
    h.machine.toggle();
    await flush();
    h.player.finish(); // part 1 done
    await flush();
    expect(h.machine.view().phase).toMatchObject({ part: 2 });
    h.player.pos = 1; // 1s into part 2; parts are 2s long
    h.machine.seekBy(-1.5);
    await flush();
    // Back to part 1 at 2 - 0.5 = 1.5s.
    expect(h.player.plays.map(String)).toEqual([
      "vieneu:Xin chào.",
      "vieneu:Hello world.",
      "vieneu:Xin chào.",
    ]);
    expect(h.player.seeks.at(-1)).toBe(1.5);
    expect(h.machine.view().phase).toMatchObject({ kind: "playing", part: 1 });
    // And it keeps going in order afterwards.
    h.player.finish();
    await flush();
    expect(String(h.player.plays.at(-1))).toBe("vieneu:Hello world.");
  });

  test("rewinding while paused stays paused", async () => {
    const h = harness();
    h.machine.toggle();
    await flush();
    h.player.finish();
    await flush();
    h.machine.pause();
    h.player.pos = 0.2;
    h.machine.seekBy(-1);
    await flush();
    expect(h.machine.view().phase).toMatchObject({ kind: "paused", part: 1 });
    expect(h.player.status()).toBe("paused");
  });
});
