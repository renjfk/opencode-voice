import { describe, expect, test } from "bun:test";
import { createSettings, memoryKv, parseOptions } from "../config.ts";
import { pcmRms, wrapPcm } from "../audio/wav.ts";
import {
  fakeLlm,
  fakeMic,
  fakeTextarea,
  fakeTranscriber,
  flush,
  manualClock,
  pcm,
  type FakeMic,
} from "../testing/fakes.ts";
import type { MicError, StreamingPartial } from "../types.ts";
import { createSttMachine, type StreamingFactoryInput, type StreamingHandle } from "./session.ts";

interface FakeStream extends Omit<StreamingHandle, "paused"> {
  paused: boolean;
  input: StreamingFactoryInput;
  finishWith: string | Error;
  silence: number;
  cancelled: number;
  emit(p: StreamingPartial): void;
}

function harness(
  o: {
    mode?: "batch" | "streaming";
    autoSubmit?: boolean;
    autoEnd?: boolean;
    normalize?: "off" | "batch" | "all";
    llm?: ReturnType<typeof fakeLlm>;
    results?: Array<string | Error | Promise<string>>;
    field?: ReturnType<typeof fakeTextarea> | null;
    micFails?: MicError;
    options?: Record<string, unknown>;
  } = {},
) {
  const options = parseOptions({
    sttMode: o.mode ?? "batch",
    sttAutoSubmit: o.autoSubmit ?? false,
    ...o.options,
  });
  const settings = createSettings(memoryKv(), options);
  if (o.autoEnd) settings.setAutoEnd(true);
  settings.setNormalize(o.normalize ?? "batch");
  const clock = manualClock();
  const toasts: Array<{ m: string; v: string }> = [];
  const alerts: Array<{ t: string; m: string }> = [];
  const prompts: string[] = [];
  const field = o.field === undefined ? fakeTextarea("") : o.field;
  const mics: FakeMic[] = [];
  const streams: FakeStream[] = [];
  const t = fakeTranscriber(o.results ?? ["hello world"]);
  const llm = o.llm ?? fakeLlm("Hello world.");
  let recordingStarts = 0;
  const machine = createSttMachine({
    host: {
      focused: () => field,
      toast: (m, v = "info") => void toasts.push({ m, v }),
      promptSession: async (text) => void prompts.push(text),
      alert: (title, m) => void alerts.push({ t: title, m }),
      currentSessionID: () => "ses_1",
      anySessionID: () => "ses_1",
      sessionTitle: () => "Fix tests",
      recentTurns: () => "user: hi",
    },
    settings,
    options,
    logger: { log() {} },
    openMic: async () => {
      if (o.micFails) throw Object.assign(new Error(o.micFails.message), o.micFails);
      const m = fakeMic();
      mics.push(m);
      return m;
    },
    transcriber: () => t,
    transcribeFile: (tr, wav, opts) => tr.transcribe(wav, opts),
    createStreaming: (input) => {
      const s: FakeStream = {
        input,
        finishWith: "final text",
        silence: 0,
        cancelled: 0,
        paused: false,
        start() {},
        pause() {
          s.paused = true;
        },
        resume() {
          s.paused = false;
        },
        level: () => 0.1,
        silenceMs: () => s.silence,
        async finish() {
          if (s.finishWith instanceof Error) throw s.finishWith;
          return s.finishWith;
        },
        cancel() {
          s.cancelled += 1;
        },
        emit(p) {
          input.onPartial(p);
        },
      };
      streams.push(s);
      return s as StreamingHandle;
    },
    wrapPcm,
    pcmRms,
    cleanTranscript: (x) => x.trim(),
    isHallucination: (x) => x === "you",
    llm,
    prompts: {
      normalize: "NORM",
      correction: "FIX",
      buildSttUser: (raw) => `RAW:${raw}`,
      buildCorrectionUser: (cur, spoken) => `CUR:${cur}|SPOKEN:${spoken}`,
      needsContext: () => false,
      cleanOutput: (_raw, out) => out,
    },
    onRecordingStart: () => void (recordingStarts += 1),
    clock,
  });
  return {
    machine,
    settings,
    clock,
    toasts,
    alerts,
    prompts,
    field,
    mics,
    streams,
    t,
    llm,
    recordingStarts: () => recordingStarts,
  };
}

