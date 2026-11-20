import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authFilePath, isOpencodeHost, resolveLlmConfig, type ResolveLlmInput } from "./config.ts";

const providers = [
  {
    id: "openrouter",
    env: ["OPENROUTER_API_KEY"],
    settings: { baseURL: "https://openrouter.ai/api/v1" },
  },
  { id: "opencode", env: [], settings: { baseURL: "https://opencode.ai/zen/v1" } },
  { id: "anthropic", env: ["ANTHROPIC_API_KEY"], settings: {} },
  { id: "nourl", env: [], settings: {} },
];
const models = [
  { id: "fast", modelID: "upstream/fast", providerID: "openrouter" },
  { id: "go", providerID: "opencode" },
  {
    id: "haiku",
    providerID: "anthropic",
    api: { id: "claude-haiku", url: "https://api.anthropic.com/v1" },
  },
];

const auth = {
  openrouter: { type: "api", key: "stored-or" },
  opencode: { type: "api", key: "stored-oc" },
  anthropic: { type: "oauth", access: "oauth-access", refresh: "oauth-refresh" },
};

function input(over: Partial<ResolveLlmInput> = {}): ResolveLlmInput {
  return {
    options: {},
    selection: null,
    sessionModel: null,
    providers,
    models,
    env: {},
    readAuth: () => auth,
    ...over,
  };
}

describe("precedence", () => {
  test("explicit endpoint + model win over selection and session", () => {
    const cfg = resolveLlmConfig(
      input({
        options: { endpoint: "https://llm.example/v1", model: "m1" },
        selection: { providerID: "openrouter", modelID: "fast" },
        sessionModel: { providerID: "opencode", modelID: "go" },
      }),
    );
    expect(cfg).toEqual({
      endpoint: "https://llm.example/v1",
      model: "m1",
      sendSessionHeader: false,
      label: "llm.example/m1",
    });
  });

  test("voice selection wins over session model", () => {
    const cfg = resolveLlmConfig(
      input({
        selection: { providerID: "openrouter", modelID: "fast" },
        sessionModel: { providerID: "opencode", modelID: "go" },
      }),
    );
    expect(cfg?.endpoint).toBe("https://openrouter.ai/api/v1");
    expect(cfg?.model).toBe("upstream/fast");
    expect(cfg?.label).toBe("openrouter/upstream/fast");
  });

  test("falls back to the session model", () => {
    const cfg = resolveLlmConfig(
      input({ sessionModel: { providerID: "opencode", modelID: "go" } }),
    );
    expect(cfg?.endpoint).toBe("https://opencode.ai/zen/v1");
    expect(cfg?.model).toBe("go");
    expect(cfg?.sendSessionHeader).toBe(true);
  });

  test("selection whose provider has no endpoint falls through to the session model", () => {
    const cfg = resolveLlmConfig(
      input({
        selection: { providerID: "nourl", modelID: "x" },
        sessionModel: { providerID: "opencode", modelID: "go" },
      }),
    );
    expect(cfg?.endpoint).toBe("https://opencode.ai/zen/v1");
  });

  test("uses model api url and api id when provider has no baseURL", () => {
    const cfg = resolveLlmConfig(
      input({
        selection: { providerID: "anthropic", modelID: "haiku" },
        env: { ANTHROPIC_API_KEY: "env-key" },
      }),
    );
    expect(cfg?.endpoint).toBe("https://api.anthropic.com/v1");
    expect(cfg?.model).toBe("claude-haiku");
    expect(cfg?.apiKey).toBe("env-key");
  });

  test("accepts v1-shaped providers with embedded models and options.baseURL", () => {
    const cfg = resolveLlmConfig(
      input({
        providers: [
          {
            id: "p1",
            env: [],
            options: { baseURL: "https://p1.test/v1" },
            models: { a: { id: "a", modelID: "up-a" } },
          },
        ],
        models: undefined,
        selection: { providerID: "p1", modelID: "a" },
      }),
    );
    expect(cfg?.endpoint).toBe("https://p1.test/v1");
    expect(cfg?.model).toBe("up-a");
  });

  test("explicit model with provider endpoint", () => {
    const cfg = resolveLlmConfig(
      input({
        options: { model: "other" },
        sessionModel: { providerID: "openrouter", modelID: "fast" },
      }),
    );
    expect(cfg?.model).toBe("other");
    expect(cfg?.endpoint).toBe("https://openrouter.ai/api/v1");
    expect(cfg?.apiKey).toBe("stored-or");
  });

  test("returns null when nothing is usable", () => {
    expect(resolveLlmConfig(input())).toBeNull();
    expect(resolveLlmConfig(input({ options: { endpoint: "https://x.test/v1" } }))).toBeNull();
    expect(resolveLlmConfig(input({ options: { model: "m" } }))).toBeNull();
    expect(
      resolveLlmConfig(input({ selection: { providerID: "missing", modelID: "m" } })),
    ).toBeNull();
    expect(
      resolveLlmConfig(input({ selection: { providerID: "nourl", modelID: "m" } })),
    ).toBeNull();
  });

  test("useResponsesApi option passes through", () => {
    const cfg = resolveLlmConfig(
      input({ options: { endpoint: "https://x.test/v1", model: "m", useResponsesApi: true } }),
    );
    expect(cfg?.useResponsesApi).toBe(true);
  });
});

