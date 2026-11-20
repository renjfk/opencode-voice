// Extracted controller methods for registerSTT (Phase C1).
//
// Each factory takes one SttContext and returns the methods it owns. The
// closure variables it needs are reached through ctx getters/setters so the
// shared state stays identical to the original giant closure.

/**
 * @param {any} ctx
 */
export function createControllerMethods(ctx) {
  const isRecording = () => (typeof ctx.getRecording === "function" ? ctx.getRecording() : false);
  const isProcessing = () =>
    typeof ctx.getProcessing === "function" ? ctx.getProcessing() : false;
  const isStreaming = () =>
    typeof ctx.getStreamingActive === "function" ? ctx.getStreamingActive() : false;
  // Streaming stop in progress: no longer "active", but its text has not
  // landed yet, so a cancel must still go through cancelStreaming.
  const isFinalizing = () =>
    typeof ctx.finalizingController === "function" ? !!ctx.finalizingController() : false;

  const setAutoEnd = (enabled, onFinalize) => {
    if (enabled) {
      ctx.setSilenceAutoFinalize(2.5, typeof onFinalize === "function" ? onFinalize : null);
    } else {
      ctx.setSilenceAutoFinalize(null, null);
    }
  };

  const cancelTurnCleanup = () => {
    ctx.setSilenceAutoFinalize(null, null);
    ctx.setConversationStreamingFinalize(null, null);
  };

  const endTurn = () => {
    cancelTurnCleanup();
    try {
      ctx.setConversationStreamingEnabled(false);
    } catch {}
  };

  const start = () => ctx.startLoopRecording();

  const cancel = () => ctx.cancelRecording(ctx.logger);

  const submitTurnText = (text) => ctx.submitTurnText(text);

  const transcribeTurn = () => ctx.transcribeTurn();

  const startStreaming = () => ctx.startStreamingDictation();
  const finalizeStreaming = (opts) => ctx.finalizeStreamingDictation(opts || {});
  const cancelStreaming = () => ctx.cancelStreamingDictation();

  // Single turn-start entry point used by both dictation commands and the
  // voice conversation loop. Owns the streaming-vs-batch startup and the
  // silence auto-finalize wiring so callers do not re-implement it.
  // Returns { ok, streaming }.
  function startTurn(opts = {}) {
    const { streaming, autoEnd, onStreamFinalize, onSilenceFinalize, onBusy, source } = opts;
    const conv = source === "conversation";
    if (conv) {
      try {
        ctx.setConversationStreamingEnabled(true);
      } catch {}
    }
    const streamCb = typeof onStreamFinalize === "function" ? onStreamFinalize : null;
    const silenceCb = typeof onSilenceFinalize === "function" ? onSilenceFinalize : null;
    if (streaming) {
      ctx.setConversationStreamingFinalize(autoEnd ? 2.5 : null, streamCb);
      const started = ctx.startStreamingDictation();
      // startStreamingDictation is async: a Promise is always truthy, so a
      // refused/failed start used to report success with a dead mic. Keep
      // the sync contract and fall back to batch once the start settles.
      if (started && typeof started.then === "function") {
        started.then(
          (ok) => {
            if (!ok) batchFallback();
          },
          () => batchFallback(),
        );
        return { ok: true, streaming: true };
      }
      if (started) return { ok: true, streaming: true };
      return batchFallback();
    }
    if (autoEnd) {
      ctx.setSilenceAutoFinalize(2.5, silenceCb);
    } else {
      ctx.setSilenceAutoFinalize(null, null);
    }
    const ok = ctx.startLoopRecording();
    if (!ok) {
      if (typeof onBusy === "function") onBusy();
      return { ok: false, streaming: false };
    }
    return { ok: true, streaming: false };

    function batchFallback() {
      ctx.setConversationStreamingFinalize(null, null);
      if (autoEnd) {
        ctx.setSilenceAutoFinalize(2.5, silenceCb);
      } else {
        ctx.setSilenceAutoFinalize(null, null);
      }
      const ok = ctx.startLoopRecording();
      if (!ok) {
        if (typeof onBusy === "function") onBusy();
        return { ok: false, streaming: false };
      }
      return { ok: true, streaming: false };
    }
  }

  return {
    startTurn,
    isRecording,
    isProcessing,
    isStreaming,
    isFinalizing,
    isCorrecting: () => (typeof ctx.isCorrecting === "function" ? ctx.isCorrecting() : false),
    log: (msg) => (ctx.logger?.log ? ctx.logger.log("CONV", msg) : undefined),
    start,
    setSilenceAutoFinalize: ctx.setSilenceAutoFinalize,
    setConversationStreamingFinalize: ctx.setConversationStreamingFinalize,
    setConversationStreamingEnabled: ctx.setConversationStreamingEnabled,
    setAutoEnd,
    endTurn,
    cancelTurnCleanup,
    finalizeStreaming,
    setStopHint: (hint) =>
      typeof ctx.__setStopHint === "function" ? ctx.__setStopHint(hint) : undefined,
    cancel,
    discard: () => ctx.discardTurn(),
    transcribeTurn,
    submitTurnText,
    startStreaming,
    cancelStreaming,
  };
}
