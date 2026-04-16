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
//     "maxTokens": 2048
//   }]

const DEFAULTS = {
  endpoint: "https://api.anthropic.com/v1",
  model: "claude-haiku-4-5",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  maxTokens: 2048,
};

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

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: cfg.maxTokens,
          messages,
        }),
      });

      if (!response.ok) {
        return { text: null, error: `LLM request failed (${response.status})` };
      }
      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content || null;
      return { text, error: text ? undefined : "Empty LLM response" };
    } catch (err) {
      return { text: null, error: `LLM error: ${err.message}` };
    }
  }

  return { complete };
}
