import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  __clearProcessingToastState,
  __clearRecordingToastState,
  __clearStreamingToastState,
  __resetStreamWave,
  __setProcessingToastFn,
  __setRecordingToastFn,
  __setStreamingToastFn,
  __setToastPolling,
  NOTES_SYSTEM_PROMPT,
  STT_SYSTEM_PROMPT,
  STT_SYSTEM_PROMPT_STRICT,
  buildAudioHint,
  buildOpenRouterTranscriptionRequest,
  buildRecordArgs,
  buildWhisperArgs,
  clearProcessingToast,
  getSttApiConfig,
  insertIntoFocusedInput,
  isLikelyWhisperHallucination,
  isOpenRouterEndpoint,
  isProcessingToastActive,
  isRecordingToastActive,
  isStreamingToastActive,
  isSttBusy,
  isWSL,
  needsContext,
  parsePactlSources,
  parsePactlSourcesShort,
  selectSttSystemPrompt,
  showProcessingToast,
  showRecordingToast,
  showStreamingToast,
  transcribeApiFile,
  transcribeFileLocal,
  updateProcessingToast,
  updateStreamingToast,
  waveLevelsFromPcm,
} from "../lib/stt.js";

test("interpretive prompt reinterprets mishearings, strict does not", () => {
  assert.match(STT_SYSTEM_PROMPT, /INTERPRET misheard words/);
  assert.match(STT_SYSTEM_PROMPT, /they face/);
  assert.match(STT_SYSTEM_PROMPT, /WORKFLOW VOCABULARY/);
  assert.doesNotMatch(STT_SYSTEM_PROMPT_STRICT, /INTERPRET misheard words/);
  assert.match(STT_SYSTEM_PROMPT_STRICT, /exactly what they said/);
});

test("selects normalize prompt by mode, custom file wins", () => {
  assert.equal(selectSttSystemPrompt("strict", null), STT_SYSTEM_PROMPT_STRICT);
  assert.equal(selectSttSystemPrompt("interpretive", null), STT_SYSTEM_PROMPT);
  assert.equal(selectSttSystemPrompt(undefined, null), STT_SYSTEM_PROMPT);
  assert.equal(selectSttSystemPrompt("strict", "custom"), "custom");
});

test("detects transcripts that need conversation context", () => {
  assert.equal(needsContext("ask him about it"), true);
  assert.equal(needsContext("Cristina đi đâu?"), true);
  assert.equal(needsContext("fix this file"), true);
  assert.equal(needsContext("run the tests"), false);
  assert.equal(needsContext("mở file log"), false);
  assert.equal(needsContext(""), false);
  assert.equal(needsContext(null), false);
});

test("inserts transcription into the focused OpenTUI input", () => {
  const calls = [];
  const input = {
    insertText(text) {
      calls.push(["insert", text]);
    },
    submit() {
      calls.push(["submit"]);
    },
  };

  assert.equal(insertIntoFocusedInput({ currentFocusedRenderable: input }, "hello", true), true);
  assert.deepEqual(calls, [["insert", "hello"], ["submit"]]);
});

test("does not claim non-editable focused renderables", () => {
  assert.equal(
    insertIntoFocusedInput({ currentFocusedRenderable: { focus() {} } }, "hello"),
    false,
  );
  assert.equal(insertIntoFocusedInput({ currentFocusedRenderable: null }, "hello"), false);
});

test("processing toast stays active until cleared", () => {
  const seen = [];
  __setProcessingToastFn((input) => seen.push(input));
  try {
    showProcessingToast("Transcribing...");
    assert.equal(isProcessingToastActive(), true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].message, "Transcribing...");

    updateProcessingToast("Normalizing...");
    assert.equal(isProcessingToastActive(), true);
    assert.equal(seen.at(-1).message, "Normalizing...");

    clearProcessingToast();
    assert.equal(isProcessingToastActive(), false);
  } finally {
    __clearProcessingToastState();
  }
});

test("v2 one-shot toast mode never starts polling timers", () => {
  const seen = [];
  __setRecordingToastFn((input) => seen.push(input));
  __setStreamingToastFn((input) => seen.push(input));
  __setToastPolling(false);
  try {
    showRecordingToast();
    assert.equal(seen.length, 1);
    assert.equal(isRecordingToastActive(), false);
    assert.match(seen[0].message, /● Recording · .* to stop$/);

    showStreamingToast("Loading speech model…");
    assert.equal(seen.length, 2);
    assert.equal(isStreamingToastActive(), false);
    updateStreamingToast("Listening");
    assert.equal(seen.length, 3);
  } finally {
    __setToastPolling(true);
    __clearRecordingToastState();
    __clearStreamingToastState();
  }
});

