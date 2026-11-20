import { expect, test } from "bun:test";
import { createSettings, memoryKv, parseOptions } from "./config.ts";

test("parseOptions keeps the JS plugin's option names and defaults", () => {
  const o = parseOptions({
    sttMode: "streaming",
    sttAutoSubmit: true,
    ttsEngine: "kokoro",
    sttCaptureCmd: ["ssh", "-p", "8022", "u@localhost", "capture.sh", "16000"],
    audioSampleRate: 16000,
    keybinds: { "stt.record": "ctrl+r", bad: 1 },
  });
  expect(o.sttMode).toBe("streaming");
  expect(o.sttAutoSubmit).toBe(true);
  expect(o.ttsEngine).toBe("vieneu"); // dropped engines map to VieNeu
  expect(o.sttCaptureCmd?.[0]).toBe("ssh");
  expect(o.keybinds).toEqual({ "stt.record": "ctrl+r" });
  expect(parseOptions(undefined).audioSampleRate).toBe(16000);
  expect(parseOptions({ audioSampleRate: 5 }).audioSampleRate).toBe(16000);
});

test("settings read old kv values and fall back to options", () => {
  const kv = memoryKv({
    "stt.mode": "batch",
    "tts.mode": "on",
    "tts.engine": "chatterbox",
    "stt.mic": "remote",
  });
  const s = createSettings(kv, parseOptions({ sttMode: "streaming", ttsPlayCmd: ["ssh"] }));
  expect(s.sttMode()).toBe("batch");
  expect(s.ttsAuto()).toBe(true);
  expect(s.ttsEngine()).toBe("vieneu");
  expect(s.mic()).toBe("remote");
  expect(s.ttsOutput()).toBe("local");
  s.setTtsOutput("remote");
  expect(s.ttsOutput()).toBe("remote");
  s.setVoiceModel({ providerID: "openai", modelID: "gpt" });
  expect(s.voiceModel()).toEqual({ providerID: "openai", modelID: "gpt" });
  s.setVoiceModel(null);
  expect(s.voiceModel()).toBeNull();
});

test("phone speaker setting is ignored without ttsPlayCmd", () => {
  const s = createSettings(memoryKv({ "tts.output": "remote" }), parseOptions({}));
  expect(s.ttsOutput()).toBe("local");
});
