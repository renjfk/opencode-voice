// Voice LLM picker: reuse OpenCode's own provider/model catalog instead of
// hand-editing endpoint + model in tui.json.
//
// /voice-model lists api.state.provider (the same ~70 providers OpenCode
// connects) then the chosen provider's models, and stores the selection in
// kv. llm-client resolves it to endpoint + model + key env at call time.
// Explicit endpoint/model/apiKeyEnv plugin options always win.
//
// Auth caveat: only env-key providers work (key read live from the provider's
// env list). OAuth/Console-managed credentials are invisible to plugins - for
// those, keep explicit endpoint options.

export function getVoiceProviderSelection(kv) {
  const providerID = kv.get("voice.providerID", null);
  const modelID = kv.get("voice.modelID", null);
  return providerID && modelID ? { providerID, modelID } : null;
}

export function resolveVoiceProviderModel(api, kv) {
  const selection = getVoiceProviderSelection(kv);
  if (!selection) return null;
  const providers = api?.state?.provider || [];
  const provider = providers.find((p) => p?.id === selection.providerID);
  const model = provider?.models?.[selection.modelID];
  if (!provider || !model) return null;
  return { provider, model };
}

export function registerVoiceModel(api, kv, opts, logger) {
  function toast(message, variant = "info") {
    api.ui.toast({ message, variant, duration: 3000 });
  }

  function pickModel(provider) {
    const models = Object.values(provider.models || {});
    if (models.length === 0) {
      toast(`Provider ${provider.name} has no models`, "warning");
      return;
    }
    const current = kv.get("voice.modelID", null);
    api.ui.dialog.replace(() =>
      api.ui.DialogSelect({
        title: `Voice LLM model (${provider.name})`,
        current,
        options: models.map((m) => ({
          title: m.name || m.id,
          value: m.id,
          description: m.id,
          onSelect() {
            kv.set("voice.providerID", provider.id);
            kv.set("voice.modelID", m.id);
            const envVars = Array.isArray(provider.env) ? provider.env : [];
            const hasKey = envVars.some((e) => e && process.env[e]);
            logger?.log(
              "VOICE",
              `Voice LLM selected provider=${provider.id} model=${m.id}`,
              "debug",
            );
            toast(
              hasKey
                ? `Voice LLM: ${provider.name} / ${m.name || m.id}`
                : `Voice LLM: ${provider.name} / ${m.name || m.id} (no key in ${envVars.join(", ") || "env"} - export one)`,
              hasKey ? "success" : "warning",
            );
            api.ui.dialog.clear();
          },
        })),
      }),
    );
  }

  const commands = [
    {
      title: "Voice: select LLM",
      value: "voice.model",
      category: "opencode-voice",
      description: "Choose the LLM for voice normalization from OpenCode providers",
      slash: { name: "voice-model" },
      onSelect() {
        const providers = [...(api?.state?.provider || [])].sort((a, b) =>
          (a?.name || a?.id || "").localeCompare(b?.name || b?.id || ""),
        );
        if (providers.length === 0) {
          toast("No OpenCode providers available", "warning");
          return;
        }
        if (opts?.endpoint && opts?.model) {
          toast("Explicit endpoint/model options override the voice selection", "warning");
        }
        const current = kv.get("voice.providerID", null);
        api.ui.dialog.replace(() =>
          api.ui.DialogSelect({
            title: "Voice LLM provider",
            current,
            options: providers.map((p) => ({
              title: p.name || p.id,
              value: p.id,
              description: [p.id, (p.env || []).join(", ")].filter(Boolean).join(" · "),
              onSelect() {
                pickModel(p);
              },
            })),
          }),
        );
      },
    },
    {
      title: "Voice: clear LLM selection",
      value: "voice.model-clear",
      category: "opencode-voice",
      description: "Clear the voice LLM selection (back to endpoint options)",
      slash: { name: "voice-model-clear" },
      onSelect() {
        kv.set("voice.providerID", null);
        kv.set("voice.modelID", null);
        toast("Voice LLM selection cleared");
      },
    },
  ];

  return { commands };
}
