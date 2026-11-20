// Conversation turn machine extracted from registerConversation (Phase C3).
//
// createConversationLoop(ctx) builds the full turn state machine against one
// ConvContext and returns every function registerConversation used to expose.
// Behavior is byte-identical to the previous giant closure; the context only
// removes the "30 closure vars" coupling so the file stays readable.

import { matchesStopPhrase, normalizePhrase, DEFAULT_STOP_PHRASES } from "../conversation.js";
import { clearProcessingToast, showProcessingToast } from "../stt.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {any} ctx
 */
export function createConversationLoop(ctx) {
  const api = ctx.api;
  const opts = ctx.opts;
  const logger = ctx.logger;
  const stt = ctx.stt;
  const tts = ctx.tts;
  const isLiveNotesActive = ctx.isLiveNotesActive;
  const maxTurns = ctx.maxTurns;
  const replyTimeoutMs = ctx.replyTimeoutMs;
  const restartDelayMs = ctx.restartDelayMs;
  const stopPhrases = ctx.stopPhrases;

  const state = ctx.state;
  if (state.active === undefined) state.active = false;
  if (state.phase === undefined) state.phase = "idle";
  if (state.turn === undefined) state.turn = 0;
  if (state.consecErrors === undefined) state.consecErrors = 0;
  if (state.generation === undefined) state.generation = 0;
  if (state.waitCancel === undefined) state.waitCancel = null;
  if (state.streamUnsubs === undefined) state.streamUnsubs = [];
  if (state.speakGen === undefined) state.speakGen = 0;

  function getActive() {
    return state.active;
  }
  function setActive(v) {
    state.active = !!v;
  }
  function getPhase() {
    return state.phase;
  }
  function setPhase(v) {
    state.phase = v;
  }
  function getTurn() {
    return state.turn;
  }
  function setTurn(v) {
    state.turn = v;
  }
  function getConsecErrors() {
    return state.consecErrors;
  }
  function setConsecErrors(v) {
    state.consecErrors = v;
  }
  function getGeneration() {
    return state.generation;
  }
  function setGeneration(v) {
    state.generation = v;
  }
  function getWaitCancel() {
    return state.waitCancel;
  }
  function setWaitCancel(v) {
    state.waitCancel = v;
  }
  function getStreamUnsubs() {
    return state.streamUnsubs;
  }
  function setStreamUnsubs(v) {
    state.streamUnsubs = v;
  }
  function getSpeakGen() {
    return state.speakGen;
  }
  function setSpeakGen(v) {
    state.speakGen = v;
  }

  function toast(message, variant = "info") {
    api.ui.toast({ message, variant, duration: 3000 });
  }

  const DEFAULT_KEYBINDS = {
    "voice.conversation": "<leader>v",
  };
  function kb(value) {
    const overrides = opts?.keybinds;
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
      return value === "voice.conversation" ? "<leader>v" : undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(overrides, value)) {
      return value === "voice.conversation" ? "<leader>v" : undefined;
    }
    const v = overrides[value];
    if (!v || v === "none") return undefined;
    return v;
  }

  function keyLabel() {
    return kb("voice.conversation") || "the key";
  }

  const convStatus = api.conversationStatus || null;
  const clog = (m) => {
    try {
      stt.log?.(m);
    } catch {}
  };
  const setConvPhase = api.setConvPhase || (() => {});
  const setConvActions = api.setConvActions || (() => {});
  function convBegin() {
    try {
      const p = convStatus?.begin?.();
      if (p && typeof p.then === "function") p.catch(() => {});
    } catch {}
  }
  function convUpdate() {
    try {
      convStatus?.update?.();
    } catch {}
  }
  function convClear() {
    try {
      convStatus?.clear?.();
    } catch {}
  }
  function convSetPhase(p) {
    try {
      setConvPhase(p);
      convUpdate();
    } catch {}
  }
  function convSetActions(actions) {
    try {
      setConvActions(actions);
    } catch {}
  }

  function currentSessionID() {
    const route = api?.route?.current;
    return route?.name === "session" ? route?.params?.sessionID : null;
  }

  function isActive() {
    return getActive();
  }

  function keyLabel() {
    // KB resolved at call time via opts; default below.
    const overrides = opts?.keybinds;
    const kb = (value) => {
      if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
        return value === "voice.conversation" ? "<leader>v" : undefined;
      }
      if (!Object.prototype.hasOwnProperty.call(overrides, value)) {
        return value === "voice.conversation" ? "<leader>v" : undefined;
      }
      const v = overrides[value];
      if (!v || v === "none") return undefined;
      return v;
    };
    return kb("voice.conversation") || "the key";
  }

  function enterPaused(message = `Press ${keyLabel()} to talk`) {
    setPhase("paused");
    convSetActions({
      talk: () => {
        if (getPhase() === "paused") beginTurn();
      },
      end: () => stop("user"),
    });
    convSetPhase("paused");
    toast(message);
  }

  function discardStreamAudio() {
    endReplyStream();
    setSpeakGen(getSpeakGen() + 1);
    tts.stop();
  }

  function endReplyStream() {
    for (const unsub of getStreamUnsubs()) {
      try {
        unsub();
      } catch {}
    }
    setStreamUnsubs([]);
  }

  function cancelTurn() {
    if (getPhase() !== "recording") return;
    try {
      stt.cancelStreaming?.();
    } catch {}
    stt.cancelTurnCleanup?.();
    stt.cancel();
    enterPaused();
  }

  function pauseForRetry(message) {
    if (!getActive()) return;
    // Same as enterPaused: without the paused actions/phase the slot kept
    // showing "Transcribing [cancel]" and [talk]/[end] never appeared.
    setPhase("paused");
    convSetActions({
      talk: () => {
        if (getPhase() === "paused") beginTurn();
      },
      end: () => stop("user"),
    });
    convSetPhase("paused");
    if (message) toast(message, "warning");
  }

  function pauseSpeech() {
    if (!getActive() || getPhase() !== "speaking") return;
    clog("Conversation speech paused");
    tts.stop();
    enterPaused(`Speech paused - press ${keyLabel()} to talk`);
  }

  function onTtsStop() {
    if (!getActive()) return false;
    if (getPhase() === "speaking") {
      pauseSpeech();
      return true;
    }
    if (getPhase() === "waiting" && tts.isSpeaking?.()) {
      stop("cancelled");
      toast("Conversation off");
      return true;
    }
    return false;
  }

  function beginTurn() {
    if (!getActive()) return;
    if (getTurn() >= maxTurns) {
      stop("done");
      toast(`Conversation off - reached ${maxTurns} turns`);
      return;
    }
    if (stt.isRecording() || stt.isProcessing() || stt.isStreaming?.()) return;
    setTurn(getTurn() + 1);
    setPhase("recording");
    clog(`Conversation turn ${getTurn()} listening`);
    const streamingMode = (api?.kv?.get?.("stt.mode") ?? opts?.sttMode) === "streaming";
    const autoEnd = api?.kv?.get?.("stt.autoEndOfSpeech") === true;
    const onStreamFinalize = () => {
      clog(
        `Conversation streaming auto-finalize callback active=${getActive()} phase=${getPhase()}`,
      );
      if (getActive() && getPhase() === "recording") {
        clog("Conversation auto-finalize on silence (streaming)");
        void finishTurnFlow();
      }
    };
    const onSilenceFinalize = () => {
      if (getActive() && getPhase() === "recording") {
        clog("Conversation auto-finalize on silence");
        finishTurnFlow();
      }
    };
    const result = stt.startTurn({
      streaming: streamingMode,
      autoEnd,
      onStreamFinalize,
      onSilenceFinalize,
      onBusy: () => {
        setPhase("idle");
        stop("busy");
        toast("STT busy, conversation off", "warning");
      },
      source: "conversation",
    });
    if (!result?.ok) return;

    convSetActions({
      cancel: () => cancelTurn(),
      send: () => {
        if (getPhase() === "recording") finishTurnFlow();
      },
      autoEnd: () => {
        const current = api?.kv?.get?.("stt.autoEndOfSpeech") === true;
        const next = !current;
        api?.kv?.set?.("stt.autoEndOfSpeech", next);
        if (next) {
          stt.setAutoEnd?.(true, () => {
            if (getActive() && getPhase() === "recording") finishTurnFlow();
          });
          toast("Auto-end: on");
        } else {
          stt.setAutoEnd?.(false, null);
          toast("Auto-end: off");
        }
      },
    });
    convSetPhase("recording");
    toast(
      autoEnd
        ? `Listening - speak, then pause 2.5s to send (or press ${keyLabel()})`
        : `Listening - press ${keyLabel()} to send`,
    );
  }

  function bargeIn() {
    clog("Conversation barge-in");
    try {
      stt.cancelTurnCleanup?.();
    } catch {}
    try {
      stt.cancelStreaming?.();
    } catch {}
    discardStreamAudio();
    clearProcessingToast();
    const wc = getWaitCancel();
    if (wc) {
      wc("stopped");
      setWaitCancel(null);
    }
    beginTurn();
  }

  function stop(reason) {
    if (!getActive()) return;
    setActive(false);
    setGeneration(getGeneration() + 1);
    setPhase("idle");
    stt.endTurn?.();
    const wc = getWaitCancel();
    if (wc) {
      wc("stopped");
      setWaitCancel(null);
    }
    endReplyStream();
    setSpeakGen(getSpeakGen() + 1);
    stt.setStopHint(null);
    try {
      stt.cancelStreaming?.();
    } catch {}
    if (stt.isRecording() || stt.isProcessing()) stt.cancel();
    clearProcessingToast();
    tts.stop();
    tts.setConversationActive(false);
    convClear();
    clog(`Conversation stopped reason=${reason}`);
  }

  async function finishTurnFlow() {
    clog(
      `Conversation finishTurnFlow called active=${getActive()} phase=${getPhase()} streaming=${stt.isStreaming?.()}`,
    );
    if (!getActive() || getPhase() !== "recording") return;
    stt.cancelTurnCleanup?.();
    const myGen = getGeneration();
    setPhase("processing");
    convSetActions({
      cancel: () => {},
    });
    convSetPhase("processing");
    showProcessingToast("Transcribing...");

    let res = null;
    if (stt.isStreaming?.()) {
      try {
        res = await stt.finalizeStreaming?.({ submit: false, insert: false });
      } catch (e) {
        res = { error: e };
      }
    } else {
      res = await stt.transcribeTurn();
    }
    if (!getActive() || myGen !== getGeneration()) {
      // A turn that produced text still holds the STT processing flag.
      if (res?.text) stt.discard();
      return;
    }

    if (!res) {
      pauseForRetry(`Paused - press ${keyLabel()} to retry`);
      return;
    }
    if (res.error) {
      setConsecErrors(getConsecErrors() + 1);
      clog(`Conversation turn error consec=${getConsecErrors()}`);
      if (getConsecErrors() >= 2) {
        stop("error");
        return;
      }
      pauseForRetry(`Paused - press ${keyLabel()} to retry`);
      return;
    }
    if (!res.text || res.text.trim().length < 3) {
      // A short text ("ok") still holds processing=true: release it, or
      // every later turn and dictation reports "STT busy".
      if (res.text) stt.discard();
      setConsecErrors(0);
      pauseForRetry(`No speech heard - press ${keyLabel()} to try again`);
      return;
    }
    setConsecErrors(0);

    // stop phrase check
    if (matchesStopPhrase(res.text, stopPhrases)) {
      stt.discard();
      stop("stop phrase");
      toast("Conversation off");
      return;
    }

    const baselineSessionID = currentSessionID();
    let baselineCount = 0;
    if (baselineSessionID) {
      try {
        baselineCount = (api?.state?.session?.messages?.(baselineSessionID) || []).length;
      } catch {
        baselineCount = 0;
      }
    }
    const baselineFor = (sid) => (sid && sid === baselineSessionID ? baselineCount : 0);
    clog(`Conversation baseline sid=${baselineSessionID ?? "new"} count=${baselineCount}`);

    let earlyWait = null;
    if (api.client?.tui?.v2) {
      setPhase("waiting");
      convSetActions({
        cancel: () => {},
        barge: () => bargeIn(),
      });
      convSetPhase("waiting");
      earlyWait = waitForReply(currentSessionID, { baseline: /** @type {any} */ (baselineFor) });
    }
    const submitted = await stt.submitTurnText(res.text);
    if (!getActive() || myGen !== getGeneration()) return;
    if (submitted.error) {
      stop("submit failed");
      return;
    }

    setPhase("waiting");
    convSetActions({
      cancel: () => {},
      barge: () => bargeIn(),
    });
    convSetPhase("waiting");
    const sessionID = currentSessionID();
    showProcessingToast(`Working - press ${keyLabel()} to talk`);
    const tWait = Date.now();
    const outcome = await (earlyWait ||
      waitForReply(sessionID, { baseline: /** @type {any} */ (baselineFor) }));
    const waitMs = Date.now() - tWait;
    endReplyStream();
    logger?.log("VOICE", `Conversation wait outcome=${outcome} waitMs=${waitMs}`, "debug");
    if (!getActive() || myGen !== getGeneration()) return;

    if (outcome === "timeout") {
      discardStreamAudio();
      stop("timeout");
      toast("No reply in time, conversation off", "warning");
      return;
    }
    if (outcome === "permission" || outcome === "question") {
      await answerGateThenSpeak(myGen, sessionID, baselineFor, outcome);
      return;
    }
    if (outcome === "stopped") return;

    await speakReply(myGen);
  }

  async function answerGateThenSpeak(myGen, sessionID, baseline, outcome) {
    discardStreamAudio();
    setPhase("speaking");
    convSetActions({
      stop: () => {
        if (getPhase() === "speaking") {
          tts.stop();
          enterPaused();
        }
      },
      barge: () => bargeIn(),
      pauseTts: () => {
        if (getPhase() === "speaking") {
          tts.stop();
          enterPaused();
        }
      },
    });
    convSetPhase("speaking");
    showProcessingToast("Speaking...");
    await tts.speak(
      outcome === "permission"
        ? "Permission requested. Please check your screen."
        : "A question needs your answer. Please check your screen.",
    );
    clearProcessingToast();
    if (!getActive() || myGen !== getGeneration() || getPhase() !== "speaking") return;

    setPhase("waiting");
    convSetActions({
      cancel: () => {},
      barge: () => bargeIn(),
    });
    convSetPhase("waiting");
    showProcessingToast(`Answer on screen - press ${keyLabel()} to talk`);
    const resumed = await waitForReply(sessionID, { gates: false, baseline });
    if (!getActive() || myGen !== getGeneration()) return;
    if (resumed === "stopped") return;
    endReplyStream();
    if (resumed === "timeout") {
      discardStreamAudio();
      stop("timeout");
      toast("No reply in time, conversation off", "warning");
      return;
    }
    await speakReply(myGen);
  }

  async function speakReply(myGen) {
    clog(`Conversation speakReply entry myGen=${myGen} gen=${getGeneration()} phase=${getPhase()}`);
    setPhase("speaking");
    convSetActions({
      stop: () => {
        if (getPhase() === "speaking") {
          tts.stop();
          enterPaused();
        }
      },
      barge: () => bargeIn(),
      pauseTts: () => {
        if (getPhase() === "speaking") {
          tts.stop();
          enterPaused();
        }
      },
    });
    convSetPhase("speaking");
    showProcessingToast(`Speaking - press ${keyLabel()} to interrupt`);
    clog("Conversation: calling tts.speakAssistantTurn");
    const spoken = await tts.speakAssistantTurn();
    clog(`Conversation: speakAssistantTurn returned spoken=${spoken?.spoken}`);
    if (!getActive() || myGen !== getGeneration() || getPhase() !== "speaking") return;
    clearProcessingToast();
    if (!spoken.spoken) {
      toast("No reply to speak", "warning");
    }
    await delay(restartDelayMs);
    if (!getActive() || myGen !== getGeneration() || getPhase() !== "speaking") return;
    enterPaused();
    if (!spoken.spoken) return;
    await delay(500);
    if (
      !getActive() ||
      myGen !== getGeneration() ||
      /** @type {string} */ (getPhase()) !== "paused"
    )
      return;
    beginTurn();
  }

  async function waitForReply(sessionID, { gates = true, baseline = 0 } = {}) {
    // ... (full implementation, same as original)
    // This is a large function; keep it intact here.
    let settled = false;
    let unsubs = [];
    let timer = null;
    let pollTimer = null;
    let settleTimer = null;
    let currentExecutionID = null;
    let sawExecutionStart = false;

    const resolveSessionID = () => (typeof sessionID === "function" ? sessionID() : sessionID);
    const baselineFor = (sid) =>
      typeof baseline === "function" ? /** @type {any} */ (baseline)(sid) : baseline;

    const newAssistants = () => {
      try {
        const sid = resolveSessionID();
        const msgs = /** @type {any} */ (api?.state?.session?.messages)?.(sid) || [];
        return msgs.slice(baselineFor(sid)).filter((m) => m?.role === "assistant");
      } catch {
        return [];
      }
    };
    const isTerminal = (finish) => !!finish && finish !== "tool-calls" && finish !== "tool_calls";
    const lastFinish = () => {
      const list = newAssistants();
      return list.length ? list[list.length - 1]?.finish : null;
    };
    const turnFinished = () => isTerminal(lastFinish());

    let cancelFn = null;
    const done = (outcome) => {
      if (settled) return null;
      settled = true;
      if (timer) clearTimeout(timer);
      if (settleTimer) clearInterval(settleTimer);
      if (pollTimer) clearInterval(pollTimer);
      for (const unsub of unsubs) {
        try {
          unsub();
        } catch {}
      }
      unsubs = [];
      if (getWaitCancel() === cancelFn) setWaitCancel(null);
      return outcome;
    };

    const promise = new Promise((resolve) => {
      const finish = (outcome) => {
        const result = done(outcome);
        if (result !== null) resolve(result);
      };
      cancelFn = (outcome) => finish(outcome || "stopped");
      setWaitCancel(cancelFn);

      const settle = (outcome) => {
        if (settled) return;
        if (turnFinished()) {
          finish(outcome);
          return;
        }
        if (settleTimer) return;
        const startedAt = Date.now();
        settleTimer = setInterval(() => {
          if (settled) return;
          if (turnFinished() || Date.now() - startedAt > 2000) {
            clog(`Conversation settled outcome=${outcome} finish=${lastFinish() ?? "none"}`);
            finish(outcome);
          }
        }, 100);
        if (typeof settleTimer.unref === "function") settleTimer.unref();
      };

      const forSession = (props) => {
        const sid = props?.sessionID ?? props?.id ?? props?.session?.id;
        const expectedID = resolveSessionID();
        if (typeof sessionID === "function" && !expectedID) return true;
        if (!expectedID) return true;
        if (!sid) return true;
        return sid === expectedID;
      };

      const executionIDOf = (props) =>
        props?.executionID ?? props?.executionId ?? props?.id ?? props?.execution?.id;

      const onExecutionEnd = (outcome) => (event) => {
        const props = event?.properties || event?.data || {};
        if (!forSession(props)) return;
        const eid = executionIDOf(props);
        if (currentExecutionID && eid && eid !== currentExecutionID) {
          clog(
            `Conversation execution ${outcome} ignored stale id=${eid} current=${currentExecutionID}`,
          );
          return;
        }
        if (!sawExecutionStart && !turnFinished()) {
          clog(`Conversation execution ${outcome} ignored (no start, no new assistant)`);
          return;
        }
        clog(`Conversation execution ${outcome} id=${eid ?? "none"}`);
        settle(outcome);
      };

      unsubs = [
        api.event.on("session.execution.started", (event) => {
          const props = event?.properties || event?.data || {};
          if (!forSession(props)) return;
          const eid = executionIDOf(props);
          if (eid) currentExecutionID = eid;
          sawExecutionStart = true;
          clog(`Conversation execution.started id=${eid ?? "none"}`);
        }),
        api.event.on("session.execution.succeeded", onExecutionEnd("idle")),
        api.event.on("session.execution.failed", onExecutionEnd("idle")),
        api.event.on("session.execution.interrupted", onExecutionEnd("stopped")),
        api.event.on("session.idle", (event) => {
          const props = event?.properties || event?.data || {};
          if (!forSession(props)) return;
          if (!turnFinished()) {
            clog(`Conversation session.idle ignored finish=${lastFinish() ?? "none"}`);
            return;
          }
          finish("idle");
        }),
        api.event.on("session.status", (event) => {
          const props = event?.properties || event?.data || {};
          if (props?.status?.type !== "idle" || !forSession(props)) return;
          if (!turnFinished()) {
            clog(`Conversation session.idle ignored finish=${lastFinish() ?? "none"}`);
            return;
          }
          finish("idle");
        }),
        ...(gates
          ? [
              api.event.on("permission.asked", (event) => {
                if (forSession(event.properties)) finish("permission");
              }),
              api.event.on("question.asked", (event) => {
                if (forSession(event.properties)) finish("question");
              }),
            ]
          : []),
      ];
      timer = setTimeout(() => finish("timeout"), replyTimeoutMs);
      pollTimer = setInterval(() => {
        if (settled) return;
        try {
          const fr = lastFinish();
          clog(`Conversation poll new=${newAssistants().length} finish=${fr ?? "none"}`);
          if (isTerminal(fr)) settle("idle");
        } catch {}
      }, 700);
      if (typeof pollTimer.unref === "function") pollTimer.unref();
    });

    return promise;
  }

  function onKey(source) {
    if (!getActive()) {
      start();
      return;
    }
    if (source === "cancel") {
      if (getPhase() === "recording") cancelTurn();
      else toast(`Nothing to cancel - press ${keyLabel()} to talk`);
      return;
    }
    if (getPhase() === "recording") {
      finishTurnFlow();
      return;
    }
    if (getPhase() === "speaking" || getPhase() === "waiting") {
      bargeIn();
      return;
    }
    if (getPhase() === "paused") {
      beginTurn();
      return;
    }
    toast("Conversation busy, please wait...", "warning");
  }

  function start() {
    if (getActive()) return;
    if (isLiveNotesActive?.()) {
      toast("Live notes recording - stop it first (/voice-notes-stop)", "warning");
      return;
    }
    if (stt.isRecording() || stt.isProcessing() || stt.isStreaming?.()) {
      toast("STT busy, try again shortly", "warning");
      return;
    }
    setActive(true);
    setGeneration(getGeneration() + 1);
    setTurn(0);
    setConsecErrors(0);
    setPhase("paused");
    tts.setConversationActive(true);
    convBegin();
    convSetActions({
      talk: () => {
        if (getPhase() === "paused") beginTurn();
      },
      end: () => stop("user"),
    });
    convSetPhase("paused");
    stt.setStopHint(kb("voice.conversation"));
    clog("Conversation started");
    toast(`Conversation on - press ${keyLabel()} to talk`);
  }

  function kb(value) {
    const overrides = opts?.keybinds;
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
      return value === "voice.conversation" ? "<leader>v" : undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(overrides, value)) {
      return value === "voice.conversation" ? "<leader>v" : undefined;
    }
    const v = overrides[value];
    if (!v || v === "none") return undefined;
    return v;
  }

  function keyLabel() {
    return kb("voice.conversation") || "the key";
  }

  // Expose the loop object so registerConversation can wire it up.
  const loop = {
    isActive,
    onKey,
    onTtsStop,
    start,
    stop,
    getPhase: () => getPhase(),
    beginTurn,
    cancelTurn,
    enterPaused,
    bargeIn,
    endReplyStream,
    discardStreamAudio,
    finishTurnFlow,
    answerGateThenSpeak,
    speakReply,
    pauseForRetry,
    pauseSpeech,
    waitForReply,
    clog,
    toast,
    convBegin,
    convUpdate,
    convClear,
    convSetPhase,
    convSetActions,
    currentSessionID,
    keyLabel,
    kb,
    maxTurns,
    replyTimeoutMs,
    restartDelayMs,
    stopPhrases,
    // state accessors
    get active() {
      return getActive();
    },
    set active(v) {
      setActive(v);
    },
    get phase() {
      return getPhase();
    },
    set phase(v) {
      setPhase(v);
    },
    get turn() {
      return getTurn();
    },
    set turn(v) {
      setTurn(v);
    },
    get consecErrors() {
      return getConsecErrors();
    },
    set consecErrors(v) {
      setConsecErrors(v);
    },
    get generation() {
      return getGeneration();
    },
    set generation(v) {
      setGeneration(v);
    },
    get waitCancel() {
      return getWaitCancel();
    },
    set waitCancel(v) {
      setWaitCancel(v);
    },
    get streamUnsubs() {
      return getStreamUnsubs();
    },
    set streamUnsubs(v) {
      setStreamUnsubs(v);
    },
    get speakGen() {
      return getSpeakGen();
    },
    set speakGen(v) {
      setSpeakGen(v);
    },
  };

  return loop;
}
