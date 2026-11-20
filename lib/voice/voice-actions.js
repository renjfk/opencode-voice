// Voice action dispatcher: the ONE place that knows modes.
//
// Controllers (stt/tts/conversation/liveNotes) stay capability-only; all mode
// routing lives here. Every UI surface (keybind, slot button, cancel) calls
// these four methods instead of reaching into controllers, so a behavior
// change happens in exactly one place.

import { resolveSttAutoSubmit, toggleSttAutoSubmit } from "../shared/auto-submit.js";

/**
 * @param {{stt?: any, tts?: any, conversation?: any, liveNotes?: any, kv?: any, api?: any, options?: any, cmds?: {recordCmd?: Function, speakLastCmd?: Function, pauseCmd?: Function, cancelCmd?: Function, correctCmd?: Function}}} opts
 */
export function createVoiceActions({
  stt,
  tts,
  conversation,
  liveNotes,
  kv,
  api,
  options,
  cmds = {},
}) {
  function toast(message, variant = "info") {
    try {
      api?.ui?.toast?.({ message, variant, duration: 3000 });
    } catch {}
  }

  function mode() {
    if (conversation?.isActive?.()) return "conversation";
    if (liveNotes?.isActive?.()) return "notes";
    return "idle";
  }

  function toggleSpeak() {
    const m = mode();
    if (m === "conversation") {
      try {
        conversation?.onKey?.("record");
      } catch {}
      return;
    }
    if (m === "notes") {
      toast("Stop live notes first (/voice-notes-stop)", "warning");
      return;
    }
    // idle: run the original stt.record body
    try {
      cmds.recordCmd?.();
    } catch (err) {
      toast(`STT failed: ${err?.message || err}`, "error");
    }
  }

  function speakReply() {
    const m = mode();
    // Replay acts as its own toggle: while audio is playing, the same button
    // stops it (and turns red like Speak), so a tap is never ambiguous.
    if (m !== "conversation") {
      const speaking = typeof tts?.isSpeaking === "function" && tts.isSpeaking() === true;
      if (speaking) {
        try {
          tts?.stop?.();
          toast("Replay stopped");
        } catch (err) {
          toast(`TTS stop failed: ${err?.message || err}`, "error");
        }
        return;
      }
    }
    const phase =
      m === "conversation" && typeof conversation?.getPhase === "function"
        ? conversation.getPhase()
        : null;
    if (m === "conversation") {
      if (phase === "paused") {
        try {
          cmds.speakLastCmd?.();
        } catch (err) {
          toast(`TTS failed: ${err?.message || err}`, "error");
        }
        return;
      }
      if (phase === "speaking" || phase === "waiting") {
        toast("Agent holds the floor - press the mic button to take it", "warning");
        return;
      }
      // recording / processing
      toast("Mic is yours - finish or stop recording first", "warning");
      return;
    }
    // notes or idle
    try {
      cmds.speakLastCmd?.();
    } catch (err) {
      toast(`TTS failed: ${err?.message || err}`, "error");
    }
  }

  async function stopAll() {
    const cancelled = [];
    try {
      const wasSpeaking =
        (typeof tts?.isSpeaking === "function" ? tts.isSpeaking() : false) === true;
      if (wasSpeaking) {
        try {
          tts?.stop?.();
        } catch {}
        cancelled.push("TTS");
      }
      const streaming =
        (typeof stt?.isStreaming === "function" ? stt.isStreaming() : false) === true ||
        (typeof stt?.isFinalizing === "function" ? stt.isFinalizing() : false) === true;
      if (streaming) {
        try {
          await stt?.cancelStreaming?.();
        } catch {}
        cancelled.push("streaming");
      } else {
        const busy =
          (typeof stt?.isRecording === "function" && stt.isRecording()) ||
          (typeof stt?.isProcessing === "function" && stt.isProcessing());
        if (busy) {
          try {
            stt?.cancel?.();
          } catch {}
          cancelled.push("recording");
        }
      }
      if (typeof conversation?.isActive === "function" && conversation.isActive()) {
        try {
          conversation?.stop?.("cancelled");
        } catch {}
        cancelled.push("conversation");
      }
      if (typeof liveNotes?.isActive === "function" && liveNotes.isActive()) {
        try {
          liveNotes?.cancel?.();
        } catch {}
        cancelled.push("live notes");
      }
      try {
        const { clearProcessingToast, clearStreamingToast } = await import("../stt.js");
        clearProcessingToast?.();
        clearStreamingToast?.();
      } catch {}
      if (cancelled.length > 0) {
        toast(`Cancelled: ${cancelled.join(", ")}`, "success");
      } else {
        toast("Nothing to cancel");
      }
    } catch (err) {
      toast(`Cancel failed: ${err?.message || err}`, "error");
    }
    return cancelled;
  }

  function togglePause() {
    const m = mode();
    if (m === "conversation") {
      try {
        if (conversation?.onTtsStop?.() === true) return;
      } catch {}
    }
    // fall through to tts pause/resume
    try {
      const state =
        (typeof tts?.getState === "function" ? tts.getState?.() : null) ||
        (typeof tts?.player?.getState === "function" ? tts.player.getState() : null);
      if (state?.status === "playing") {
        if (tts?.pause?.()) toast("Paused");
      } else if (state?.status === "paused") {
        if (tts?.resume?.()) toast("Resumed");
      } else {
        toast("Nothing playing", "warning");
      }
    } catch {
      toast("Nothing playing", "warning");
    }
  }

  function isAutoSubmit() {
    return resolveSttAutoSubmit(options, kv);
  }

  // One place that owns the auto-submit flag. The /stt-autosubmit command
  // and the quick-action Auto button both come here (the command historically
  // wrote a different key that nothing read - fixed to this one).
  function toggleAutoSubmit() {
    let next;
    try {
      next = toggleSttAutoSubmit(options, kv);
    } catch {
      toast("Could not save auto-submit setting", "error");
      return isAutoSubmit();
    }
    if (mode() === "conversation") {
      toast(
        `Auto-submit ${next ? "on" : "off"} (dictation only - conversation turns always submit)`,
        "warning",
      );
    } else {
      toast(`STT auto-submit: ${next ? "on" : "off"}`);
    }
    return next;
  }

  // Dictation-only: re-speak a misheard phrase to replace the last insert.
  // The command owns recording; the dispatcher only routes, like toggleSpeak.
  function correct() {
    if (mode() === "conversation") {
      toast("Correction is dictation-only - conversation owns the mic", "warning");
      return;
    }
    if (mode() === "notes") {
      toast("Stop live notes first (/voice-notes-stop)", "warning");
      return;
    }
    try {
      cmds.correctCmd?.();
    } catch (err) {
      toast(`Correction failed: ${err?.message || err}`, "error");
    }
  }

  return {
    mode,
    toggleSpeak,
    speakReply,
    stopAll,
    togglePause,
    isAutoSubmit,
    toggleAutoSubmit,
    correct,
  };
}
