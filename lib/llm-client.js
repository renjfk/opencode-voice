// OpenAI-compatible LLM client for text normalization.
//
// Works with any OpenAI-compatible endpoint:
//   - Anthropic's OpenAI compatibility layer (default)
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
//     "retries": 2
//   }]

const DEFAULTS = {
  endpoint: "https://api.anthropic.com/v1",
  model: "claude-haiku-4-5",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  maxTokens: 2048,
  reasoningEffort: null,
  retries: 2,
};

function normalizeRetries(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULTS.retries;
  return Math.floor(parsed);
}

function shouldRetry(status) {
  return status === 408 || status === 429 || status >= 500;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create an LLM completion function bound to a kv store for config persistence.
 *
 * @param {object} kv - OpenCode TUI kv store (api.kv)
 * @param {object} [pluginOptions] - Static config from tui.json plugin options
 * @returns {{ complete: (opts: { system?: string, prompt: string, config?: object }) => Promise<{ text: string | null, error?: string }> }}
 */
export function createClient(kv, pluginOptions) {
  function getConfig() {
    return {
      endpoint: kv.get("llm.endpoint") ?? pluginOptions?.endpoint ?? DEFAULTS.endpoint,
      model: kv.get("llm.model") ?? pluginOptions?.model ?? DEFAULTS.model,
      apiKeyEnv: kv.get("llm.apiKeyEnv") ?? pluginOptions?.apiKeyEnv ?? DEFAULTS.apiKeyEnv,
      maxTokens: kv.get("llm.maxTokens") ?? pluginOptions?.maxTokens ?? DEFAULTS.maxTokens,
      reasoningEffort:
        kv.get("llm.reasoningEffort") ?? pluginOptions?.reasoningEffort ?? DEFAULTS.reasoningEffort,
      retries: normalizeRetries(
        kv.get("llm.retries") ?? pluginOptions?.retries ?? DEFAULTS.retries,
      ),
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
    const apiKey = process.env[cfg.apiKeyEnv];
    if (!apiKey) return { text: null, error: `${cfg.apiKeyEnv} not set` };

    const endpoint = cfg.endpoint.replace(/\/+$/, "") + "/chat/completions";

    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });

    const body = {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      messages,
    };
    if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;

    for (let attempt = 0; attempt <= cfg.retries; attempt++) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + apiKey,
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          if (attempt < cfg.retries && shouldRetry(response.status)) {
            await wait(250 * 2 ** attempt);
            continue;
          }
          return { text: null, error: `LLM request failed (${response.status})` };
        }

        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content || null;
        if (text) return { text };

        if (attempt < cfg.retries) {
          await wait(250 * 2 ** attempt);
          continue;
        }
        return { text: null, error: "Empty LLM response" };
      } catch (err) {
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
