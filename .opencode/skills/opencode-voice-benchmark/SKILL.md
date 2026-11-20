---
name: opencode-voice-benchmark
description: Use when benchmarking opencode-voice STT normalization latency, local/OpenAI-compatible LLM models, Qwen thinking settings, or cache effects.
---

# opencode-voice Benchmarking

Use this skill to produce actual STT normalization benchmark numbers. Keep the benchmark temporary unless the user asks to keep it.

## Steps

1. Read `src/llm/prompts.ts` and copy the exact `STT_NORMALIZE_PROMPT` (and `buildSttUser`) from the tool plus user prompt format. Do not rely on a stale prompt from memory or from this skill if the source file differs:

```js
prompt = `Clean up this speech-to-text transcription:\n\n${rawText}`;
```

2. Read `src/llm/client.ts` to confirm the request body fields and supported options.

3. Create a temporary benchmark script outside the repo.

Use this working script as the starting point and edit endpoints/models as needed. Before running it, replace `STT_SYSTEM_PROMPT` with the current prompt copied from `src/llm/prompts.ts`:

```js
import { performance } from "node:perf_hooks";

const GLOBAL_ENDPOINT = process.env.BENCH_GLOBAL_ENDPOINT;
const GLOBAL_MODEL = process.env.BENCH_GLOBAL_MODEL;
const GLOBAL_API_KEY = process.env.BENCH_GLOBAL_API_KEY;

const LOCAL_ENDPOINT = process.env.BENCH_LOCAL_ENDPOINT || "http://127.0.0.1:8000/v1";
const LOCAL_API_KEY = process.env.BENCH_LOCAL_API_KEY || "";
const LOCAL_MODELS = (process.env.BENCH_LOCAL_MODELS || "Qwen3.6-35B-A3B-4bit")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

const STT_SYSTEM_PROMPT = `You are a speech-to-text normalizer for a coding assistant CLI.

Clean up raw whisper transcription into a clear, well-punctuated prompt. Rules:
- Fix punctuation, capitalization, and grammar
- Remove filler words (um, uh, like, you know, etc.)
- Keep technical terms, file names, and code references exact
- If the user is dictating code, format it appropriately
- Use the session context above to resolve ambiguous references (e.g. "that function", "the file", "it")
- Output ONLY the cleaned text, nothing else
- Do not add any commentary or explanation
- Keep the user's intent and meaning intact

CRITICAL DOMAIN CORRECTIONS - Fix common STT homophone errors in software engineering contexts:
- "locks" -> "logs" (unless explicitly talking about mutexes/concurrency)
- "note" / "no" -> "node"
- "app and" -> "append"
- "sink" -> "sync"
- "a sink" -> "async"
- "doc" / "talker" -> "docker"
- "cash" -> "cache"
- "rap" -> "wrap"
- "Jason" -> "JSON"
- "get" -> "Git"
- "react" -> "React"
- "types creep" / "type script" -> "TypeScript"
- "bite" -> "byte"
- "string" -> "String"
- "int" -> "Int"
- "bullion" -> "boolean"

Rely heavily on context to fix words that sound similar to programming terminology.`;

const CASES = [
  {
    id: "json-cache-async",
    raw: "umm the node function is returning the wrong Jason and i think its a sink operation with the cash layer",
    expected: ["JSON", "async", "cache"],
  },
  {
    id: "docker-logs-typescript",
    raw: "check the locks for the doc container because the get rap failed and the types creep files need updates",
    expected: ["logs", "Docker", "Git", "wrap", "TypeScript"],
  },
  {
    id: "boolean-byte-node",
    raw: "the bullion flag is false and the bite size is too small for the note js buffer so app and the string data",
    expected: ["boolean", "byte", "Node", "append", "string"],
  },
  {
    id: "plain-request",
    raw: "add tests for the a sink user service and make sure the error handling covers missing inputs",
    expected: ["tests", "async", "user", "error"],
  },
];

function formatMs(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function health(text, expected) {
  const lower = text.toLowerCase();
  const matched = expected.filter((kw) => lower.includes(kw.toLowerCase())).length;
  const leaks = /^(here is|here are|the cleaned|i've cleaned|<think>)/i.test(text);
  return { score: matched / expected.length, leaks };
}

async function callLLM({ endpoint, apiKey, model, system, prompt, extraBody }) {
  const url = `${endpoint.replace(/\/+$/, "")}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      ...extraBody,
    }),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);

  const data = await response.json();
  const totalMs = performance.now() - started;
  const text = data?.choices?.[0]?.message?.content?.trim() || "";
  const tokens = data?.usage?.completion_tokens || 0;
  return { text, totalMs, tokens };
}

