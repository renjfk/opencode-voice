// Measured media controller for TTS playback.
//
// Owns one buffered utterance and one `play` process at a time. Totals are
// measured from real audio frames (PCM byte counts, WAV data chunk), never
// estimated from sentence counts. The cursor is wall-clock derived at the
// current rate, so it is explicitly approximate; only the total is exact.
//
// Backend model: stock `play` (sox). True pause/resume uses SIGSTOP/SIGCONT
// on the owned process -- audio freezes mid-speech, no restart. Speed uses
// the `tempo` effect (preserves pitch), seeks respawn with `trim` at the
// new offset. Stale close events are fenced by generation token so a late
// exit from a previous process can never clear current playback.
//
// Wiring note: this controller manages process lifecycle only. Byte feeding
// (stdin piping of the buffered asset) is injected via `feed`, provided by
// the tts.js wiring batch. Tests inject a fake clock, fake spawn, and fake
// signals: no real audio, no timers.

export const PLAYER_RATE_MIN = 0.75;
export const PLAYER_RATE_MAX = 2;

function toPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Exact duration of buffered PCM from real frame counts. Accepts
// `{ bytes }` or a raw Buffer. Returns seconds, or null when unmeasurable.
export function measurePcmDurationSec(asset, sampleRate, channels = 1, bits = 16) {
  const bytes = asset?.bytes ?? asset;
  if (!Buffer.isBuffer(bytes)) return null;
  const sr = toPositiveNumber(sampleRate);
  const ch = toPositiveNumber(channels);
  const bd = toPositiveNumber(bits);
  if (sr === null || ch === null || bd === null) return null;
  const bytesPerSec = sr * ch * (bd / 8);
  if (!(bytesPerSec > 0)) return null;
  return bytes.length / bytesPerSec;
}

// Exact duration of a complete WAV buffer from its data chunk and the fmt
// byte rate. Returns seconds, or null when the buffer is not a readable WAV.
export function measureWavDurationSec(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44) return null;
  if (wav.toString("ascii", 0, 4) !== "RIFF") return null;
  if (wav.toString("ascii", 8, 12) !== "WAVE") return null;
  let fmt = null;
  let dataSize = null;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= wav.length) {
      const channels = wav.readUInt16LE(body + 2);
      const sampleRate = wav.readUInt32LE(body + 4);
      const byteRate = wav.readUInt32LE(body + 8);
      const bits = wav.readUInt16LE(body + 14);
      if (channels > 0 && sampleRate > 0 && bits > 0) {
        fmt = { channels, sampleRate, byteRate, bits };
      }
    } else if (id === "data") {
      dataSize = size;
    }
    if (id === "data" && fmt) break;
    offset = body + size;
  }
  if (!fmt || dataSize === null || dataSize <= 0) return null;
  const bytesPerSec =
    fmt.byteRate > 0 ? fmt.byteRate : (fmt.sampleRate * fmt.channels * fmt.bits) / 8;
  if (!(bytesPerSec > 0)) return null;
  return Math.min(dataSize, wav.length) / bytesPerSec;
}

// sox play argv. Input first, then effects: sox parses leading tokens as
// input files, so effects placed before the input make it report "Not
// enough input filenames" and exit instantly with no audio. Neutral
// playback carries no effects at all. The player always feeds self-
// describing WAV bytes on stdin (PCM assets are wrapped with a 44-byte
// header at load), so sox needs no `-t raw` format declaration and the
// argv here is the complete command.
export function buildPlayArgs({ offsetSec = 0, rate = 1 } = {}) {
  const argv = ["-q", "-"];
  const offset = Number(offsetSec) || 0;
  if (offset > 0) argv.push("trim", String(offset));
  const speed = Number(rate) || 1;
  if (speed !== 1) argv.push("tempo", String(speed));
  return argv;
}

