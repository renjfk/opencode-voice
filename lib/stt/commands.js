// Extracted STT commands (Phase C). Built once from a SttContext so
// registerSTT stays assembly-only.
//
// @param {any} ctx
// @returns {any[]}
import { makeAutoSubmitNow, toggleSttAutoSubmit } from "../shared/auto-submit.js";
import { ensureUsbForward, usbRemoteProfile } from "./usb-forward.js";

/**
 * SSH-test a remote candidate, save host/port/key/rate to kv, and flip the
 * whole profile (mic + speaker + batch mode) on success. Shared by
 * /stt-remote-setup (current config) and /stt-remote-host (presets).
 */
function applyRemoteConfig(ctx, state) {
  const cmd = [
    "ssh",
    "-i",
    state.key,
    "-p",
    String(state.port),
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    state.host,
    "echo OK",
  ];
  let ok = false;
  try {
    const out = ctx.execSync(cmd[0] + " " + cmd.slice(1).join(" "), {
      encoding: "utf-8",
      timeout: 10000,
    });
    ok = String(out).trim() === "OK";
  } catch (err) {
    ok = false;
    // Name the target: a bare failure never says which machine or why.
    // Usual suspects: phone off tailnet (gnirehtet took its VPN slot),
    // laptop asleep/offline, or a dropped `adb forward` for the USB option.
    ctx.toast(
      `SSH test failed for ${state.host}:${state.port} (${err?.message || err}) - check the machine is reachable, then re-run`,
      "error",
    );
  }
  ctx.kv.set("stt.remoteHost", state.host);
  ctx.kv.set("stt.remotePort", state.port);
  ctx.kv.set("stt.remoteKey", state.key);
  ctx.kv.set("audio.sampleRate", state.rate);
  if (ok) {
    // One click flips the whole profile: remote capture is batch-only,
    // so remember the current mode for the flip-back command.
    const prevMode = ctx.kv.get("stt.mode", null);
    if (prevMode !== "batch" && prevMode != null) ctx.kv.set("stt.prevMode", prevMode);
    ctx.kv.set("stt.mic", "remote");
    ctx.kv.set("tts.output", "remote");
    ctx.kv.set("stt.mode", "batch");
    ctx.toast("Remote voice ready: mic + speaker on remote, batch mode");
  } else {
    ctx.toast("Saved config (SSH test failed)", "warning");
  }
  return ok;
}