async function benchmarkModel({ label, endpoint, apiKey, model, extraBody, cold }) {
  console.log(`\n${label}: ${model}`);

  if (!cold) {
    for (const raw of ["warm up Jason cash", "warm up a sink locks"]) {
      await callLLM({
        endpoint,
        apiKey,
        model,
        system: STT_SYSTEM_PROMPT,
        prompt: `Clean up this speech-to-text transcription:\n\n${raw}`,
        extraBody,
      });
    }
  }

  const rows = [];
  for (const test of CASES) {
    const system = cold
      ? STT_SYSTEM_PROMPT.replace("coding assistant CLI", `coding assistant CLI v${Date.now()}`)
      : STT_SYSTEM_PROMPT;
    const result = await callLLM({
      endpoint,
      apiKey,
      model,
      system,
      prompt: `Clean up this speech-to-text transcription:\n\n${test.raw}`,
      extraBody,
    });
    const h = health(result.text, test.expected);
    const tps = result.totalMs > 0 ? result.tokens / (result.totalMs / 1000) : 0;
    rows.push({ ...result, tps, health: h.score, leaks: h.leaks });
    console.log(
      `${test.id}: ${formatMs(result.totalMs)} | ${result.tokens} tok | ${tps.toFixed(1)} tok/s | ${(h.score * 100).toFixed(0)}%${h.leaks ? " | LEAK" : ""}`,
    );
  }

  const avgMs = rows.reduce((sum, row) => sum + row.totalMs, 0) / rows.length;
  const avgTps = rows.reduce((sum, row) => sum + row.tps, 0) / rows.length;
  const avgHealth = rows.reduce((sum, row) => sum + row.health, 0) / rows.length;
  return { model: cold ? `${model} [cold]` : model, avgMs, avgTps, avgHealth };
}

const summary = [];
for (const model of LOCAL_MODELS) {
  const extraBody = /qwen/i.test(model)
    ? { chat_template_kwargs: { enable_thinking: false } }
    : undefined;
  summary.push(
    await benchmarkModel({
      label: "local warm",
      endpoint: LOCAL_ENDPOINT,
      apiKey: LOCAL_API_KEY,
      model,
      extraBody,
    }),
  );
}

if (process.env.BENCH_COLD_MODEL) {
  const model = process.env.BENCH_COLD_MODEL;
  summary.push(
    await benchmarkModel({
      label: "local cold",
      endpoint: LOCAL_ENDPOINT,
      apiKey: LOCAL_API_KEY,
      model,
      extraBody: /qwen/i.test(model)
        ? { chat_template_kwargs: { enable_thinking: false } }
        : undefined,
      cold: true,
    }),
  );
}

if (GLOBAL_ENDPOINT && GLOBAL_MODEL) {
  summary.push(
    await benchmarkModel({
      label: "global",
      endpoint: GLOBAL_ENDPOINT,
      apiKey: GLOBAL_API_KEY,
      model: GLOBAL_MODEL,
    }),
  );
}

summary.sort((a, b) => a.avgMs - b.avgMs);
console.log("\nSUMMARY");
for (const row of summary) {
  console.log(
    `${row.model.padEnd(32)} ${formatMs(row.avgMs).padStart(8)} ${row.avgTps.toFixed(1).padStart(8)} tok/s ${(row.avgHealth * 100).toFixed(0).padStart(4)}%`,
  );
}
```

4. Use varied raw STT inputs that force real work:

- `Jason` to `JSON`
- `cash` to `cache`
- `a sink` to `async`
- `locks` to `logs`
- `types creep` to `TypeScript`

5. For each model, run two warm-up calls before measuring. Run local models one at a time.

6. For Qwen thinking models, pass this request field:

```json
{ "chat_template_kwargs": { "enable_thinking": false } }
```

7. Measure and print per prompt:

- Total request time
- Completion tokens
- Tokens per second
- Output preview
- Expected keyword health score
- Chain-of-thought or meta-commentary leaks

8. Print a final table sorted by average total time:

```text
MODEL                         AVG TOTAL   TOK/s   HEALTH
Qwen3.6-35B-A3B-4bit          0.64s       43.7    100%
gemma-4-26b-a4b-it-4bit       0.66s       43.4    96%
Azure gpt-oss-120b            0.71s       257.1   92%
```

## Cold/Cache Check

If the user asks whether results are cached, run a second pass with a unique system prompt each call:

```js
const uniqueSystem = STT_SYSTEM_PROMPT.replace(
  "coding assistant CLI",
  `coding assistant CLI v${Date.now()}`,
);
```

Compare warm vs cold averages. Different outputs and token counts mean real generation. A small warm/cold gap is prefix-cache benefit, not response caching.

## Interpretation

- Prioritize average total time for STT UX.
- Treat tok/s as secondary because short completions can be fastest with lower tok/s.
- If LLM normalization is under 1 second but voice feels slow, investigate Whisper transcription, recording delay, or first model load.
- If Qwen is slow or verbose, first verify `chat_template_kwargs.enable_thinking=false` is present in the actual request body.

## Hygiene

- Do not commit benchmark scripts by default.
- Do not print API keys or secrets.
- Use environment variables for remote API keys.
- Omit `Authorization` for unauthenticated local endpoints.
