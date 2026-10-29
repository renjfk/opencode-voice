#!/usr/bin/env python3
"""Chatterbox TTS sidecar for opencode-voice.

Why a sidecar at all: Chatterbox loads a multi-hundred-MB torch model. The
plugin speaks many short utterances per session, so re-loading the model per
utterance would never keep up. Loading ONCE here and serving plain HTTP over
stdlib http.server mirrors lib/whisper-server.js: the JS side owns the child
process, probes readiness, and kills it on dispose.

Design constraints (all deliberate):
- stdlib http.server only. No FastAPI/flask/uvicorn - the only non-stdlib
  dependency is chatterbox-tts itself (and its torch). A user who has
  chatterbox-tts working already has everything this file needs.
- /health answers BEFORE and DURING model load, so a broken install reports a
  real reason ("chatterbox-tts not installed") instead of a connection refusal
  the JS side cannot explain. 200 = ready, 503 = still loading or failed, with
  the reason in the JSON body.
- Logs go to stderr, never stdout, so stdout stays free for diagnostics and the
  JS side never has to demultiplex a protocol stream.
- Device auto-selects cuda > mps > cpu.
- Written for Python 3.9+ on purpose: no match statements, no PEP 604 unions.
  Chatterbox upstream targets 3.11, but a sidecar that cannot even be imported
  on an older interpreter cannot report why, which would leave the JS side with
  an unexplainable failure. Staying 3.9-compatible maximizes the chance of a
  clear diagnosis on whatever interpreter the user's venv ended up with.

Protocol:
  GET  /health  -> {ok, variant, device, phase, error?}   (200 ready / 503 not)
  POST /speak   -> JSON {text, language_id?, exaggeration?, voice_ref?, cfg_weight?}
                  200 + audio/wav bytes on success, JSON error otherwise.
"""

import argparse
import io
import json
import os
import sys
import threading
import traceback
import wave

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Model state, shared across handler threads.
STATE = {
    "model": None,
    "variant": "multilingual",
    "device": "unknown",
    "sr": 24000,
    # English-only variants have no language_id parameter.
    "supports_language": True,
    "languages": [],
    "phase": "loading",  # loading | ready | failed
    "error": None,
    # Chatterbox only mutates its own model during generate(), and the JS side
    # sends one /speak at a time per process, so a plain lock is enough to keep
    # two concurrent requests from interleaving on the model.
    "lock": threading.Lock(),
}


def log(message):
    """stderr only - stdout must stay clean."""
    sys.stderr.write("[chatterbox] %s\n" % message)
    sys.stderr.flush()


def pick_device():
    """cuda > mps > cpu. Returns (device, error_or_None)."""
    try:
        import torch
    except Exception as err:  # pragma: no cover - depends on user install
        return None, "torch is not importable in this interpreter (%s)" % err
    try:
        if torch.cuda.is_available():
            return "cuda", None
    except Exception:
        pass
    try:
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps", None
    except Exception:
        pass
    return "cpu", None


# Verified against chatterbox-tts 0.1.7 (the current release):
#   chatterbox.ChatterboxMultilingualTTS  -> 23 languages, generate(text, language_id, ...)
#   chatterbox.tts_turbo.ChatterboxTurboTTS -> English, generate(text, ...)
#   chatterbox.tts.ChatterboxTTS           -> English, generate(text, ...)
# There is NO Nano class in 0.1.7, so "nano" resolves to Turbo when absent.
#
# `supports_language` matters: the English-only classes have no language_id
# parameter at all, so passing one raises TypeError. Each variant is tried in
# order and every import we attempted is reported on failure - a diagnosable
# error beats a wrong guess.
CANDIDATES = {
    "multilingual": [
        ("chatterbox", "ChatterboxMultilingualTTS"),
        ("chatterbox.mtl_tts", "ChatterboxMultilingualTTS"),
    ],
    "turbo": [
        ("chatterbox.tts_turbo", "ChatterboxTurboTTS"),
        ("chatterbox", "ChatterboxTurboTTS"),
    ],
    # Nano first (future releases); Turbo is the current stand-in.
    "nano": [
        ("chatterbox", "ChatterboxNanoTTS"),
        ("chatterbox.tts_nano", "ChatterboxNanoTTS"),
        ("chatterbox.tts_turbo", "ChatterboxTurboTTS"),
    ],
}