test("detects OpenRouter STT endpoints", () => {
  assert.equal(isOpenRouterEndpoint("https://openrouter.ai/api/v1"), true);
  assert.equal(isOpenRouterEndpoint("https://openrouter.ai/api/v1/"), true);
  assert.equal(isOpenRouterEndpoint("https://api.openai.com/v1"), false);
});

test("builds OpenRouter STT requests as JSON with base64 audio", () => {
  const audioBuffer = Buffer.from("RIFFfakewav", "utf8");
  const request = buildOpenRouterTranscriptionRequest(
    "openai/whisper-large-v3-turbo",
    audioBuffer,
    "secret",
  );

  assert.deepEqual(request.headers, {
    "Content-Type": "application/json",
    Authorization: "Bearer secret",
  });

  const body = JSON.parse(request.body);
  assert.deepEqual(body, {
    model: "openai/whisper-large-v3-turbo",
    input_audio: {
      data: audioBuffer.toString("base64"),
      format: "wav",
    },
  });
});

test("parses pactl JSON sources and filters out monitors", () => {
  const json = JSON.stringify([
    { name: "RDPSink.monitor", description: "Monitor of RDP Sink" },
    { name: "RDPSource", description: "RDP Source" },
    { name: "alsa_input.usb-mic" },
  ]);
  assert.deepEqual(parsePactlSources(json), [
    { name: "RDPSource", label: "RDP Source (RDPSource)" },
    { name: "alsa_input.usb-mic", label: "alsa_input.usb-mic" },
  ]);
});

test("parses pactl short sources and filters out monitors", () => {
  const short = [
    "1\tRDPSink.monitor\tmodule-rdp-sink.c\ts16le 2ch 44100Hz\tSUSPENDED",
    "2\tRDPSource\tmodule-rdp-source.c\ts16le 1ch 44100Hz\tSUSPENDED",
    "",
  ].join("\n");
  assert.deepEqual(parsePactlSourcesShort(short), [{ name: "RDPSource", label: "RDPSource" }]);
});

test("builds sox record args per audio backend", () => {
  assert.deepEqual(buildRecordArgs("pulseaudio", "RDPSource"), ["-t", "pulseaudio", "RDPSource"]);
  assert.deepEqual(buildRecordArgs("pulseaudio", null), ["-t", "pulseaudio", "default"]);
  assert.deepEqual(buildRecordArgs("coreaudio", "USB Microphone"), [
    "-t",
    "coreaudio",
    "USB Microphone",
  ]);
  assert.deepEqual(buildRecordArgs("coreaudio", null), ["-d"]);
  assert.deepEqual(buildRecordArgs("default", null), ["-d"]);
});

test("builds audio hints per backend and server state", () => {
  assert.match(
    buildAudioHint({ backend: "pulseaudio", serverOk: false, isWsl: true }),
    /wsl --shutdown/,
  );
  assert.match(
    buildAudioHint({ backend: "pulseaudio", serverOk: false, isWsl: false }),
    /PipeWire\/PulseAudio/,
  );
  assert.match(
    buildAudioHint({ backend: "pulseaudio", serverOk: true, isWsl: false }),
    /input source configuration/,
  );
  assert.equal(
    buildAudioHint({ backend: "coreaudio", serverOk: false, isWsl: false }),
    "No input devices found",
  );
});

test("detects WSL via environment variables", () => {
  const savedDistro = process.env.WSL_DISTRO_NAME;
  const savedInterop = process.env.WSL_INTEROP;
  try {
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    assert.equal(isWSL(), false);
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    assert.equal(isWSL(), true);
  } finally {
    if (savedDistro === undefined) delete process.env.WSL_DISTRO_NAME;
    else process.env.WSL_DISTRO_NAME = savedDistro;
    if (savedInterop === undefined) delete process.env.WSL_INTEROP;
    else process.env.WSL_INTEROP = savedInterop;
  }
});

test("live notes prompt stays close to input and never summarizes", () => {
  assert.match(NOTES_SYSTEM_PROMPT, /not a summary/);
  assert.match(NOTES_SYSTEM_PROMPT, /within ~20%/);
  assert.doesNotMatch(NOTES_SYSTEM_PROMPT, /message to submit/);
});