describe("batch dictation", () => {
  test("speak → done → transcribe → normalize → insert, then idle", async () => {
    const h = harness();
    h.machine.toggle();
    expect(h.machine.view().phase.kind).toBe("starting");
    await flush();
    expect(h.machine.view().phase.kind).toBe("recording");
    expect(h.recordingStarts()).toBe(1);
    h.mics[0]?.push(pcm(1000));
    h.machine.toggle();
    expect(h.machine.view().phase.kind).toBe("transcribing");
    await flush();
    expect(h.field?.plainText).toBe("Hello world.");
    expect(h.machine.view().phase.kind).toBe("idle");
    expect(h.machine.view().last?.kind).toBe("ok");
    expect(h.llm.requests[0]?.user).toBe("RAW:hello world");
  });

  test("auto-submit submits the focused field", async () => {
    const h = harness({ autoSubmit: true });
    h.machine.toggle();
    await flush();
    h.mics[0]?.push(pcm(1000));
    h.machine.toggle();
    await flush();
    expect(h.field?.submits).toBe(1);
    expect(h.machine.view().last?.message).toBe("Sent");
  });

  test("silence is reported as no speech, never transcribed", async () => {
    const h = harness();
    h.machine.toggle();
    await flush();
    h.mics[0]?.push(pcm(2000, 0));
    h.machine.toggle();
    await flush();
    expect(h.t.calls).toBe(0);
    expect(h.machine.view().last?.message).toBe("No speech detected");
    expect(h.machine.view().phase.kind).toBe("idle");
  });

  test("auto-end finishes after 2.5s of silence following speech", async () => {
    const h = harness({ autoEnd: true });
    h.machine.toggle();
    await flush();
    h.mics[0]?.push(pcm(800));
    h.mics[0]?.push(pcm(200, 0));
    h.clock.advance(2400);
    expect(h.machine.view().phase.kind).toBe("recording");
    h.clock.advance(400);
    expect(h.machine.view().phase.kind).toBe("transcribing");
    await flush();
    expect(h.field?.plainText).toBe("Hello world.");
  });

  test("normalize failure inserts the raw text with a warning", async () => {
    const h = harness({ llm: fakeLlm(new Error("HTTP 500")) });
    h.machine.toggle();
    await flush();
    h.mics[0]?.push(pcm(1000));
    h.machine.toggle();
    await flush();
    expect(h.field?.plainText).toBe("hello world");
    expect(h.machine.view().last?.kind).toBe("warning");
  });

  test("normalize off skips the LLM", async () => {
    const h = harness({ normalize: "off" });
    h.machine.toggle();
    await flush();
    h.mics[0]?.push(pcm(1000));
    h.machine.toggle();
    await flush();
    expect(h.llm.requests.length).toBe(0);
    expect(h.field?.plainText).toBe("hello world");
  });

  test("hallucination is dropped", async () => {
    const h = harness({ results: ["you"] });
    h.machine.toggle();
    await flush();
    h.mics[0]?.push(pcm(1000));
    h.machine.toggle();
    await flush();
    expect(h.field?.plainText).toBe("");
    expect(h.machine.view().last?.message).toBe("No speech detected");
  });

  test("cancel during transcription drops the late result and frees the machine", async () => {
    let release: (v: string) => void = () => {};
    const h = harness({ results: [new Promise<string>((r) => (release = r))] });
    h.machine.toggle();
    await flush();
    h.mics[0]?.push(pcm(1000));
    h.machine.toggle();
    await flush();
    expect(h.machine.cancel()).toBe(true);
    expect(h.machine.view().phase.kind).toBe("idle");
    // A new recording can start immediately.
    h.machine.toggle();
    await flush();
    expect(h.machine.view().phase.kind).toBe("recording");
    release("stale words");
    await flush();
    expect(h.field?.plainText).toBe("");
    expect(h.machine.view().phase.kind).toBe("recording");
  });

  test("mic open failure shows message + hint and returns to idle", async () => {
    const h = harness({
      micFails: { code: "CONNECTION", message: "Phone not reachable", hint: "run adb forward" },
    });
    h.machine.toggle();
    await flush();
    expect(h.machine.view().phase.kind).toBe("idle");
    expect(h.toasts.at(-1)?.m).toBe("Phone not reachable — run adb forward");
    expect(h.toasts.at(-1)?.v).toBe("error");
  });

  test("mic dying mid-recording still transcribes what was captured", async () => {
    const h = harness();
    h.machine.toggle();
    await flush();
    h.mics[0]?.push(pcm(1500));
    h.mics[0]?.fail({ code: "EXITED", message: "Capture exited" });
    await flush();
    expect(h.field?.plainText).toBe("Hello world.");
  });

  test("no focused field: auto-submit sends to the session, otherwise a dialog keeps the text", async () => {
    const a = harness({ field: null, autoSubmit: true });
    a.machine.toggle();
    await flush();
    a.mics[0]?.push(pcm(1000));
    a.machine.toggle();
    await flush();
    expect(a.prompts).toEqual(["Hello world."]);

    const b = harness({ field: null });
    b.machine.toggle();
    await flush();
    b.mics[0]?.push(pcm(1000));
    b.machine.toggle();
    await flush();
    expect(b.alerts[0]?.m).toBe("Hello world.");
  });

  test("pressing speak while processing does not start a second recording", async () => {
    let release: (v: string) => void = () => {};
    const h = harness({ results: [new Promise<string>((r) => (release = r))] });
    h.machine.toggle();
    await flush();
    h.mics[0]?.push(pcm(1000));
    h.machine.toggle();
    h.machine.toggle();
    await flush();
    expect(h.mics.length).toBe(1);
    release("x");
    await flush();
  });
});

