import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenRouterTranscriptionRequest,
  cleanLLMOutput,
  isOpenRouterEndpoint,
} from "../lib/stt.js";

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

test("cleanLLMOutput strips preambles and quotes from small-LLM output", () => {
  assert.equal(
    cleanLLMOutput('Here is the cleaned-up transcription:\n\n"Fix the bug in auth"'),
    "Fix the bug in auth",
  );
  assert.equal(
    cleanLLMOutput("Here's the cleaned text:\nTest test this is a test"),
    "Test test this is a test",
  );
  assert.equal(
    cleanLLMOutput('Sure! Here is the cleaned text:\n\n"Create a JSON file"'),
    "Create a JSON file",
  );
  assert.equal(cleanLLMOutput("Output:\nRun the test suite"), "Run the test suite");
});

test("cleanLLMOutput leaves clean text untouched", () => {
  assert.equal(
    cleanLLMOutput("Can you create a JSON file with the Docker config?"),
    "Can you create a JSON file with the Docker config?",
  );
  assert.equal(cleanLLMOutput("test test test this is a test"), "test test test this is a test");
  assert.equal(cleanLLMOutput(""), "");
});
