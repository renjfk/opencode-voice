// Voice: cancel everything - a global panic button for in-flight voice work.
//
// One keypress stops whatever is running: batch STT recording (or the
// transcribe/normalize pipeline behind it), streaming dictation, TTS
// playback (or a pending normalize handoff), the voice-conversation loop,
// and live-notes capture (background-save semantics, like /voice-notes-cancel).
// Idle invocations never throw and toast "Nothing to cancel".

import { clearProcessingToast, clearStreamingToast } from "./stt.js";

export function registerVoiceCancel(api, opts, logger, { stt, tts, conversation, liveNotes }) {
  function toast(message, variant = "info") {
    api.ui.toast({ message, variant, duration: 3000 });
  }

  function guarded(fn) {
    try {
      return fn();
    } catch {
      return undefined;
    }
  }

  async function cancelEverything() {
    const cancelled = [];
    try {
      // TTS playback: stop() also invalidates a normalize handoff still in
      // flight via the speech generation guard.
      const wasSpeaking = guarded(() => tts?.isSpeaking?.()) === true;
      if (wasSpeaking) {
        guarded(() => tts?.stop?.());
        cancelled.push("TTS");
      }

      // Streaming dictation owns the mic; batch recording otherwise. A
      // transcribe/normalize pipeline with no active recording is still
      // cancelled via the same path (it bumps the pipeline generation so
      // the stale transcript never lands).
      const streaming = guarded(() => stt?.isStreaming?.()) === true;
      if (streaming) {
        await guarded(() => stt?.cancelStreaming?.());
        cancelled.push("streaming");
      } else {
        const busy =
          guarded(() => stt?.isRecording?.()) === true ||
          guarded(() => stt?.isProcessing?.()) === true;
        if (busy) {
          guarded(() => stt?.cancel?.());
          cancelled.push("recording");
        }
      }

      if (guarded(() => conversation?.isActive?.()) === true) {
        guarded(() => conversation?.stop?.("cancelled"));
        cancelled.push("conversation");
      }

      if (guarded(() => liveNotes?.isActive?.()) === true) {
        guarded(() => liveNotes?.cancel?.());
        cancelled.push("live notes");
      }

      guarded(() => clearProcessingToast());
      guarded(() => clearStreamingToast());

      if (cancelled.length > 0) {
        toast(`Cancelled: ${cancelled.join(", ")}`, "success");
      } else {
        toast("Nothing to cancel");
      }
      logger?.log?.("VOICE", `Cancel everything: ${cancelled.join(", ") || "idle"}`, "debug");
    } catch (err) {
      logger?.log?.("VOICE", `Cancel everything failed: ${err?.message || err}`, "error");
    }
  }

  const DEFAULT_KEYBINDS = {
    "voice.cancel": "<leader>.",
  };
  function kb(value) {
    const overrides = opts?.keybinds;
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
      return DEFAULT_KEYBINDS[value];
    }
    if (!Object.prototype.hasOwnProperty.call(overrides, value)) return DEFAULT_KEYBINDS[value];
    const v = overrides[value];
    if (!v || v === "none") return undefined;
    return v;
  }

  const commands = [
    {
      title: "Voice: cancel everything",
      value: "voice.cancel",
      category: "opencode-voice",
      description: "Stop any in-flight voice operation (recording, dictation, speech, loop, notes)",
      ...(kb("voice.cancel") ? { keybind: kb("voice.cancel") } : {}),
      slash: { name: "voice-cancel" },
      onSelect() {
        void cancelEverything();
      },
    },
  ];

  return { commands };
}
