// Voice conversation mode: push-to-talk turns with barge-in.
//
// One key drives the whole loop and its meaning is always the same: the user
// wants the floor. What the key actually does depends on the state shown in
// the toast:
//
//   press -> record -> press -> transcribe -> normalize -> submit
//         -> wait reply -> speak -> press -> record ...
//
// - paused + key: open the mic (the resting state is the user's turn)
// - recording + key: finish the turn and submit
// - speaking/waiting + key: barge in - cut the audio, drop the pending reply,
//   open the mic (one press, never a stop-then-record dance)
// - processing + key: transcription is too short to interrupt, report busy
//
// The loop never reopens the mic by itself: after a reply is spoken the mode
// rests paused, so it can never record the room while nobody is talking. That
// auto-record is also why a question/permission gate used to eat the answer -
// the mic opened, the user's muttering was submitted, and the real reply was
// already torn down. Gates now announce and wait instead.
//
// Exit paths: a stop phrase ("stop", "dừng lại", ...), /voice-conversation-stop,
// or the global /voice-cancel. Empty or failed turns pause instead of
// auto-recording, so the key never surprises.
//
// Latency: while waiting, assistant text deltas are spoken sentence by
// sentence (local cleanup, no LLM), so the answer starts before the turn
// completes. Replies with nothing streamable fall back to the full
// LLM-narrated speak.

import { clearProcessingToast, showProcessingToast } from "./stt.js";
import { isSpeakableSentence, localSpeechCleanup, splitSpokenSentences } from "./tts.js";

export const DEFAULT_STOP_PHRASES = [
  "stop",
  "exit",
  "quit",
  "stop conversation",
  "exit conversation",
  "end conversation",
  "goodbye",
  "bye",
  "dừng lại",
  "dừng",
  "kết thúc",
  "kết thúc hội thoại",
  "thoát",
  "tạm biệt",
];

export function normalizePhrase(text) {
  return (text || "")
    .trim()
    .toLowerCase()
    .replace(/[.!…?]+$/u, "")
    .replace(/\s+/g, " ");
}

// Small vocabulary so stuttered/short stop commands ("stop stop", "please stop
// the conversation now", "dừng lại đi") still match, while real sentences
// ("stop the server", "do not stop") fall through and get submitted.

const STOP_VOCAB = new Set(
  (
    "stop stops stopping please now exit quit quits quitting end ends ending finish " +
    "conversation voice chat goodbye bye good the this that it turn off mode " +
    "dừng lại kết thúc hội thoại thoát tạm biệt đi ra ngừng ngưng thôi"
  ).split(" "),
);
const MAX_STOP_WORDS = 5;

