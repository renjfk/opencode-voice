// Resolves which OpenAI-compatible endpoint/model/key the voice LLM uses.
//
// Precedence: explicit plugin options (endpoint/model) -> voice selection
// (/voice-model) -> the session's current model. Provider base URL and key
// come from OpenCode's provider list and its auth store.
//
// Key rules (security):
// - Explicit `apiKey` / `apiKeyEnv` options always win.
// - A provider key (its env vars, then auth.json) is used ONLY when the
//   endpoint itself came from that same provider. An explicit `endpoint`
//   never receives a provider/stored key.
// - From auth.json only `type: "api"` keys are used; OAuth tokens never.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface LlmConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
  useResponsesApi?: boolean;
  /** True only for opencode.ai hosts (session-scoped gateway). */
  sendSessionHeader: boolean;
  /** "provider/model" for display. */
  label: string;
}

export interface ModelRef {
  providerID: string;
  modelID: string;
}

type Env = Record<string, string | undefined>;

export interface ResolveLlmInput {
  options: Record<string, unknown>;
  selection: ModelRef | null;
  sessionModel: ModelRef | null;
  /** `ctx.data.location.provider.list()` (or v1-shaped providers with `models`). */
  providers: unknown[];
  /** `ctx.data.location.model.list()`; optional when providers embed `models`. */
  models?: unknown[];
  env?: Env;
  readAuth?: () => unknown;
}

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** OpenCode's auth store path; honors XDG_DATA_HOME like OpenCode itself. */
export function authFilePath(env: Env = process.env): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  const base =
    xdg && isAbsolute(xdg) ? xdg : join(env.HOME?.trim() || homedir(), ".local", "share");
  return join(base, "opencode", "auth.json");
}

function readAuthFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function isOpencodeHost(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === "opencode.ai" || host.endsWith(".opencode.ai");
  } catch {
    return false;
  }
}

function hostLabel(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "custom";
  }
}

function findModel(
  provider: Rec,
  providerID: string,
  modelID: string,
  models: unknown[],
): Rec | undefined {
  const fromList = models.find(
    (m): m is Rec => isRecord(m) && m.providerID === providerID && m.id === modelID,
  );
  if (fromList) return fromList;
  const own = provider.models;
  if (Array.isArray(own)) return own.find((m): m is Rec => isRecord(m) && m.id === modelID);
  if (isRecord(own)) {
    const m = own[modelID];
    return isRecord(m) ? m : undefined;
  }
  return undefined;
}

interface ProviderTarget {
  providerID: string;
  /** Upstream model id to send in the request body. */
  model: string;
  endpoint?: string;
  /** Lazily resolved: env var first, then an auth.json `api` key. */
  key: () => string | undefined;
}

function resolveRef(
  ref: ModelRef,
  input: ResolveLlmInput,
  env: Env,
  readAuth: () => unknown,
): ProviderTarget | null {
  const provider = input.providers.find((p): p is Rec => isRecord(p) && p.id === ref.providerID);
  if (!provider) return null;
  const model = findModel(provider, ref.providerID, ref.modelID, input.models ?? []);
  const api = isRecord(model?.api) ? model.api : undefined;
  const settings = isRecord(provider.settings) ? provider.settings : undefined;
  const options = isRecord(provider.options) ? provider.options : undefined;
  return {
    providerID: ref.providerID,
    model: str(model?.modelID) ?? str(api?.id) ?? str(model?.id) ?? ref.modelID,
    endpoint: str(settings?.baseURL) ?? str(options?.baseURL) ?? str(api?.url),
    key: () => {
      const envNames = Array.isArray(provider.env) ? provider.env : [];
      for (const name of envNames) {
        const value = typeof name === "string" ? str(env[name]) : undefined;
        if (value) return value;
      }
      const auth = readAuth();
      if (!isRecord(auth)) return undefined;
      for (const id of [str(provider.id), str(provider.integrationID)]) {
        const entry = id ? auth[id] : undefined;
        // OAuth access/refresh tokens are never forwarded.
        if (isRecord(entry) && entry.type === "api") {
          const key = str(entry.key);
          if (key) return key;
        }
      }
      return undefined;
    },
  };
}

export function resolveLlmConfig(input: ResolveLlmInput): LlmConfig | null {
  const env = input.env ?? process.env;
  const readAuth = input.readAuth ?? (() => readAuthFile(authFilePath(env)));
  const { options } = input;

  const optEndpoint = str(options.endpoint);
  const optModel = str(options.model);
  const keyEnv = str(options.apiKeyEnv);
  const explicitKey = str(options.apiKey) ?? (keyEnv ? str(env[keyEnv]) : undefined);
  const useResponsesApi = options.useResponsesApi === true ? true : undefined;

  const build = (endpoint: string, model: string, apiKey: string | undefined, owner: string) => ({
    endpoint,
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(useResponsesApi ? { useResponsesApi } : {}),
    sendSessionHeader: isOpencodeHost(endpoint),
    label: `${owner}/${model}`,
  });

  if (optEndpoint && optModel)
    return build(optEndpoint, optModel, explicitKey, hostLabel(optEndpoint));

  const refs = [input.selection, input.sessionModel].filter(
    (ref): ref is ModelRef => ref !== null && !!ref.providerID && !!ref.modelID,
  );
  const targets = refs.map((ref) => resolveRef(ref, input, env, readAuth));

  if (optEndpoint) {
    // Explicit endpoint, model from the selection: never a provider key.
    const first = refs[0];
    const model = targets[0]?.model ?? first?.modelID;
    return model ? build(optEndpoint, model, explicitKey, hostLabel(optEndpoint)) : null;
  }

  const target = targets.find((t) => t?.endpoint);
  if (!target?.endpoint) return null;
  const model = optModel ?? target.model;
  return build(target.endpoint, model, explicitKey ?? target.key(), target.providerID);
}