// Wrap raw PCM frames in a minimal WAV header so every asset handed to
// `play` is self-describing. Returns a complete WAV Buffer, or null when
// the parameters cannot describe the frames.
export function pcmToWav(pcm, { sampleRate, channels = 1, bits = 16 } = {}) {
  if (!Buffer.isBuffer(pcm)) return null;
  const sr = toPositiveNumber(sampleRate);
  const ch = toPositiveNumber(channels);
  const bd = toPositiveNumber(bits);
  if (sr === null || ch === null || bd === null) return null;
  if (![8, 16, 24, 32].includes(bd)) return null;
  const bytesPerSec = (sr * ch * bd) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(ch, 22);
  header.writeUInt32LE(sr, 24);
  header.writeUInt32LE(bytesPerSec, 28);
  header.writeUInt16LE((ch * bd) / 8, 32);
  header.writeUInt16LE(bd, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundMs(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

export function createTtsPlayer({ spawn, signal, now = () => Date.now(), feed = () => {} } = {}) {
  if (typeof spawn !== "function") throw new Error("createTtsPlayer requires a spawn adapter");
  if (typeof signal !== "function") throw new Error("createTtsPlayer requires a signal adapter");

  let asset = null; // { kind, totalSec, wav }
  let status = "idle"; // idle | playing | paused
  let rate = 1;
  let cursorBaseSec = 0;
  let anchorMs = 0;
  let proc = null; // owned live process handle
  let generation = 0; // fences stale close events
  let playResolve = null;
  let disposed = false;
  let needsRespawn = false;

  function currentCursorSec() {
    if (!asset) return 0;
    if (status !== "playing") return roundMs(clamp(cursorBaseSec, 0, asset.totalSec));
    const elapsedSec = (now() - anchorMs) / 1000;
    return roundMs(clamp(cursorBaseSec + elapsedSec * rate, 0, asset.totalSec));
  }

  function settleCurrent(result) {
    const resolve = playResolve;
    playResolve = null;
    if (typeof resolve !== "function") return;
    try {
      resolve(result);
    } catch {}
  }

  function killOwned(sig) {
    const owned = proc;
    proc = null;
    if (owned) {
      try {
        signal(owned.pid, sig);
      } catch {}
    }
  }

  function spawnAt(offsetSec) {
    generation += 1;
    const token = generation;
    const argv = buildPlayArgs({ offsetSec, rate });
    const handle = spawn(argv);
    proc = handle;
    anchorMs = now();
    cursorBaseSec = offsetSec;
    needsRespawn = false;
    try {
      feed(handle, { wav: asset.wav, offsetSec, rate });
    } catch {}
    const onClose = handle.onClose;
    if (typeof onClose === "function") {
      try {
        onClose((code) => {
          if (token !== generation) return; // stale process: never clears current playback
          proc = null;
          status = "idle";
          cursorBaseSec = asset ? asset.totalSec : 0;
          settleCurrent({ ended: true, code });
        });
      } catch {}
    }
    return handle;
  }

  function startPlayback() {
    if (!asset || disposed) return false;
    let offset = clamp(currentCursorSec(), 0, asset.totalSec);
    if (offset >= asset.totalSec) offset = 0;
    killOwned("SIGKILL");
    status = "playing";
    spawnAt(offset);
    return true;
  }

  return {
    load(input = {}) {
      if (disposed) return false;
      if (input.wav) {
        const totalSec = measureWavDurationSec(input.wav);
        if (totalSec === null || !(totalSec > 0)) return false;
        asset = { kind: "wav", totalSec, wav: input.wav };
      } else if (input.pcm) {
        const sampleRate = input.sampleRate;
        const channels = input.channels ?? 1;
        const bits = input.bits ?? 16;
        const totalSec = measurePcmDurationSec({ bytes: input.pcm }, sampleRate, channels, bits);
        if (totalSec === null || !(totalSec > 0)) return false;
        const wav = pcmToWav(input.pcm, { sampleRate, channels, bits });
        if (!wav) return false;
        asset = { kind: "pcm", totalSec, wav };
      } else {
        return false;
      }
      status = "idle";
      rate = clamp(Number(input.rate) || 1, PLAYER_RATE_MIN, PLAYER_RATE_MAX);
      cursorBaseSec = 0;
      anchorMs = now();
      needsRespawn = false;
      return true;
    },

    play() {
      if (disposed || !asset) return false;
      settleCurrent({ stopped: true, superseded: true });
      const started = new Promise((resolve) => {
        playResolve = resolve;
      });
      status = "playing";
      startPlayback();
      return started;
    },

    pause() {
      if (disposed || status !== "playing" || !proc) return false;
      cursorBaseSec = currentCursorSec();
      status = "paused";
      try {
        signal(proc.pid, "SIGSTOP");
      } catch {}
      return true;
    },

    resume() {
      if (disposed || status !== "paused") return false;
      if (!asset) return false;
      if (needsRespawn || !proc) {
        status = "playing";
        spawnAt(clamp(cursorBaseSec, 0, asset.totalSec));
        return true;
      }
      status = "playing";
      anchorMs = now();
      try {
        signal(proc.pid, "SIGCONT");
      } catch {}
      return true;
    },

    stop() {
      if (disposed) return false;
      generation += 1;
      killOwned("SIGKILL");
      if (status !== "idle") {
        cursorBaseSec = currentCursorSec();
        status = "idle";
      }
      needsRespawn = false;
      settleCurrent({ stopped: true });
      return true;
    },

    seek(sec) {
      if (disposed || !asset) return 0;
      const clamped = roundMs(clamp(Number(sec) || 0, 0, asset.totalSec));
      cursorBaseSec = clamped;
      anchorMs = now();
      if (status === "playing") {
        killOwned("SIGKILL");
        spawnAt(clamped);
      } else if (status === "paused") {
        needsRespawn = true;
      }
      return clamped;
    },

    rewind(sec) {
      if (disposed || !asset) return 0;
      return this.seek(currentCursorSec() - (Number(sec) || 0));
    },

    forward(sec) {
      if (disposed || !asset) return 0;
      return this.seek(currentCursorSec() + (Number(sec) || 0));
    },

    replay() {
      if (disposed || !asset) return false;
      this.seek(0);
      if (status === "paused") return this.resume();
      if (status === "idle") return this.play();
      return true;
    },

    setRate(next) {
      const clamped = clamp(Number(next) || 1, PLAYER_RATE_MIN, PLAYER_RATE_MAX);
      const changed = clamped !== rate;
      if (changed && status === "playing") {
        // Capture the cursor under the OLD rate first: recomputing after
        // assigning the new rate would rescale already-elapsed audio time.
        cursorBaseSec = currentCursorSec();
        anchorMs = now();
        rate = clamped;
        killOwned("SIGKILL");
        spawnAt(cursorBaseSec);
      } else {
        rate = clamped;
        if (changed && status === "paused") {
          cursorBaseSec = currentCursorSec();
          needsRespawn = true;
        }
      }
      return clamped;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      killOwned("SIGKILL");
      status = "idle";
      proc = null;
      settleCurrent({ stopped: true, disposed: true });
    },

    getState() {
      return {
        status,
        cursorSec: currentCursorSec(),
        totalSec: asset ? roundMs(asset.totalSec) : 0,
        rate,
        exactTotal: asset !== null,
        cursorApproximate: true,
      };
    },
  };
}