test("detects likely whisper silence hallucinations", () => {
  assert.equal(isLikelyWhisperHallucination("Thank you for watching!"), true);
  assert.equal(isLikelyWhisperHallucination("[Music]"), true);
  assert.equal(isLikelyWhisperHallucination("Please subscribe"), true);
  assert.equal(isLikelyWhisperHallucination("Let's talk about the database schema."), false);
  assert.equal(isLikelyWhisperHallucination(""), false);
  assert.equal(isLikelyWhisperHallucination(null), false);
});

test("detects Vietnamese YouTube-outro hallucinations, even long ones", () => {
  // Verbatim from a real classroom session: whisper "heard" this outro 7x
  // on quiet far-field audio. At ~69 chars it used to slip past the old
  // 60-char cap - it must be caught now.
  assert.equal(
    isLikelyWhisperHallucination(
      "Hãy subscribe cho kênh Ghiền Mì Gõ Để không bỏ lỡ những video hấp dẫn",
    ),
    true,
  );
  assert.equal(
    isLikelyWhisperHallucination("Các bạn hãy đăng ký kênh để ủng hộ kênh của mình nhé."),
    true,
  );
  // But real lecture content stays: bare thanks could be the professor, and
  // long genuine segments are never hallucinations.
  assert.equal(isLikelyWhisperHallucination("Thank you."), false);
  assert.equal(
    isLikelyWhisperHallucination(
      "Nội dung lớn nhất là nó liên quan đến những là Smart Kids, là các đồ vật thông minh. Nhưng mà nãy ta nói để làm cho một đồ vật trở nên thông minh thì chúng ta phải làm gì? Một đồ vật thông thường, ta phải khen vị cho ta phải làm gì? Và sau đó chúng ta còn phải thảo luận thêm rất nhiều nội dung khác nữa trong buổi học hôm nay.",
    ),
    false,
  );
});

test("reports idle STT/API state before any recording starts", () => {
  assert.equal(isSttBusy(), false);
  assert.equal(getSttApiConfig(), null);
});

test("transcribeFileLocal reports missing model, missing file, and empty file", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-stt-test-"));
  try {
    const missingModel = path.join(tmpDir, "missing.bin");
    const wavFile = path.join(tmpDir, "chunk.wav");
    fs.writeFileSync(wavFile, Buffer.alloc(100));

    const noModel = await transcribeFileLocal(wavFile, missingModel, "en", null);
    assert.match(noModel.error, /Model not found/);

    fs.writeFileSync(missingModel, Buffer.alloc(4));
    const noFile = await transcribeFileLocal(
      path.join(tmpDir, "nope.wav"),
      missingModel,
      "en",
      null,
    );
    assert.match(noFile.error, /No recording file/);

    const emptyFile = path.join(tmpDir, "empty.wav");
    fs.writeFileSync(emptyFile, Buffer.alloc(10));
    const empty = await transcribeFileLocal(emptyFile, missingModel, "en", null);
    assert.match(empty.error, /Recording is empty/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("transcribeApiFile requires an endpoint and model", async () => {
  const result = await transcribeApiFile("/tmp/whatever.wav", null, null, null, null);
  assert.equal(result.error, "STT API not configured");
});

test("builds whisper-cli args with language", () => {
  assert.deepEqual(buildWhisperArgs("/models/ggml.bin", "/tmp/a.wav", "zh"), [
    "-m",
    "/models/ggml.bin",
    "-f",
    "/tmp/a.wav",
    "-l",
    "zh",
    "-np",
    "-nt",
  ]);
  assert.deepEqual(buildWhisperArgs("/models/ggml.bin", "/tmp/a.wav", null), [
    "-m",
    "/models/ggml.bin",
    "-f",
    "/tmp/a.wav",
    "-l",
    "auto",
    "-np",
    "-nt",
  ]);
});

test("stream waveform maps the PCM tail to flat silence and high speech bars", () => {
  __resetStreamWave();
  assert.deepEqual(waveLevelsFromPcm(null), Array(16).fill(0));
  assert.deepEqual(waveLevelsFromPcm(Buffer.alloc(2560)), Array(16).fill(0));

  __resetStreamWave();
  const mixed = Buffer.alloc(2560);
  for (let column = 0; column < 8; column++) {
    for (let sample = 0; sample < 80; sample++) {
      mixed.writeInt16LE(12000, (column * 80 + sample) * 2);
    }
  }
  const levels = waveLevelsFromPcm(mixed);
  assert.ok(
    levels.slice(0, 8).every((level) => level === 7),
    `loud columns are full bars: ${levels}`,
  );
  assert.ok(
    levels.slice(8).every((level) => level === 0),
    `silent columns stay flat: ${levels}`,
  );
});
