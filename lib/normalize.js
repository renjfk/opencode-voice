// Normalization client: lets the normalizing model differ from the main one.
//
// Every normalization call (STT cleanup after transcription, TTS markdown ->
// spoken text) goes through this client, so a small/cheap model can normalize
// while a larger model answers. With no `normalize*` option set it reuses the
// main endpoint/model/apiKeyEnv, so the default behaviour is unchanged.
//
// Options (plugin options in cli.json / opencode.json):
//   normalize:          true|false  (default true)
//   normalizeModel:     string      (default: model)
//   normalizeEndpoint:  string      (default: endpoint)
//   normalizeApiKeyEnv: string      (default: apiKeyEnv)

import { createClient } from "./llm-client.js";

/**
 * Create the completion function used for text normalization.
 *
 * @param {object} [pluginOptions] - Static config from plugin options
 * @param {{ log?: (scope: string, message: string, level?: string) => void }} [logger]
 * @returns {{ complete: (opts: object) => Promise<{ text: string | null, error?: string }>, enabled: boolean }}
 */
export function createNormalizer(pluginOptions, logger) {
  const options = pluginOptions ?? {};
  const enabled = options.normalize !== false;
  const endpoint = options.normalizeEndpoint ?? options.endpoint;
  const model = options.normalizeModel ?? options.model;
  const apiKeyEnv = options.normalizeApiKeyEnv ?? options.apiKeyEnv;

  const client = createClient({ ...options, endpoint, model, apiKeyEnv }, logger);

  logger?.log?.(
    "LLM",
    `normalizer configured enabled=${enabled} model=${model ?? "-"} endpoint=${endpoint ?? "-"}`,
    "debug",
  );

  async function complete(opts) {
    if (!enabled) return { text: null, error: "normalization disabled" };
    return client.complete(opts);
  }

  return { complete, enabled };
}