# English-only variants must NOT receive a language_id kwarg.
SUPPORTS_LANGUAGE = {
    "multilingual": True,
    "turbo": False,
    "nano": False,
}


def load_model(variant):
    """Load the model once. Raises RuntimeError with an actionable message.

    Returns (model, device, sr, supports_language).
    """
    device, device_err = pick_device()
    if device is None:
        raise RuntimeError(device_err)

    tried = []
    entry = None
    for module_name, class_name in CANDIDATES.get(variant, []):
        try:
            module = __import__(module_name, fromlist=[class_name])
            entry = getattr(module, class_name)
            if variant == "nano" and class_name != "ChatterboxNanoTTS":
                # Honest substitution, not a silent downgrade.
                log("variant 'nano' is not in this chatterbox-tts build; using %s instead" % class_name)
            break
        except Exception as err:
            tried.append("%s.%s (%s)" % (module_name, class_name, err))
    if entry is None:
        raise RuntimeError(
            "could not import a Chatterbox class for variant '%s'. Tried: %s. "
            "Install it with 'pip install chatterbox-tts' in this interpreter."
            % (variant, "; ".join(tried) or "no candidates")
        )

    # from_pretrained is the documented loader on every Chatterbox class; the
    # first call also downloads weights from HuggingFace, which is why the
    # plugin allows a long readiness bound.
    try:
        model = entry.from_pretrained(device=device)
    except AttributeError:
        model = entry(device=device)

    # `sr` is set in __init__ on every Chatterbox class (24kHz for S3Gen);
    # 24000 is only a fallback.
    sr = getattr(model, "sr", None) or 24000
    supports_language = SUPPORTS_LANGUAGE.get(variant, False)
    log(
        "loaded variant=%s class=%s device=%s sr=%s language_id=%s"
        % (variant, entry.__name__, device, sr, supports_language)
    )
    return model, device, sr, supports_language


def tensor_to_wav_bytes(tensor, sr):
    """Torch float tensor ([1, samples] or [samples]) -> 16-bit mono WAV bytes.

    Written against the stdlib `wave` module instead of torchaudio.save because
    torchaudio's file-like-object support has changed across the 2.x line, and a
    temp file per utterance is needless I/O. numpy is a hard dependency of
    chatterbox-tts, so it is always present.
    """
    import numpy as np

    if hasattr(tensor, "detach"):
        tensor = tensor.detach().to("cpu")
    if hasattr(tensor, "float"):
        tensor = tensor.float()
    arr = np.asarray(tensor, dtype=np.float32).reshape(-1)
    if arr.size == 0:
        raise RuntimeError("model produced an empty audio tensor")
    arr = np.clip(arr, -1.0, 1.0)
    pcm = (arr * 32767.0).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(sr))
        handle.writeframes(pcm.tobytes())
    return buf.getvalue()