export function matchesStopPhrase(text, phrases) {
  const normalized = normalizePhrase(text);
  if (!normalized) return false;
  if ((phrases ?? DEFAULT_STOP_PHRASES).some((p) => normalizePhrase(p) === normalized)) return true;
  // Lenient vocab match only applies to the default list; a custom list takes
  // full control with exact matching.
  if (phrases !== undefined) return false;
  const words = normalized
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean);
  return (
    words.length > 0 && words.length <= MAX_STOP_WORDS && words.every((w) => STOP_VOCAB.has(w))
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerConversation(api, opts, logger, { stt, tts, isLiveNotesActive }) {
  const maxTurns = Number(opts?.conversationMaxTurns) > 0 ? Number(opts.conversationMaxTurns) : 50;
  const replyTimeoutMs =
    Number(opts?.conversationTimeoutMs) > 0 ? Number(opts.conversationTimeoutMs) : 300000;
  const restartDelayMs =
    Number(opts?.conversationRestartDelayMs) >= 0 ? Number(opts.conversationRestartDelayMs) : 350;
  // Keep undefined when the user supplied nothing so matchesStopPhrase
  // takes the lenient default-vocabulary path ("stop stop", "dừng lại đi").
  // Passing DEFAULT_STOP_PHRASES explicitly would disable it.
  const stopPhrases = Array.isArray(opts?.conversationStopPhrases)
    ? opts.conversationStopPhrases
    : undefined;

  let active = false;
  let phase = "idle"; // idle | recording | processing | waiting | speaking | paused

  // Reply streaming state: text deltas heard while the agent works are spoken
  // sentence by sentence through a serial queue, so the answer starts before
  // the turn completes and every sentence gets its own vi/en voice.

  let streamBuffer = "";
  let streamSpokenChars = 0;
  let streamUnsubs = [];
  let speakTail = Promise.resolve();
  let speakGen = 0;

  function queueSpeak(sentence) {
    const g = speakGen;
    speakTail = speakTail.then(() => {
      // Speaking must also drain: finishTurnFlow flips to speaking before
      // flushing the tail, so a waiting-only guard would skip queued
      // sentences/final partials under real TTS latency. speakGen still
      // invalidates on pause/stop.
      if (g !== speakGen || !active || (phase !== "waiting" && phase !== "speaking")) return null;
      return tts.speak(sentence);
    });
    return speakTail;
  }
  let turn = 0;
  let consecErrors = 0;
  let generation = 0;
  let waitCancel = null;

  function toast(message, variant = "info") {
    api.ui.toast({ message, variant, duration: 3000 });
  }

  // v2 persistent status line: phase-aware buttons. v1 has no surface, so
  // these are no-ops there (api.conversationStatus is undefined).
  const convStatus = api.conversationStatus || null;
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
    return active;
  }

  function beginTurn() {
    if (!active) return;
    if (turn >= maxTurns) {
      stop("done");
      toast(`Conversation off - reached ${maxTurns} turns`);
      return;
    }
    if (stt.isRecording() || stt.isProcessing() || stt.isStreaming?.()) return;
    turn += 1;
    phase = "recording";
    logger?.log("VOICE", `Conversation turn ${turn} listening`, "debug");
    // Hands-free: auto-finalize after N seconds of silence so the user
    // never has to press a key to submit.
    stt.setSilenceAutoFinalize?.(1.5, () => {
      if (active && phase === "recording") {
        logger?.log("VOICE", "Conversation auto-finalize on silence", "debug");
        finishTurnFlow();
      }
    });
    convSetActions({
      cancel: () => {
        if (phase === "recording") {
          stt.cancel();
          phase = "paused";
          convSetPhase("paused");
        }
      },
      send: () => {
        if (phase === "recording") finishTurnFlow();
      },
    });
    convSetPhase("recording");
    if (!stt.start()) {
      phase = "idle";
      stop("busy");
      toast("STT busy, conversation off", "warning");
      return;
    }
    toast(`Listening - speak, then pause ${1.5}s to send (or press ${keyLabel()})`);
  }

  // The resting state: mic closed, one press to talk. Entered by start() and
  // after a reply is spoken, never by the loop auto-recording.

  function enterPaused() {
    phase = "paused";
    convSetActions({
      talk: () => {
        if (phase === "paused") beginTurn();
      },
      end: () => stop("user"),
    });
    convSetPhase("paused");
    toast(`Press ${keyLabel()} to talk`);
  }

  // One press takes the floor: cut whatever audio is queued or playing, drop
  // the pending reply, and open the mic. The mode stays on - a press always
  // means "I want to talk now", so it must never exit silently.

  function bargeIn() {
    logger?.log("VOICE", "Conversation barge-in", "debug");
    stt.setSilenceAutoFinalize?.(null, null);
    discardStreamAudio();
    clearProcessingToast();
    // Settle the pending reply wait as "stopped" so the abandoned answer is
    // never flushed into the mic we are about to open.
    if (waitCancel) {
      waitCancel("stopped");
      waitCancel = null;
    }
    beginTurn();
  }

  function endReplyStream() {
    for (const unsub of streamUnsubs) {
      try {
        unsub();
      } catch {}
    }
    streamUnsubs = [];
  }

  // Kill streamed audio without touching the loop state. Queued sentences
  // are invalidated so they never resume after a stop. The caller decides
  // what happens next (legacy speak, notification, or exit).

  function discardStreamAudio() {
    endReplyStream();
    speakGen += 1;
    tts.stop();
  }

  function stop(reason) {
    if (!active) return;
    active = false;
    generation += 1;
    phase = "idle";
    stt.setSilenceAutoFinalize?.(null, null);
    if (waitCancel) {
      waitCancel("stopped");
      waitCancel = null;
    }
    endReplyStream();
    speakGen += 1;
    stt.setStopHint(null);
    if (stt.isRecording() || stt.isProcessing()) stt.cancel();
    clearProcessingToast();
    tts.stop();
    tts.setConversationActive(false);
    convClear();
    logger?.log("VOICE", `Conversation stopped reason=${reason}`, "debug");
  }

  function startReplyStream(sessionID, turnStart) {
    streamBuffer = "";
    streamSpokenChars = 0;
    const unsub = api.event.on("message.part.delta", (event) => {
      try {
        if (!active || phase !== "waiting") return;
        const props = event.properties || {};
        const expectedID = typeof sessionID === "function" ? sessionID() : sessionID;
        if (typeof sessionID === "function" && !expectedID) return;
        if (expectedID && props.sessionID && props.sessionID !== expectedID) return;
        if (typeof props.delta !== "string" || !props.delta) return;
        if (props.field && props.field !== "text") return;
        const lookupID = props.sessionID || expectedID;
        const messages = api?.state?.session?.messages?.(lookupID) || [];
        const msg = messages.find((m) => m?.id === props.messageID);
        if (!msg || msg.role !== "assistant") return;
        if ((msg.time?.created || 0) < turnStart) return;
        const parts = api?.state?.part?.(props.messageID) || [];
        const part = parts.find((p) => p?.id === props.partID);
        if (part && part.type !== "text") return;
        streamBuffer += props.delta;
        flushStream(false);
      } catch {}
    });
    streamUnsubs.push(unsub);
  }

  function flushStream(final = false) {
    const { sentences, rest } = splitSpokenSentences(streamBuffer);
    const ready = final && rest.trim() ? [...sentences, rest] : sentences;
    if (ready.length > 0 && streamSpokenChars === 0) {
      showProcessingToast(`Speaking - press ${keyLabel()} to interrupt`);
    }
    for (const sentence of ready) {
      if (!isSpeakableSentence(sentence)) continue;
      const cleaned = localSpeechCleanup(sentence);
      if (!cleaned) continue;
      queueSpeak(cleaned);
      streamSpokenChars += cleaned.length;
    }
    streamBuffer = final ? "" : rest;
  }

  // Wait for the submitted turn to finish: idle, a permission/question gate,
  // or timeout. Resolves early when stop() cancels the wait. gates:false drops
  // the permission/question subscriptions, so a second wait survives the gate
  // the user is answering on screen and only ends on idle/timeout/stop.

  function waitForReply(sessionID, { gates = true } = {}) {
    let settled = false;
    let unsubs = [];
    let timer = null;

    let cancelFn = null;
    const done = (outcome) => {
      if (settled) return null;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const unsub of unsubs) {
        try {
          unsub();
        } catch {}
      }
      unsubs = [];
      if (waitCancel === cancelFn) waitCancel = null;
      return outcome;
    };

    const promise = new Promise((resolve) => {
      const finish = (outcome) => {
        const result = done(outcome);
        if (result !== null) resolve(result);
      };
      cancelFn = (outcome) => finish(outcome || "stopped");
      waitCancel = cancelFn;

      const forSession = (props) => {
        const expectedID = typeof sessionID === "function" ? sessionID() : sessionID;
        if (typeof sessionID === "function" && !expectedID) return false;
        return !expectedID || !props?.sessionID || props.sessionID === expectedID;
      };

      unsubs = [
        api.event.on("session.idle", (event) => {
          if (forSession(event.properties)) finish("idle");
        }),
        api.event.on("session.status", (event) => {
          if (event.properties?.status?.type === "idle" && forSession(event.properties)) {
            finish("idle");
          }
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
    });

    return promise;
  }

  async function finishTurnFlow() {
    if (!active || phase !== "recording") return;
    stt.setSilenceAutoFinalize?.(null, null);
    const myGen = generation;
    phase = "processing";
    convSetActions({
      cancel: () => {
        // Processing is too short to cancel safely; report busy.
      },
    });
    convSetPhase("processing");
    showProcessingToast("Transcribing...");

    const res = await stt.transcribeTurn();
    if (!active || myGen !== generation) return;

    if (res.error) {
      consecErrors += 1;
      logger?.log("VOICE", `Conversation turn error consec=${consecErrors}`, "warn");
      if (consecErrors >= 2) {
        stop("error");
        return;
      }
      pauseForRetry(`Paused - press ${keyLabel()} to retry`);
      return;
    }
    if (!res.text) {
      consecErrors = 0;
      pauseForRetry(`No speech heard - press ${keyLabel()} to try again`);
      return;
    }
    consecErrors = 0;

    if (matchesStopPhrase(res.text, stopPhrases)) {
      stt.discard();
      stop("stop phrase");
      toast("Conversation off");
      return;
    }

    const turnStart = Date.now();
    // v2 prompt dispatch may emit the entire reply before its promise returns.
    // Home creation navigates before prompting, so resolve the ID at event time.
    let earlyWait = null;
    if (api.client?.tui?.v2) {
      phase = "waiting";
      convSetActions({
        cancel: () => {},
        barge: () => bargeIn(),
      });
      convSetPhase("waiting");
      startReplyStream(currentSessionID, turnStart);
      earlyWait = waitForReply(currentSessionID);
    }
    const submitted = await stt.submitTurnText(res.text);
    if (!active || myGen !== generation) return;
    if (submitted.error) {
      stop("submit failed");
      return;
    }

    phase = "waiting";
    convSetActions({
      cancel: () => {},
      barge: () => bargeIn(),
    });
    convSetPhase("waiting");
    const sessionID = currentSessionID();
    showProcessingToast(`Working - press ${keyLabel()} to talk`);
    if (!earlyWait) startReplyStream(sessionID, turnStart);
    const tWait = Date.now();
    const outcome = await (earlyWait || waitForReply(sessionID));
    const waitMs = Date.now() - tWait;
    endReplyStream();
    logger?.log(
      "VOICE",
      `Conversation wait outcome=${outcome} waitMs=${waitMs} streamedChars=${streamSpokenChars}`,
      "debug",
    );
    if (!active || myGen !== generation) return;

    if (outcome === "timeout") {
      discardStreamAudio();
      stop("timeout");
      toast("No reply in time, conversation off", "warning");
      return;
    }
    if (outcome === "permission" || outcome === "question") {
      await answerGateThenSpeak(myGen, sessionID, turnStart, outcome);
      return;
    }
    if (outcome === "stopped") return;

    await speakReply(myGen);
  }

  // A permission/question gate is answered ON SCREEN, so the mic must stay
  // shut. Announce the gate, then re-arm the reply stream and wait for the
  // agent to resume so its post-answer reply is spoken aloud - before this,
  // endReplyStream() had already run and the answer was dropped in silence.

  async function answerGateThenSpeak(myGen, sessionID, turnStart, outcome) {
    discardStreamAudio();
    phase = "speaking";
    convSetActions({
      stop: () => {
        if (phase === "speaking") {
          tts.stop();
          phase = "paused";
          convSetPhase("paused");
        }
      },
      barge: () => bargeIn(),
      pauseTts: () => {
        if (phase === "speaking") {
          tts.stop();
          phase = "paused";
          convSetPhase("paused");
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
    if (!active || myGen !== generation || phase !== "speaking") return;

    // Still "waiting": the user answers on screen, and a press here is an
    // ordinary barge-in (drop the pending reply, open the mic).
    phase = "waiting";
    convSetActions({
      cancel: () => {},
      barge: () => bargeIn(),
    });
    convSetPhase("waiting");
    showProcessingToast(`Answer on screen - press ${keyLabel()} to talk`);
    startReplyStream(sessionID, turnStart);
    const resumed = await waitForReply(sessionID, { gates: false });
    if (!active || myGen !== generation) return;
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

  // Speak whatever this turn produced, then rest paused with the mic OFF.
  // Streamed sentences are already queued, so only the tail needs flushing;
  // the full LLM-narrated speak is the fallback when nothing streamable
  // arrived. Returns early on any generation/phase change (barge-in, stop).

  async function speakReply(myGen) {
    phase = "speaking";
    convSetActions({
      stop: () => {
        if (phase === "speaking") {
          tts.stop();
          phase = "paused";
          convSetPhase("paused");
        }
      },
      barge: () => bargeIn(),
      pauseTts: () => {
        if (phase === "speaking") {
          tts.stop();
          phase = "paused";
          convSetPhase("paused");
        }
      },
    });
    convSetPhase("speaking");
    showProcessingToast(`Speaking - press ${keyLabel()} to interrupt`);
    if (streamSpokenChars > 0) {
      flushStream(true);
      await speakTail;
      clearProcessingToast();
      if (!active || myGen !== generation || phase !== "speaking") return;
      await delay(restartDelayMs);
      if (!active || myGen !== generation || phase !== "speaking") return;
      enterPaused();
      // Hands-free: auto-listen after the reply instead of waiting for a keypress.
      await delay(500);
      if (!active || myGen !== generation || phase !== "paused") return;
      beginTurn();
      return;
    }
    const spoken = await tts.speakAssistantTurn();
    if (!active || myGen !== generation || phase !== "speaking") return;
    // Drop the sticky speaking status before the paused toast, or it keeps
    // re-announcing "interrupt" once the mic is closed again.
    clearProcessingToast();
    if (!spoken.spoken) {
      toast("No reply to speak", "warning");
    }
    await delay(restartDelayMs);
    if (!active || myGen !== generation || phase !== "speaking") return;
    enterPaused();
    // Hands-free: auto-listen after the reply instead of waiting for a keypress.
    await delay(500);
    if (!active || myGen !== generation || phase !== "paused") return;
    beginTurn();
  }

  // Pause instead of auto-recording so an empty or failed turn never feels
  // like the keypress was ignored.

  function pauseForRetry(message) {
    if (!active) return;
    phase = "paused";
    if (message) toast(message, "warning");
  }

  // Stop speech and hold the mode, mic still closed. The next keypress records
  // again. Only the TTS stop key lands here; the conversation key barges in.

  function pauseSpeech() {
    if (!active || phase !== "speaking") return;
    logger?.log("VOICE", "Conversation speech paused", "debug");
    tts.stop();
    phase = "paused";
    toast(`Speech paused - press ${keyLabel()} to talk`);
  }

  // Called by the TTS stop command while the mode is on. Returns true when the
  // keypress was consumed (speech paused), so TTS skips its own handling.

  function onTtsStop() {
    if (!active) return false;
    if (phase === "speaking") {
      pauseSpeech();
      return true;
    }
    // Mid-stream the agent is still working and cannot pause, so the stop key
    // exits the mode instead of leaving a half-heard reply behind.
    if (phase === "waiting" && tts.isSpeaking?.()) {
      stop("cancelled");
      toast("Conversation off");
      return true;
    }
    return false;
  }

  // One press, one meaning: "I want the floor". The source key (record,
  // submit, toggle) no longer changes the outcome, and a press never exits.

  function onKey() {
    if (!active) {
      start();
      return;
    }
    if (phase === "recording") {
      finishTurnFlow();
      return;
    }
    if (phase === "speaking" || phase === "waiting") {
      bargeIn();
      return;
    }
    if (phase === "paused") {
      beginTurn();
      return;
    }
    // processing | idle: the transcription in flight is too short to interrupt.
    toast("Conversation busy, please wait...", "warning");
  }

  function start() {
    if (active) return;
    if (isLiveNotesActive?.()) {
      toast("Live notes recording - stop it first (/voice-notes-stop)", "warning");
      return;
    }
    if (stt.isRecording() || stt.isProcessing() || stt.isStreaming?.()) {
      toast("STT busy, try again shortly", "warning");
      return;
    }
    active = true;
    generation += 1;
    turn = 0;
    consecErrors = 0;
    phase = "paused";
    tts.setConversationActive(true);
    convBegin();
    convSetActions({
      talk: () => {
        if (phase === "paused") beginTurn();
      },
      end: () => stop("user"),
    });
    convSetPhase("paused");
    // Recording toasts must name the key the user actually has bound.
    stt.setStopHint(kb("voice.conversation"));
    logger?.log("VOICE", "Conversation started", "debug");
    toast(`Conversation on - press ${keyLabel()} to talk`);
  }

  api.lifecycle?.onDispose?.(() => stop("dispose"));

  const DEFAULT_KEYBINDS = {
    "voice.conversation": "<leader>v",
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

  // Every toast names the key that acts, resolved from the user's keybinds
  // instead of the default literal - a rebound key must never be announced as
  // something the user does not have.
  function keyLabel() {
    return kb("voice.conversation") || "the key";
  }

  const commands = [
    {
      title: "Voice: conversation mode",
      value: "voice.conversation",
      category: "opencode-voice",
      description:
        "Toggle voice conversation (push-to-talk: press to record, press again to send, press while it speaks to interrupt)",
      ...(kb("voice.conversation") ? { keybind: kb("voice.conversation") } : {}),
      slash: { name: "voice-conversation" },
      onSelect() {
        onKey();
      },
    },
    {
      title: "Voice: stop conversation",
      value: "voice.conversation-stop",
      category: "opencode-voice",
      description: "Exit voice conversation mode",
      slash: { name: "voice-conversation-stop" },
      onSelect() {
        if (active) {
          stop("command");
          toast("Conversation off");
        }
      },
    },
  ];

  const controller = { isActive, onKey, onTtsStop, start, stop };

  return { commands, controller };
}
