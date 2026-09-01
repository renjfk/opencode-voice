// OpenAI-compatible LLM client for text normalization.
//
// Works with any OpenAI-compatible endpoint:
//   - Anthropic's OpenAI compatibility layer
//   - OpenAI directly
//   - Ollama, vLLM, LM Studio, etc.
//
// Configuration is passed from plugin options (tui.json):
//   ["@renjfk/opencode-voice", {
//     "endpoint": "https://api.anthropic.com/v1",
//     "model": "claude-haiku-4-5",
//     "apiKeyEnv": "ANTHROPIC_API_KEY",
//     "maxTokens": 2048,
//     "reasoningEffort": "low",
//     "chatTemplateKwargs": {"enable_thinking": false},
//     "retries": 2
//   }]

const DEFAULTS = {
  maxTokens: 2048,
  reasoningEffort: null,
  chatTemplateKwargs: null,
  retries: 2,
  temperature: null,
};

function isResponsesEndpoint(endpoint, explicitFlag) {
  if (explicitFlag === true) return true;
  if (explicitFlag === false) return false;
  const trimmed = (endpoint || "").replace(/\/+$/, "");
  return trimmed.endsWith("/responses");
}

function isChatCompletionsEndpoint(endpoint) {
  const trimmed = (endpoint || "").replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions");
}

function resolveEndpoint(raw, useResponses) {
  const trimmed = (raw || "").replace(/\/+$/, "");
  if (!trimmed) return trimmed;
  if (
    isChatCompletionsEndpoint(trimmed) ||
    (isResponsesEndpoint(trimmed, useResponses === true ? true : null) &&
      trimmed.endsWith("/responses"))
  ) {
    // already a full path — use as-is
    if (trimmed.endsWith("/chat/completions") || trimmed.endsWith("/responses")) return trimmed;
  }
  if (isResponsesEndpoint(raw, useResponses)) return `${trimmed}/responses`;
  return `${trimmed}/chat/completions`;
}

function extractResponsesText(data) {
  if (!data) return null;
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text;
  // output: [{ type:"message", content:[{type:"output_text", text:"..."}] }]
  const out = data.output;
  if (Array.isArray(out)) {
    for (const item of out) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c?.text === "string" && c.text.trim()) return c.text;
          if (typeof c?.output_text === "string" && c.output_text.trim()) return c.output_text;
        }
      } else if (typeof content?.text === "string" && content.text.trim()) {
        return content.text;
      }
    }
  }
  // some gateways return choices like chat
  return data?.choices?.[0]?.message?.content || null;
}

function normalizeRetries(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULTS.retries;
  return Math.floor(parsed);
}