def synthesize(model, text, language_id, exaggeration, cfg_weight, voice_ref, supports_language):
    kwargs = {"text": text}
    # The English-only classes have no language_id parameter - passing one is a
    # TypeError, not a silent ignore, so it is only sent where it exists.
    if language_id and supports_language:
        kwargs["language_id"] = language_id
    if exaggeration is not None:
        kwargs["exaggeration"] = exaggeration
    if cfg_weight is not None:
        kwargs["cfg_weight"] = cfg_weight
    # Zero-shot cloning. audio_prompt_path is the documented kwarg on every
    # Chatterbox build that supports voice cloning; a build without it raises,
    # which surfaces as an error to the JS side (which then falls back to Piper).
    if voice_ref:
        kwargs["audio_prompt_path"] = voice_ref

    try:
        out = model.generate(**kwargs)
    except TypeError as err:
        # A build without one of the optional kwargs: retry with the smallest
        # portable signature rather than losing the whole utterance.
        minimal = {"text": text}
        if language_id and supports_language:
            minimal["language_id"] = language_id
        if voice_ref:
            minimal["audio_prompt_path"] = voice_ref
        log("generate() rejected optional kwargs (%s); retrying minimal" % err)
        out = model.generate(**minimal)
    if isinstance(out, tuple):
        out = out[0]
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "chatterbox-sidecar/1.0"

    def log_message(self, fmt, *args):
        # BaseHTTPRequestHandler logs to stderr already; keep it, but quieter.
        log("http %s" % (fmt % args))

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path != "/health":
            self._send_json(404, {"ok": False, "error": "not found: %s" % path})
            return
        ok = STATE["phase"] == "ready"
        payload = {
            "ok": ok,
            "variant": STATE["variant"],
            "device": STATE["device"],
            "phase": STATE["phase"],
            "sr": STATE["sr"],
            "supports_language": STATE["supports_language"],
            "languages": STATE["languages"],
        }
        if STATE["error"]:
            payload["error"] = STATE["error"]
        # 200 when the model can serve speech, 503 while loading or after a
        # failed load - the JS readiness probe distinguishes the two.
        self._send_json(200 if ok else 503, payload)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path != "/speak":
            self._send_json(404, {"ok": False, "error": "not found: %s" % path})
            return
        if STATE["phase"] != "ready" or STATE["model"] is None:
            self._send_json(
                503,
                {
                    "ok": False,
                    "error": STATE["error"] or "model still loading",
                    "phase": STATE["phase"],
                },
            )
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            self._send_json(400, {"ok": False, "error": "empty request body"})
            return
        try:
            req = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as err:
            self._send_json(400, {"ok": False, "error": "invalid JSON: %s" % err})
            return

        text = (req.get("text") or "").strip()
        if not text:
            self._send_json(400, {"ok": False, "error": "text is required"})
            return

        language_id = req.get("language_id") or None
        exaggeration = req.get("exaggeration")
        cfg_weight = req.get("cfg_weight")
        voice_ref = req.get("voice_ref") or None
        if voice_ref:
            # Absolute-path option: a missing file must be diagnosed here, not
            # swallowed by generate()'s TypeError fallback.
            voice_ref = os.path.expanduser(str(voice_ref))
            if not os.path.isfile(voice_ref):
                self._send_json(
                    400, {"ok": False, "error": "voice_ref not found: %s" % voice_ref}
                )
                return
        # An unsupported language_id is a client routing bug, not a server
        # error: answer 400 so the plugin routes that utterance to Piper.
        if language_id and STATE["languages"] and language_id not in STATE["languages"]:
            self._send_json(
                400,
                {
                    "ok": False,
                    "error": "language '%s' not supported by this model (%s)"
                    % (language_id, ", ".join(STATE["languages"])),
                },
            )
            return

        try:
            with STATE["lock"]:
                out = synthesize(
                    STATE["model"],
                    text,
                    language_id,
                    exaggeration,
                    cfg_weight,
                    voice_ref,
                    STATE["supports_language"],
                )
                wav = tensor_to_wav_bytes(out, STATE["sr"])
        except Exception as err:
            log("synthesize failed: %s" % err)
            self._send_json(500, {"ok": False, "error": "synthesis failed: %s" % err})
            return

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.end_headers()
        self.wfile.write(wav)


def preload(variant):
    try:
        model, device, sr, supports_language = load_model(variant)
        STATE["model"] = model
        STATE["device"] = device
        STATE["sr"] = sr
        STATE["supports_language"] = supports_language
        # Report what the loaded model actually speaks, so a routing decision
        # the JS side got wrong is diagnosable instead of mysterious.
        # 0.1.7 names it get_supported_languages; older/newer builds may use
        # list_supported_languages, so try both.
        lister = getattr(model, "get_supported_languages", None) or getattr(
            model, "list_supported_languages", None
        )
        if callable(lister):
            try:
                STATE["languages"] = sorted(lister().keys())
            except Exception:
                STATE["languages"] = []
        STATE["phase"] = "ready"
        STATE["error"] = None
    except Exception as err:
        # Stay up on 503 with the reason: a live /health that explains the
        # failure is far more useful to the plugin (and to the user reading
        # logs) than a dead port it can only report as "unavailable".
        STATE["phase"] = "failed"
        STATE["error"] = str(err)
        log("model load FAILED: %s" % err)
        traceback.print_exc(file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Chatterbox TTS sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8120)
    parser.add_argument("--variant", default="multilingual")
    args = parser.parse_args()

    STATE["variant"] = args.variant

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True

    # Load in a background thread so /health is answerable during the (often
    # multi-minute, first-run-downloads-weights) load instead of connection
    # refused - the JS readiness poll can then show real progress.
    threading.Thread(target=preload, args=(args.variant,), daemon=True).start()
    log("listening on %s:%d variant=%s" % (args.host, args.port, args.variant))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()