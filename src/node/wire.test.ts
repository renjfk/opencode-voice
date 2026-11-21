// Real HTTP/WebSocket round trips: server.ts ↔ client.ts over loopback.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { wrapPcm } from "../audio/wav.ts";
import { fakeMic, fakePlayer, type FakeMic } from "../testing/fakes.ts";
import { SynthError } from "../types.ts";
import {
  createRemotePlayer,
  createRemoteSynth,
  createRemoteTranscriber,
  fetchInfo,
  openRemoteMic,
} from "./client.ts";
import { HubError, type DeviceStatus, type Hub } from "./hub.ts";
import { startServer } from "./server.ts";

const PORT = 47911;
const BASE = `http://127.0.0.1:${PORT}`;
const DEV: DeviceStatus = {
  id: "phone",
  label: "Phone",
  kind: "termux",
  online: true,
  idleSec: 1,
  mic: true,
  speaker: true,
};

const state = {
  mics: [] as FakeMic[],
  micOwner: null as string | null,
  pinned: null as string | null,
  transcribed: [] as Array<{ bytes: number; language: string }>,
  synthFail: null as SynthError | null,
  busy: false,
};
const player = fakePlayer();

const hub: Hub = {
  refresh: async () => {},
  start() {},
  devices: () => [DEV],
  home: () => DEV,
  pinned: () => state.pinned,
  pin(id) {
    if (id === "deaf") throw new HubError("deaf has no working microphone or speaker", "NO_DEVICE");
    state.pinned = id;
  },
  async openMic(owner) {
    if (state.busy)
      throw new HubError("Microphone is in use by other", "BUSY", "Finish that first");
    state.micOwner = owner;
    const m = fakeMic();
    state.mics.push(m);
    return { mic: m, device: DEV };
  },
  micOwner: () => state.micOwner,
  player,
  playerDevice: () => "phone",
  async transcribe(wav, opts) {
    state.transcribed.push({ bytes: wav.length, language: opts.language });
    return "xin chào";
  },
  async synthesize() {
    if (state.synthFail) throw state.synthFail;
    return wrapPcm(Buffer.alloc(32000), 16000);
  },
  warm() {},
  dispose: async () => {},
};

let server: { stop(): void };
beforeAll(() => {
  server = startServer({
    hub,
    hostnames: ["127.0.0.1"],
    port: PORT,
    authorize: async () => false,
    info: () => ({
      host: "Mac",
      devices: hub.devices(),
      home: hub.home(),
      pinned: hub.pinned(),
      micOwner: null,
      models: ["m"],
      defaultModel: "m",
    }),
  });
});
afterAll(() => server.stop());

const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("wire", () => {
  test("info and home pin", async () => {
    const info = await fetchInfo(BASE);
    expect(info?.host).toBe("Mac");
    expect(info?.home.label).toBe("Phone");
    const r = await fetch(`${BASE}/v1/home`, {
      method: "POST",
      body: JSON.stringify({ id: "phone" }),
    });
    expect(r.status).toBe(200);
    expect(state.pinned).toBe("phone");
    const bad = await fetch(`${BASE}/v1/home`, {
      method: "POST",
      body: JSON.stringify({ id: "deaf" }),
    });
    expect(bad.status).toBe(409);
    expect(((await bad.json()) as { message: string }).message).toContain("no working microphone");
  });

  test("mic: PCM streams to the client, pause/stop travel back, device label arrives", async () => {
    const mic = await openRemoteMic(BASE, { clientName: "duy:opencode" });
    expect(mic.device).toBe("Phone");
    expect(state.micOwner).toBe("duy:opencode");
    const got: Buffer[] = [];
    mic.onData((c) => got.push(c));
    const remote = state.mics.at(-1) as FakeMic;
    remote.push(Buffer.alloc(640, 1));
    await until(() => got.length === 1);
    expect(got[0]?.length).toBe(640);
    mic.pause();
    await until(() => remote.paused);
    mic.resume();
    await until(() => !remote.paused);
    await mic.stop();
    expect(remote.stops).toBe(1);
  });

  test("mic: remote errors reach the client with their hint; busy is refused", async () => {
    const mic = await openRemoteMic(BASE);
    const errs: string[] = [];
    mic.onError((e) => errs.push(`${e.code}:${e.message}:${e.hint}`));
    state.mics
      .at(-1)
      ?.fail({ code: "CONNECTION", message: "Phone connection failed", hint: "run sshd" });
    await until(() => errs.length === 1);
    expect(errs[0]).toBe("CONNECTION:Phone connection failed:run sshd");
    mic.kill();
    state.busy = true;
    const err = await openRemoteMic(BASE).catch((e: Error & { hint?: string }) => e);
    state.busy = false;
    expect((err as Error).message).toContain("in use by other");
    expect((err as { hint?: string }).hint).toBe("Finish that first");
  });

  test("mic: closing the client socket kills the device stream", async () => {
    const mic = await openRemoteMic(BASE);
    const remote = state.mics.at(-1) as FakeMic;
    mic.kill();
    await until(() => remote.kills === 1);
  });

  test("player: play/pause/seek/rate/stop over the socket, end reported", async () => {
    const p = createRemotePlayer(BASE);
    const wav = wrapPcm(Buffer.alloc(32000 * 2), 16000);
    const ended = p.play(wav);
    await until(() => player.plays.length === 1);
    expect(player.plays[0]?.length).toBe(wav.length);
    expect(p.status()).toBe("playing");
    expect(p.durationSec()).toBe(2);
    expect(p.pause()).toBe(true);
    await until(() => player.status() === "paused");
    expect(p.resume()).toBe(true);
    await until(() => player.status() === "playing");
    p.seek(1.5);
    await until(() => player.seeks.at(-1) === 1.5);
    p.setRate(1.5);
    await until(() => player.rateValue === 1.5);
    expect(p.rate()).toBe(1.5);
    player.finish("ended");
    expect(await ended).toBe("ended");
    const second = p.play(wav);
    await until(() => player.plays.length === 2);
    p.stop();
    expect(await second).toBe("stopped");
    p.dispose();
  });

  test("transcribe and synth over HTTP, synth errors keep their code", async () => {
    const t = createRemoteTranscriber(BASE, () => "m");
    expect(await t.transcribe(wrapPcm(Buffer.alloc(3200), 16000), { language: "vi" })).toBe(
      "xin chào",
    );
    expect(state.transcribed.at(-1)?.language).toBe("vi");
    const s = createRemoteSynth(BASE, "vieneu", () => "Mai Anh");
    const wav = await s.synthesize({ lang: "vi", text: "chào" });
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    state.synthFail = new SynthError("VieNeu unavailable (exited) — using Piper", "UNAVAILABLE");
    const err = await s.synthesize({ lang: "vi", text: "x" }).catch((e: SynthError) => e);
    state.synthFail = null;
    expect(err).toBeInstanceOf(SynthError);
    expect((err as SynthError).code).toBe("UNAVAILABLE");
  });

  test("node down: client errors say so instead of hanging", async () => {
    const down = "http://127.0.0.1:47999";
    expect(await fetchInfo(down, {}, 500)).toBeNull();
    const err = await openRemoteMic(down).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Voice node/);
    const s = createRemoteSynth(down, "vieneu", () => "x");
    const se = await s.synthesize({ lang: "vi", text: "x" }).catch((e: SynthError) => e);
    expect((se as SynthError).code).toBe("UNAVAILABLE");
  });
});