function normalizeChatTemplateKwargs(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function shouldRetry(status) {
  return status === 408 || status === 429 || status >= 500;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create an LLM completion function.
 *
 * @param {object} [pluginOptions] - Static config from tui.json plugin options
 * @param {{ log?: (scope: string, message: string, level?: string) => void }} [logger]
 * @returns {{ complete: (opts: { system?: string, prompt: string, config?: object }) => Promise<{ text: string | null, error?: string }> }}
 */
export function createClient(pluginOptions, logger) {
  function getConfig() {
    const rawUseResponses =
      pluginOptions?.useResponsesApi ??
      pluginOptions?.responsesApi ??
      pluginOptions?.useResponses ??
      null;
    // allow explicit apiMode: "responses" | "chat"
    const modeFlag =
      pluginOptions?.apiMode === "responses"
        ? true
        : pluginOptions?.apiMode === "chat"
          ? false
          : rawUseResponses;
    return {
      endpoint: pluginOptions?.endpoint,
      model: pluginOptions?.model,
      apiKeyEnv: pluginOptions?.apiKeyEnv,
      maxTokens: pluginOptions?.maxTokens ?? DEFAULTS.maxTokens,
      reasoningEffort: pluginOptions?.reasoningEffort ?? DEFAULTS.reasoningEffort,
      chatTemplateKwargs: normalizeChatTemplateKwargs(
        pluginOptions?.chatTemplateKwargs ?? DEFAULTS.chatTemplateKwargs,
      ),
      retries: normalizeRetries(pluginOptions?.retries ?? DEFAULTS.retries),
      temperature:
        pluginOptions?.temperature != null
          ? Number(pluginOptions.temperature)
          : DEFAULTS.temperature,
      useResponsesApi: modeFlag,
    };
  }

  /**
   * Send a chat completion request to an OpenAI-compatible endpoint.
   *
   * @param {object} opts
   * @param {string} [opts.system]  - System prompt
   * @param {string} opts.prompt    - User message
   * @param {object} [opts.config]  - Per-call overrides (e.g. { maxTokens: 4096 })
   * @returns {Promise<{ text: string | null, error?: string }>}
   */
  async function complete({ system, prompt, config: overrides }) {
    const cfg = { ...getConfig(), ...overrides };
    if (!cfg.endpoint) {
      logger?.log?.("LLM", "completion skipped: endpoint not configured", "warn");
      return { text: null, error: "LLM endpoint not configured" };
    }
    if (!cfg.model) {
      logger?.log?.("LLM", "completion skipped: model not configured", "warn");
      return { text: null, error: "LLM model not configured" };
    }
    const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : null;

    const endpoint = resolveEndpoint(cfg.endpoint, cfg.useResponsesApi);
    const useResponses = endpoint.endsWith("/responses");

    let body;
    if (useResponses) {
      body = {
        model: cfg.model,
        input: prompt,
        instructions: system || undefined,
        max_output_tokens: cfg.maxTokens,
      };
      if (cfg.temperature != null && Number.isFinite(cfg.temperature))
        body.temperature = cfg.temperature;
      if (cfg.reasoningEffort) body.reasoning = { effort: cfg.reasoningEffort };
      // chat_template_kwargs not standard for responses, but pass through if needed
      if (cfg.chatTemplateKwargs) body.chat_template_kwargs = cfg.chatTemplateKwargs;
    } else {
      const messages = [];
      if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "user", content: prompt });
      body = {
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        messages,
      };
      if (cfg.temperature != null && Number.isFinite(cfg.temperature))
        body.temperature = cfg.temperature;
      if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;
      if (cfg.chatTemplateKwargs) body.chat_template_kwargs = cfg.chatTemplateKwargs;
    }

    for (let attempt = 0; attempt <= cfg.retries; attempt++) {
      try {
        logger?.log?.(
          "LLM",
          `Completion request attempt=${attempt + 1} model=${cfg.model} maxTokens=${cfg.maxTokens} promptChars=${prompt.length}`,
          "debug",
        );
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}),
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          logger?.log?.(
            "LLM",
            `Completion response status=${response.status}`,
            shouldRetry(response.status) ? "warn" : "error",
          );
          if (attempt < cfg.retries && shouldRetry(response.status)) {
            await wait(250 * 2 ** attempt);
            continue;
          }
          return { text: null, error: `LLM request failed (${response.status})` };
        }

        const data = await response.json();
        const text = useResponses
          ? extractResponsesText(data)
          : data?.choices?.[0]?.message?.content || null;
        if (text) {
          logger?.log?.(
            "LLM",
            `Completion succeeded chars=${text.length} mode=${useResponses ? "responses" : "chat"}`,
            "debug",
          );
          return { text };
        }

        logger?.log?.("LLM", "Completion returned empty content", "warn");

        if (attempt < cfg.retries) {
          await wait(250 * 2 ** attempt);
          continue;
        }
        return { text: null, error: "Empty LLM response" };
      } catch (err) {
        logger?.log?.("LLM", `Completion error attempt=${attempt + 1}: ${err.message}`, "warn");
        if (attempt < cfg.retries) {
          await wait(250 * 2 ** attempt);
          continue;
        }
        return { text: null, error: `LLM error: ${err.message}` };
      }
    }

    return { text: null, error: "LLM request failed after retries" };
  }

  return { complete };
}