describe("streaming dictation", () => {
  test("partials are written live and replaced by the final text", async () => {
    const h = harness({ mode: "streaming", field: fakeTextarea("note:") });
    h.machine.toggle();
    await flush();
    expect(h.machine.view().phase.kind).toBe("live");
    h.streams[0]?.emit({ stable: "xin", tentative: "chào" });
    expect(h.field?.plainText).toBe("note: xin chào");
    h.machine.toggle();
    await flush();
    expect(h.field?.plainText).toBe("note: final text");
    expect(h.machine.view().phase.kind).toBe("idle");
    expect(h.llm.requests.length).toBe(0); // normalize "batch" skips live
  });

  test("normalize all cleans live dictation too", async () => {
    const h = harness({ mode: "streaming", normalize: "all", llm: fakeLlm("Final text.") });
    h.machine.toggle();
    await flush();
    h.machine.toggle();
    await flush();
    expect(h.field?.plainText).toBe("Final text.");
  });

  test("pause toggles and the second speak press on a paused session resumes", async () => {
    const h = harness({ mode: "streaming" });
    h.machine.toggle();
    await flush();
    expect(h.machine.pause()).toBe(true);
    const p = h.machine.view().phase;
    expect(p.kind === "live" && p.paused).toBe(true);
    h.machine.toggle();
    const q = h.machine.view().phase;
    expect(q.kind === "live" && q.paused).toBe(false);
  });

  test("auto-end never fires while paused", async () => {
    const h = harness({ mode: "streaming", autoEnd: true });
    h.machine.toggle();
    await flush();
    h.streams[0]?.emit({ stable: "hello", tentative: "" });
    h.machine.pause();
    if (h.streams[0]) h.streams[0].silence = 10_000;
    h.clock.advance(5000);
    expect(h.machine.view().phase.kind).toBe("live");
    h.machine.pause(); // resume
    h.clock.advance(300);
    expect(h.machine.view().phase.kind).toBe("transcribing");
  });

  test("cancel removes the live text and cancels the session", async () => {
    const h = harness({ mode: "streaming", field: fakeTextarea("keep") });
    h.machine.toggle();
    await flush();
    h.streams[0]?.emit({ stable: "some words", tentative: "" });
    h.machine.cancel();
    expect(h.field?.plainText).toBe("keep");
    expect(h.streams[0]?.cancelled).toBe(1);
  });

  test("a streaming error finishes with the audio captured so far", async () => {
    const h = harness({ mode: "streaming" });
    h.machine.toggle();
    await flush();
    h.streams[0]?.input.onError(new Error("Phone not reachable"));
    await flush();
    expect(h.field?.plainText).toBe("final text");
    expect(h.toasts.some((x) => x.v === "warning" && x.m.includes("Phone not reachable"))).toBe(
      true,
    );
  });

  test("user edit during dictation keeps both texts, no duplicate insert", async () => {
    const field = fakeTextarea("");
    const h = harness({ mode: "streaming", field });
    h.machine.toggle();
    await flush();
    h.streams[0]?.emit({ stable: "hello", tentative: "" });
    field.insertText(" mine");
    h.streams[0]?.emit({ stable: "hello there", tentative: "" });
    h.machine.toggle();
    await flush();
    expect(field.plainText).toBe("hello mine");
  });
});