describe("key security", () => {
  test("explicit endpoint never gets a stored or provider key", () => {
    let authReads = 0;
    const cfg = resolveLlmConfig(
      input({
        options: { endpoint: "https://evil.example/v1" },
        selection: { providerID: "openrouter", modelID: "fast" },
        env: { OPENROUTER_API_KEY: "env-or" },
        readAuth: () => {
          authReads++;
          return auth;
        },
      }),
    );
    expect(cfg?.endpoint).toBe("https://evil.example/v1");
    expect(cfg?.model).toBe("upstream/fast");
    expect(cfg?.apiKey).toBeUndefined();
    expect(authReads).toBe(0);
  });

  test("explicit apiKeyEnv / apiKey are used for explicit endpoints", () => {
    const base = { endpoint: "https://x.test/v1", model: "m" };
    expect(
      resolveLlmConfig(input({ options: { ...base, apiKeyEnv: "MY_KEY" }, env: { MY_KEY: "k1" } }))
        ?.apiKey,
    ).toBe("k1");
    expect(resolveLlmConfig(input({ options: { ...base, apiKey: "k2" } }))?.apiKey).toBe("k2");
  });

  test("explicit key wins over provider key", () => {
    const cfg = resolveLlmConfig(
      input({
        options: { apiKey: "mine" },
        selection: { providerID: "openrouter", modelID: "fast" },
      }),
    );
    expect(cfg?.apiKey).toBe("mine");
  });

  test("provider env key wins over stored key", () => {
    const cfg = resolveLlmConfig(
      input({
        selection: { providerID: "openrouter", modelID: "fast" },
        env: { OPENROUTER_API_KEY: "env-or" },
      }),
    );
    expect(cfg?.apiKey).toBe("env-or");
  });

  test("stored api key used only for its own provider endpoint", () => {
    const cfg = resolveLlmConfig(
      input({ sessionModel: { providerID: "opencode", modelID: "go" } }),
    );
    expect(cfg?.apiKey).toBe("stored-oc");
  });

  test("OAuth tokens are never used", () => {
    const cfg = resolveLlmConfig(
      input({ selection: { providerID: "anthropic", modelID: "haiku" } }),
    );
    expect(cfg?.endpoint).toBe("https://api.anthropic.com/v1");
    expect(cfg?.apiKey).toBeUndefined();
  });

  test("stored key looked up by integrationID too", () => {
    const cfg = resolveLlmConfig(
      input({
        providers: [
          {
            id: "zen",
            integrationID: "opencode",
            settings: { baseURL: "https://opencode.ai/zen/v1" },
          },
        ],
        selection: { providerID: "zen", modelID: "m" },
      }),
    );
    expect(cfg?.apiKey).toBe("stored-oc");
  });

  test("unreadable auth store yields no key", () => {
    const cfg = resolveLlmConfig(
      input({ sessionModel: { providerID: "opencode", modelID: "go" }, readAuth: () => null }),
    );
    expect(cfg?.apiKey).toBeUndefined();
  });
});

describe("session header host", () => {
  test("only opencode.ai hosts", () => {
    expect(isOpencodeHost("https://opencode.ai/zen/v1")).toBe(true);
    expect(isOpencodeHost("https://api.opencode.ai/v1")).toBe(true);
    expect(isOpencodeHost("https://OPENCODE.AI/zen")).toBe(true);
    expect(isOpencodeHost("https://opencode.ai.evil.com/v1")).toBe(false);
    expect(isOpencodeHost("https://evilopencode.ai/v1")).toBe(false);
    expect(isOpencodeHost("https://openrouter.ai/api/v1")).toBe(false);
    expect(isOpencodeHost("not a url")).toBe(false);
  });

  test("explicit non-opencode endpoint disables the header", () => {
    const cfg = resolveLlmConfig(input({ options: { endpoint: "https://x.test/v1", model: "m" } }));
    expect(cfg?.sendSessionHeader).toBe(false);
  });
});

describe("authFilePath", () => {
  test("honors XDG_DATA_HOME", () => {
    expect(authFilePath({ XDG_DATA_HOME: "/xdg", HOME: "/home/u" })).toBe(
      "/xdg/opencode/auth.json",
    );
  });
  test("defaults to ~/.local/share", () => {
    expect(authFilePath({ HOME: "/home/u" })).toBe("/home/u/.local/share/opencode/auth.json");
  });
  test("ignores relative XDG_DATA_HOME", () => {
    expect(authFilePath({ XDG_DATA_HOME: "rel", HOME: "/home/u" })).toBe(
      "/home/u/.local/share/opencode/auth.json",
    );
  });
  test("default reader reads <XDG_DATA_HOME>/opencode/auth.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-llm-"));
    try {
      mkdirSync(join(dir, "opencode"));
      writeFileSync(
        join(dir, "opencode", "auth.json"),
        JSON.stringify({ opencode: { type: "api", key: "xdg-key" } }),
      );
      const resolve = (xdg: string) =>
        resolveLlmConfig({
          options: {},
          selection: null,
          sessionModel: { providerID: "opencode", modelID: "go" },
          providers,
          models,
          env: { XDG_DATA_HOME: xdg, HOME: "/nonexistent-home" },
        });
      expect(resolve(dir)?.apiKey).toBe("xdg-key");
      expect(resolve(join(dir, "missing"))?.apiKey).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