export function createCommands(ctx) {
  // Shared whisper model picker so /stt-engine can chain into it after
  // choosing whisper. Same options as /stt-model local + API branches.
  const showModelPicker = async () => {
    if (ctx.sttApiEndpoint) {
      const current = ctx.kv.get("stt.api.model") || ctx.sttApiModel;
      const apiModels = await ctx.getApiModels(ctx.logger);
      const options = apiModels.length > 0 ? apiModels : [{ value: current, label: current }];
      ctx.api.ui.dialog.replace(() =>
        ctx.api.ui.DialogSelect({
          title: "Select whisper model (API)",
          current,
          options: options.map((m) => ({
            title: m.label,
            value: m.value,
            onSelect() {
              ctx.kv.set("stt.api.model", m.value);
              ctx.toast(`Whisper API model: ${m.label}`);
              ctx.api.ui.dialog.clear();
            },
          })),
        }),
      );
    } else {
      const current = ctx.getModelName(ctx.kv);
      ctx.api.ui.dialog.replace(() =>
        ctx.api.ui.DialogSelect({
          title: "Select whisper model",
          current,
          options: Object.entries(ctx.MODELS).map(([key, v]) => ({
            title: v.label,
            value: key,
            onSelect() {
              ctx.kv.set("stt.model", key);
              // Model change tears down the parked warm server lease so
              // the next dictation loads the new model (refused
              // mid-dictation by the start guards; idle teardown here).
              if (!ctx.getStreamingActive()) ctx.disposeWarmStreamController();
              ctx.toast(`Whisper model: ${v.label}`);
              ctx.api.ui.dialog.clear();
            },
          })),
        }),
      );
    }
  };
  // Delivery must read the flag live so a mid-record toggle wins. Prefer the
  // host-wired reader; fall back to a kv-live reader so stale/missing wiring
  // can never freeze a snapshot taken before the toggle.
  const autoSubmitLive =
    typeof ctx.autoSubmitNow === "function"
      ? ctx.autoSubmitNow
      : makeAutoSubmitNow(ctx.opts, ctx.kv);
  const commands = [
    {
      title: ctx.sttApiEndpoint ? "STT: record/transcribe (API)" : "STT: record/transcribe",
      value: "stt.record",
      category: "opencode-voice",
      description:
        ctx.sttApiEndpoint && ctx.autoSubmit
          ? "Toggle recording; press again to stop, transcribe via API and submit"
          : ctx.sttApiEndpoint
            ? "Toggle recording; press again to stop and transcribe via API"
            : ctx.autoSubmit
              ? "Toggle recording; press again to stop, transcribe and submit"
              : "Toggle recording; press again to stop and transcribe",
      ...(ctx.kb("stt.record") ? { keybind: ctx.kb("stt.record") } : {}),
      slash: { name: "stt-record" },
      onSelect() {
        // Streaming mode: toggle streaming record/finalize, or resume a
        // paused session (cheaper than re-speaking; explicit stop stays on
        // /stt-stop). Batch default below is behavior-identical to before.
        ctx.sttLog(
          "toggle",
          `sttMode=${ctx.currentSttMode()} streamingActive=${ctx.getStreamingActive()}`,
        );
        // Conversation owns the live turn. Finalizing or cancelling the
        // stream here would bypass finishTurnFlow: no submit, no reply wait,
        // no speech, and the mode stays stuck on "Listening". The STT key
        // therefore means the same thing as the conversation key.
        if (ctx.conversationActive()) {
          ctx.conversationHooks.onKey?.("record");
          return;
        }
        if (ctx.currentSttMode() === "streaming") {
          if (ctx.getStreamingActive()) {
            try {
              if (ctx.streamController()?.getState?.().paused) {
                ctx.toggleStreamingPause();
                return;
              }
            } catch {}
            void ctx.finalizeStreamingDictation({});
            return;
          }
          if (ctx.liveNotesActive()) {
            ctx.toast("Live notes recording - stop it first (/voice-notes-stop)", "warning");
            return;
          }
          if (ctx.processing() || ctx.recording()) {
            ctx.toast("STT busy, please wait...");
            return;
          }
          void ctx.startStreamingDictation();
          return;
        }
        if (ctx.getStreamingActive()) {
          ctx.toast("Streaming dictation active - use /stt-stop to cancel first", "warning");
          return;
        }
        if (ctx.liveNotesActive()) {
          ctx.toast("Live notes recording - stop it first (/voice-notes-stop)", "warning");
          return;
        }
        if (ctx.processing()) {
          ctx.toast("STT busy, please wait...");
          return;
        }
        if (ctx.recording()) {
          ctx.clearRecordingToast();
          ctx.toast("Stopping, transcribing...");
          ctx.doTranscribePipeline(
            ctx.kv,
            ctx.complete,
            ctx.client,
            ctx.api,
            ctx.toast,
            ctx.systemPrompt,
            autoSubmitLive,
            ctx.logger,
            ctx.renderer,
          );
        } else {
          ctx.startLoopRecording();
        }
      },
    },
    {
      title: ctx.sttApiEndpoint ? "STT: submit recording (API)" : "STT: submit recording",
      value: "stt.submit",
      category: "opencode-voice",
      description: ctx.sttApiEndpoint
        ? "Stop recording, transcribe via API, and submit prompt"
        : "Stop recording, transcribe, and submit prompt",
      ...(ctx.kb("stt.submit") ? { keybind: ctx.kb("stt.submit") } : {}),
      slash: { name: "stt-submit" },
      onSelect() {
        // Streaming mode: finalize then submit ONLY via the captured
        // target's own submit(). Never falls through to primary-chat submit.
        // Conversation owns the turn (see stt.record).
        if (ctx.conversationActive()) {
          ctx.conversationHooks.onKey?.("submit");
          return;
        }
        if (ctx.currentSttMode() === "streaming") {
          if (!ctx.getStreamingActive()) {
            ctx.toast("No streaming dictation in progress", "warning");
            return;
          }
          void ctx.finalizeStreamingDictation({ submit: true });
          return;
        }
        if (ctx.getStreamingActive()) {
          ctx.toast("Streaming dictation active - use /stt-stop to cancel first", "warning");
          return;
        }
        if (ctx.liveNotesActive()) {
          ctx.toast("Live notes recording - stop it first (/voice-notes-stop)", "warning");
          return;
        }
        if (ctx.processing()) {
          ctx.toast("STT busy, please wait...");
          return;
        }
        if (!ctx.recording()) {
          ctx.toast("No recording in progress", "warning");
          return;
        }
        ctx.clearRecordingToast();
        ctx.toast("Stopping, transcribing...");
        ctx.doTranscribePipeline(
          ctx.kv,
          ctx.complete,
          ctx.client,
          ctx.api,
          ctx.toast,
          ctx.systemPrompt,
          true,
          ctx.logger,
          ctx.renderer,
        );
      },
    },
    {
      title: "STT: correct last dictation by re-speaking",
      value: "stt.correct",
      category: "opencode-voice",
      description: "Re-speak a misheard phrase; the last dictation is replaced",
      slash: { name: "stt-correct" },
      onSelect() {
        // Second click on the same correction recording FINISHES it (same
        // finish path as stopping a dictation), instead of a busy warning.
        // Plain recordings that are not a correction keep the warning.
        if (ctx.isCorrecting?.()) {
          if (ctx.recording?.()) {
            ctx.clearRecordingToast();
            ctx.toast("Merging correction...");
            ctx.doTranscribePipeline(
              ctx.kv,
              ctx.complete,
              ctx.client,
              ctx.api,
              ctx.toast,
              ctx.systemPrompt,
              autoSubmitLive,
              ctx.logger,
              ctx.renderer,
            );
            return;
          }
          if (ctx.processing?.()) {
            ctx.toast("Merging correction...", "warning");
            return;
          }
          // Armed with no recording (mic/sox failed to start): self-heal by
          // re-arming below instead of refusing every later Fix press.
          ctx.clearCorrection?.("stale-armed");
        }
        if (ctx.recording?.() || ctx.processing?.()) {
          ctx.toast("Finish the current turn first, then correct", "warning");
          return;
        }
        const begun = ctx.beginCorrection?.();
        if (!begun?.ok) return;
        if (!ctx.startLoopRecording()) {
          ctx.clearCorrection?.("record-failed");
          ctx.toast("Could not start the mic for the correction", "error");
        }
      },
    },
    {
      title: "STT: cancel recording",
      value: "stt.stop",
      category: "opencode-voice",
      description: "Cancel current recording",
      slash: { name: "stt-stop" },
      onSelect() {
        // Conversation owns the turn: cancel the ctx.recording() through the loop so
        // the mode returns to paused instead of sitting on "Listening" with a
        // dead stream.
        if (ctx.conversationActive()) {
          ctx.conversationHooks.onKey?.("cancel");
          return;
        }
        // Streaming mode: cancel and remove ONLY plugin-owned dictation
        // text, never user-typed text.
        if (ctx.currentSttMode() === "streaming" || ctx.getStreamingActive()) {
          if (ctx.getStreamingActive() || ctx.finalizingController?.()) {
            void ctx.cancelStreamingDictation();
            return;
          }
          if (ctx.liveNotesActive()) {
            ctx.toast("Live notes recording - use /voice-notes-stop", "warning");
            return;
          }
          return;
        }
        if (ctx.liveNotesActive()) {
          ctx.toast("Live notes recording - use /voice-notes-stop", "warning");
          return;
        }
        if (ctx.recording()) {
          ctx.cancelRecording(ctx.logger);
          ctx.logger?.log("STT", "Recording cancelled", "debug");
          ctx.toast("Recording cancelled");
        }
      },
    },
    {
      title: "STT: pause / resume streaming dictation",
      value: "stt.pause",
      category: "opencode-voice",
      description: "Freeze the mic mid-dictation (skips noise); run again to resume",
      slash: { name: "stt-pause" },
      onSelect() {
        // Conversation records through its own loop: there is no dictation
        // session to freeze, and pausing the mic would strand the live turn.
        if (ctx.conversationActive()) {
          ctx.toast(
            "Conversation is recording - use the conversation key to send or /stt-stop to cancel",
          );
          return;
        }
        // Batch mode has no pausable session (one-shot record); the mic
        // toggle is start/stop there.
        if (ctx.currentSttMode() !== "streaming" && !ctx.getStreamingActive()) {
          ctx.toast("Pause needs streaming mode - use /stt-mode to switch", "warning");
          return;
        }
        void ctx.pauseStreamingDictation();
      },
    },
    {
      title: "STT: select dictation mode",
      value: "stt.mode",
      category: "opencode-voice",
      description: "Choose one-shot batch or live streaming dictation (saved, survives restarts)",
      slash: { name: "stt-mode" },
      onSelect() {
        const current = ctx.currentSttMode();
        ctx.api.ui.dialog.replace(() =>
          ctx.api.ui.DialogSelect({
            title: "Select dictation mode",
            current,
            options: [
              {
                title: "Streaming (live transcript + wave, local whisper, no LLM)",
                value: "streaming",
                onSelect() {
                  ctx.kv.set("stt.mode", "streaming");
                  ctx.sttLog("mode.set", "streaming via /stt-mode");
                  ctx.toast("Dictation mode: streaming");
                  ctx.api.ui.dialog.clear();
                },
              },
              {
                title: "Batch (record, then transcribe)",
                value: "batch",
                onSelect() {
                  ctx.kv.set("stt.mode", "batch");
                  ctx.sttLog("mode.set", "batch via /stt-mode");
                  ctx.toast("Dictation mode: batch");
                  ctx.api.ui.dialog.clear();
                },
              },
            ],
          }),
        );
      },
    },
    {
      title: "STT: toggle auto-submit",
      value: "stt.autosubmit",
      category: "opencode-voice",
      description: "Toggle submitting the transcript automatically after dictation (saved)",
      slash: { name: "stt-autosubmit" },
      onSelect() {
        // Shared owner also backs the fixed Auto button; commands are built
        // before the dispatcher exists.
        let next;
        try {
          next = toggleSttAutoSubmit(ctx.opts, ctx.kv);
        } catch {
          ctx.toast("Could not save auto-submit setting", "error");
          return;
        }
        ctx.sttLog("mode.set", `autoSubmit=${next} via /stt-autosubmit`);
        ctx.toast(`STT auto-submit: ${next ? "on" : "off"}`);
      },
    },
    {
      title: "STT: toggle auto-end (batch)",
      value: "stt.auto-end",
      category: "opencode-voice",
      description: "Stop recording automatically after silence and transcribe",
      slash: { name: "stt-auto-end" },
      onSelect() {
        const current = ctx.kv.get("stt.autoEndOfSpeech") === true;
        const next = !current;
        ctx.kv.set("stt.autoEndOfSpeech", next);
        ctx.sttLog("mode.set", `autoEnd=${next} via /stt-auto-end`);
        ctx.toast(`STT auto-end: ${next ? "on" : "off"}`);
      },
    },
    {
      title: ctx.sttApiEndpoint ? "STT: select model (API)" : "STT: select model",
      value: "stt.model",
      category: "opencode-voice",
      description: ctx.sttApiEndpoint ? "Choose whisper model via API" : "Choose whisper model",
      slash: { name: "stt-model" },
      async onSelect() {
        await showModelPicker();
      },
    },
    {
      title: "STT: select engine (whisper / gipformer)",
      value: "stt.engine",
      category: "opencode-voice",
      description:
        "Choose local transcription engine (Vietnamese Gipformer or multilingual whisper)",
      slash: { name: "stt-engine" },
      onSelect() {
        const current = ctx.getSttEngine ? ctx.getSttEngine(ctx.kv) : "whisper";
        const options = [
          {
            title: "whisper (multilingual, default)",
            value: "whisper",
            description: "Local whisper-cli, all languages",
          },
          {
            title: "gipformer (Vietnamese, 68M RNN-T)",
            value: "gipformer",
            description: "Gipformer 1.5 ONNX via infer_onnx.py; needs repo checkout + python env",
          },
        ];
        ctx.api.ui.dialog.replace(() =>
          ctx.api.ui.DialogSelect({
            title: "Select STT engine",
            current,
            options: options.map((o) => ({
              title: o.title,
              value: o.value,
              description: o.description,
              onSelect() {
                ctx.kv.set("stt.engine", o.value);
                if (!ctx.getStreamingActive()) ctx.disposeWarmStreamController();
                ctx.toast(`STT engine: ${o.value}`);
                // Chain into model picker when whisper chosen so small
                // variants are one flow, not two palette commands.
                if (o.value === "whisper") {
                  showModelPicker();
                } else {
                  ctx.api.ui.dialog.clear();
                }
              },
            })),
          }),
        );
      },
    },
    {
      title: "STT: select language",
      value: "stt.language",
      category: "opencode-voice",
      description: "Choose transcription language (local whisper-cli only)",
      slash: { name: "stt-language" },
      onSelect() {
        const current = ctx.getLanguage(ctx.kv);
        ctx.api.ui.dialog.replace(() =>
          ctx.api.ui.DialogSelect({
            title: "Select transcription language",
            current,
            options: Object.entries(ctx.LANGUAGES).map(([key, v]) => ({
              title: v.label,
              value: key,
              onSelect() {
                ctx.kv.set("stt.language", key);
                // Language is part of the server key: drop the parked warm
                // lease so the next dictation starts the new configuration.
                if (!ctx.getStreamingActive()) ctx.disposeWarmStreamController();
                ctx.toast(`Whisper language: ${v.label}`);
                ctx.api.ui.dialog.clear();
              },
            })),
          }),
        );
      },
    },
    {
      title: "STT: select microphone",
      value: "stt.mic",
      category: "opencode-voice",
      description: "Choose audio input device",
      slash: { name: "stt-mic" },
      onSelect() {
        const remoteCmd =
          ctx.getSttCaptureCmd() || ctx.buildRemoteCaptureCmd(ctx.getRemoteConfig());
        const remoteConfigured = !!remoteCmd;
        const current = ctx.kv.get("stt.mic", "");
        const options = [];
        if (remoteConfigured) {
          options.push({
            title: "Phone (remote)",
            value: "remote",
            onSelect() {
              ctx.kv.set("stt.mic", "remote");
              ctx.toast("Mic: phone (remote)");
              ctx.api.ui.dialog.clear();
            },
          });
        }
        options.push({
          title: "System default",
          value: "",
          onSelect() {
            ctx.kv.set("stt.mic", "");
            ctx.toast("Mic: system default");
            ctx.api.ui.dialog.clear();
          },
        });
        const devices = ctx.backend === "remote" ? [] : ctx.listInputDevices(ctx.backend);
        for (const d of devices) {
          options.push({
            title: d.label,
            value: d.name,
            onSelect() {
              ctx.kv.set("stt.mic", d.name);
              ctx.toast(`Mic: ${d.label}`);
              ctx.api.ui.dialog.clear();
            },
          });
        }
        if (options.length <= 2 && !remoteConfigured) {
          ctx.toast("No local mic found. Run /stt-remote-setup to use a phone mic.", "warning");
          return;
        }
        ctx.api.ui.dialog.replace(() =>
          ctx.api.ui.DialogSelect({
            title: "Select microphone",
            current: remoteConfigured && current === "remote" ? "remote" : current,
            options,
          }),
        );
      },
    },
    {
      title: "STT: switch remote machine (phone / laptop / USB)",
      value: "stt.remote-host",
      category: "opencode-voice",
      description: "Pick which machine provides remote mic + speaker",
      slash: { name: "stt-remote-host" },
      onSelect() {
        const cur = ctx.getRemoteConfig();
        const pick = (label, sub, state) => ({
          title: label,
          value: `remote:${sub}`,
          description: `${state.host}:${state.port}`,
          onSelect() {
            applyRemoteConfig(ctx, state);
            ctx.api.ui.dialog.clear();
          },
        });
        ctx.api.ui.dialog.replace(() =>
          ctx.api.ui.DialogSelect({
            title: "Select remote machine",
            current: cur.host,
            options: [
              pick("Phone (Termux, tailnet)", "phone", {
                host: "u0_a368@100.107.124.2",
                port: 8022,
                key: cur.key,
                rate: cur.rate,
              }),
              pick("CachyOS laptop (tailnet)", "laptop", {
                host: "bojack@100.67.7.5",
                port: 22,
                key: cur.key,
                rate: cur.rate,
              }),
              pick("Phone over USB (adb forward)", "usb", {
                host: "u0_a368@127.0.0.1",
                port: 8022,
                key: cur.key,
                rate: cur.rate,
              }),
            ],
          }),
        );
      },
    },
    {
      title: "STT: set up remote (phone) mic",
      value: "stt.remote-setup",
      category: "opencode-voice",
      description: "Configure phone host/port/key for remote capture",
      slash: { name: "stt-remote-setup" },
      onSelect() {
        ctx.toast("Remote setup starting...");
        applyRemoteConfig(ctx, ctx.getRemoteConfig());
      },
    },
    {
      title: "STT: USB-forward phone mic (adb)",
      value: "stt.remote-usb",
      category: "opencode-voice",
      description: "Run adb forward tcp:8022 tcp:8022, then switch to the USB profile",
      slash: { name: "stt-remote-usb" },
      onSelect() {
        ctx.toast("Establishing USB forward...");
        // Argv-based, bounded, no shell. A configured stt.usbSerial wins;
        // otherwise a single attached device is used, never a guess.
        const fwd = ensureUsbForward({
          run: ctx.spawnSync,
          serial: ctx.kv.get("stt.usbSerial", null),
        });
        if (!fwd.ok) {
          ctx.toast(`adb forward failed: ${fwd.error}`, "error");
          return;
        }
        const cur = ctx.getRemoteConfig();
        applyRemoteConfig(ctx, usbRemoteProfile(cur));
      },
    },
    {
      title: "STT: forget remote (phone) mic",
      value: "stt.remote-forget",
      category: "opencode-voice",
      description: "Drop the remote profile and go back to local mic + speaker",
      slash: { name: "stt-remote-forget" },
      onSelect() {
        ctx.kv.set("stt.mic", "");
        ctx.kv.set("tts.output", "local");
        const prevMode = ctx.kv.get("stt.prevMode", null);
        if (prevMode != null) {
          ctx.kv.set("stt.mode", prevMode);
          ctx.kv.set("stt.prevMode", null);
        }
        ctx.toast("Back to local mic + speaker");
      },
    },
  ];

  return commands;
}