describe("correction (Fix)", () => {
  test("merges the spoken correction into the current text with the LLM", async () => {
    const field = fakeTextarea("please fit the test");
    const h = harness({ field, results: ["fix not fit"], llm: fakeLlm("please fix the test") });
    h.machine.correct();
    await flush();
    h.mics[0]?.push(pcm(1000));
    h.machine.correct();
    await flush();
    expect(h.llm.requests[0]?.user).toBe("CUR:please fit the test|SPOKEN:fix not fit");
    expect(field.plainText).toBe("please fix the test");
    expect(field.submits).toBe(0); // corrections never submit
  });

  test("LLM failure leaves the text unchanged", async () => {
    const field = fakeTextarea("please fit the test");
    const h = harness({ field, results: ["fix"], llm: fakeLlm(new Error("timeout")) });
    h.machine.correct();
    await flush();
    h.mics[0]?.push(pcm(1000));
    h.machine.correct();
    await flush();
    expect(field.plainText).toBe("please fit the test");
    expect(h.machine.view().last?.kind).toBe("error");
  });

  test("empty field: the correction is just inserted", async () => {
    const field = fakeTextarea("");
    const h = harness({ field, results: ["new text"] });
    h.machine.correct();
    await flush();
    h.mics[0]?.push(pcm(1000));
    h.machine.correct();
    await flush();
    expect(field.plainText).toBe("new text");
  });

  test("Fix while dictating is refused with a hint (no stuck state)", async () => {
    const h = harness();
    h.machine.toggle();
    await flush();
    h.machine.correct();
    expect(h.toasts.at(-1)?.m).toContain("Finish the current recording");
    h.machine.cancel();
    h.machine.correct();
    await flush();
    expect(h.machine.view().phase.kind).toBe("recording");
  });
});

test("phone mic without sttCaptureCmd fails fast with a hint", async () => {
  const h = harness();
  h.settings.setMic("remote");
  h.machine.toggle();
  await flush();
  expect(h.machine.view().phase.kind).toBe("idle");
  expect(h.toasts.at(-1)?.m).toContain("sttCaptureCmd");
});

test("Done on a paused live session finishes instead of resuming", async () => {
  const h = harness({ mode: "streaming" });
  h.machine.toggle();
  await flush();
  h.machine.pause();
  h.machine.finish();
  expect(h.machine.view().phase.kind).toBe("transcribing");
  await flush();
  expect(h.field?.plainText).toBe("final text");
});

test("auto-submit without a focused field frees the machine before the prompt resolves", async () => {
  const h = harness({ field: null, autoSubmit: true });
  h.machine.toggle();
  await flush();
  h.mics[0]?.push(pcm(1000));
  h.machine.toggle();
  await flush();
  expect(h.machine.view().phase.kind).toBe("idle");
  expect(h.prompts).toEqual(["Hello world."]);
});

test("composer destroyed mid-dictation: transcript is not lost", async () => {
  const field = fakeTextarea("");
  const h = harness({ mode: "streaming", field });
  h.machine.toggle();
  await flush();
  h.streams[0]?.emit({ stable: "hello", tentative: "" });
  (field as unknown as { isDestroyed: boolean }).isDestroyed = true;
  h.machine.toggle();
  await flush();
  // host.focused() still returns the (destroyed) fake; real host filters it.
  expect(h.machine.view().last?.message).not.toBe("Kept live text");
});

test("whisper never receives the LLM system prompt override", async () => {
  const h = harness({ options: { sttPrompt: "LONG SYSTEM PROMPT" } });
  let seenPrompt: string | undefined = "unset";
  const orig = h.t.transcribe.bind(h.t);
  h.t.transcribe = (wav, opts) => {
    seenPrompt = opts.prompt;
    return orig(wav, opts);
  };
  h.machine.toggle();
  await flush();
  h.mics[0]?.push(pcm(1000));
  h.machine.toggle();
  await flush();
  expect(seenPrompt).toBeUndefined();
});

test("auto-end works on a noisy mic: silence is judged against the mic's noise floor", async () => {
  const h = harness({ autoEnd: true });
  h.machine.toggle();
  await flush();
  const m = h.mics[0];
  // Phone-like mic: background noise ~0.02 (above the laptop speech threshold).
  for (let i = 0; i < 10; i++) m?.push(pcm(100, 650));
  m?.push(pcm(800, 6000)); // speech
  for (let i = 0; i < 4; i++) m?.push(pcm(100, 650)); // back to background noise
  h.clock.advance(2400);
  expect(h.machine.view().phase.kind).toBe("recording");
  h.clock.advance(400);
  expect(h.machine.view().phase.kind).toBe("transcribing");
});

test("noise alone never counts as speech, so it never auto-submits", async () => {
  const h = harness({ autoEnd: true });
  h.machine.toggle();
  await flush();
  for (let i = 0; i < 30; i++) h.mics[0]?.push(pcm(100, 650));
  h.clock.advance(6000);
  expect(h.machine.view().phase.kind).toBe("recording");
});
