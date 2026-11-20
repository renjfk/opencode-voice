import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { MicError } from "../types.ts";
import {
  listInputDevices,
  openMic,
  parsePactlSourcesShort,
  PHONE_UNREACHABLE_HINT,
} from "./mic.ts";
import type { MicDeps, ScheduleFn, SpawnFn } from "./mic.ts";
import type { RunFn } from "./usb.ts";

class FakeChild extends EventEmitter {
  pid = 4242;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  kill(sig: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(sig);
    return true;
  }
  close(code: number | null, sig: NodeJS.Signals | null = null): void {
    this.emit("close", code, sig);
  }
}

function fakeSpawn(opts: { fail?: NodeJS.ErrnoException } = {}): {
  spawn: SpawnFn;
  calls: { cmd: string; args: readonly string[] }[];
  last: () => FakeChild;
} {
  const calls: { cmd: string; args: readonly string[] }[] = [];
  const children: FakeChild[] = [];
  const spawn: SpawnFn = (cmd, args) => {
    calls.push({ cmd, args });
    const c = new FakeChild();
    children.push(c);
    queueMicrotask(() => {
      if (opts.fail) c.emit("error", opts.fail);
      else c.emit("spawn");
    });
    return c;
  };
  return {
    spawn,
    calls,
    last: () => {
      const c = children[children.length - 1];
      if (!c) throw new Error("no child");
      return c;
    },
  };
}

function fakeSchedule(): { schedule: ScheduleFn; advance: (ms: number) => void } {
  let t = 0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  return {
    schedule: (fn, ms) => {
      const timer = { at: t + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    advance(ms) {
      t += ms;
      for (const timer of timers) {
        if (timer.live && timer.at <= t) {
          timer.live = false;
          timer.fn();
        }
      }
    },
  };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function setup(extra: Partial<MicDeps> = {}) {
  const sp = fakeSpawn();
  const clock = fakeSchedule();
  const deps: MicDeps = { spawn: sp.spawn, schedule: clock.schedule, platform: "darwin", ...extra };
  return { sp, clock, deps };
}

const SSH = ["ssh", "-p", "8022", "u0_a1@127.0.0.1", "$HOME/bin/capture.sh", "16000"];

describe("openMic local", () => {
  test("spawns sox raw s16le at the rate and delivers data", async () => {
    const { sp, deps } = setup();
    const mic = await openMic({ kind: "local", sampleRate: 16000 }, deps);
    expect(sp.calls[0]).toEqual({
      cmd: "sox",
      args: ["-d", "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw", "-"],
    });
    expect(mic.format.sampleRate).toBe(16000);
    const got: Buffer[] = [];
    mic.onData((c) => got.push(c));
    sp.last().stdout.write(Buffer.from([1, 2, 3, 4]));
    await tick();
    expect(Buffer.concat(got)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  test("coreaudio device and linux pulse args", async () => {
    const a = setup();
    await openMic({ kind: "local", sampleRate: 16000, device: "MacBook Mic" }, a.deps);
    expect(a.sp.calls[0]?.args.slice(0, 3)).toEqual(["-t", "coreaudio", "MacBook Mic"]);
    const b = setup({ platform: "linux", hasPulse: async () => true });
    await openMic({ kind: "local", sampleRate: 16000 }, b.deps);
    expect(b.sp.calls[0]?.args.slice(0, 3)).toEqual(["-t", "pulseaudio", "default"]);
    const c = setup({ platform: "linux", hasPulse: async () => false });
    await openMic({ kind: "local", sampleRate: 16000, device: "hw:1" }, c.deps);
    expect(c.sp.calls[0]?.args[0]).toBe("-d");
  });

  test("ENOENT rejects SPAWN_FAILED with sox install hint", async () => {
    const err = Object.assign(new Error("spawn sox ENOENT"), { code: "ENOENT" });
    const sp = fakeSpawn({ fail: err });
    const p = openMic(
      { kind: "local", sampleRate: 16000 },
      { spawn: sp.spawn, platform: "darwin" },
    );
    await expect(p).rejects.toMatchObject({
      code: "SPAWN_FAILED",
      message: "sox not found",
      hint: "Install sox: brew install sox",
    });
  });

  test("synchronous spawn throw rejects SPAWN_FAILED", async () => {
    const spawn: SpawnFn = () => {
      throw new Error("boom");
    };
    await expect(
      openMic({ kind: "local", sampleRate: 16000 }, { spawn, platform: "darwin" }),
    ).rejects.toMatchObject({ code: "SPAWN_FAILED", message: "Could not start sox: boom" });
  });

  test("unexpected exit emits EXITED with last stderr line", async () => {
    const { sp, deps } = setup();
    const mic = await openMic({ kind: "local", sampleRate: 16000 }, deps);
    const errs: MicError[] = [];
    mic.onError((e) => errs.push(e));
    sp.last().stderr.write("sox WARN x\nsox FAIL formats: can't open input device\n");
    await tick();
    sp.last().close(2);
    expect(errs).toHaveLength(1);
    expect(errs[0]?.code).toBe("EXITED");
    expect(errs[0]?.message).toBe(
      "sox exited unexpectedly (code 2): sox FAIL formats: can't open input device",
    );
  });

  test("NO_AUDIO after the timeout kills the process, once", async () => {
    const { sp, clock, deps } = setup();
    const mic = await openMic({ kind: "local", sampleRate: 16000 }, deps);
    const errs: MicError[] = [];
    mic.onError((e) => errs.push(e));
    clock.advance(3999);
    expect(errs).toHaveLength(0);
    clock.advance(1);
    expect(sp.last().signals).toEqual(["SIGKILL"]);
    sp.last().close(null, "SIGKILL");
    expect(errs.map((e) => e.code)).toEqual(["NO_AUDIO"]);
    expect(errs[0]?.message).toBe("No audio from the microphone in 4s");
  });

  test("bytes before the timeout cancel NO_AUDIO", async () => {
    const { sp, clock, deps } = setup();
    const mic = await openMic({ kind: "local", sampleRate: 16000 }, deps);
    const errs: MicError[] = [];
    mic.onError((e) => errs.push(e));
    sp.last().stdout.write(Buffer.alloc(2));
    await tick();
    clock.advance(10_000);
    expect(errs).toHaveLength(0);
    expect(sp.last().signals).toEqual([]);
  });

  test("pause drops data but keeps draining, no SIGSTOP; resume delivers again", async () => {
    const { sp, deps } = setup();
    const mic = await openMic({ kind: "local", sampleRate: 16000 }, deps);
    const got: Buffer[] = [];
    mic.onData((c) => got.push(c));
    mic.pause();
    expect(mic.paused).toBe(true);
    sp.last().stdout.write(Buffer.from([9, 9]));
    await tick();
    expect(got).toHaveLength(0);
    mic.resume();
    sp.last().stdout.write(Buffer.from([1, 1]));
    await tick();
    expect(Buffer.concat(got)).toEqual(Buffer.from([1, 1]));
    expect(sp.last().signals).toEqual([]);
  });

  test("stop sends SIGINT, flushes trailing data, resolves on close, no error", async () => {
    const { sp, deps } = setup();
    const mic = await openMic({ kind: "local", sampleRate: 16000 }, deps);
    const errs: MicError[] = [];
    const got: Buffer[] = [];
    mic.onError((e) => errs.push(e));
    mic.onData((c) => got.push(c));
    let done = false;
    const p = mic.stop().then(() => {
      done = true;
    });
    expect(sp.last().signals).toEqual(["SIGINT"]);
    sp.last().stdout.write(Buffer.from([7, 7]));
    await tick();
    expect(done).toBe(false);
    sp.last().close(0);
    await p;
    expect(Buffer.concat(got)).toEqual(Buffer.from([7, 7]));
    expect(errs).toHaveLength(0);
    expect(mic.stop()).toBe(mic.stop());
  });

  test("stop escalates to SIGKILL after 3s and resolves", async () => {
    const { sp, clock, deps } = setup();
    const mic = await openMic({ kind: "local", sampleRate: 16000 }, deps);
    let done = false;
    const p = mic.stop().then(() => {
      done = true;
    });
    clock.advance(2999);
    await tick();
    expect(done).toBe(false);
    clock.advance(1);
    await p;
    expect(sp.last().signals).toEqual(["SIGINT", "SIGKILL"]);
  });

  test("kill is idempotent, drops data, emits no error", async () => {
    const { sp, deps } = setup();
    const mic = await openMic({ kind: "local", sampleRate: 16000 }, deps);
    const errs: MicError[] = [];
    const got: Buffer[] = [];
    mic.onError((e) => errs.push(e));
    mic.onData((c) => got.push(c));
    mic.kill();
    sp.last().stdout.write(Buffer.from([1, 1]));
    await tick();
    sp.last().close(null, "SIGKILL");
    mic.kill();
    expect(got).toHaveLength(0);
    expect(errs).toHaveLength(0);
    expect(sp.last().signals).toEqual(["SIGKILL"]);
  });

  test("late onError subscriber receives an earlier error", async () => {
    const { sp, deps } = setup();
    const mic = await openMic({ kind: "local", sampleRate: 16000 }, deps);
    sp.last().close(1);
    const errs: MicError[] = [];
    mic.onError((e) => errs.push(e));
    expect(errs.map((e) => e.code)).toEqual(["EXITED"]);
  });
});

describe("openMic remote", () => {
  test("ssh exit 255 → CONNECTION with phone hint and stderr", async () => {
    const { sp, deps } = setup();
    const mic = await openMic({ kind: "remote", sampleRate: 16000, command: SSH }, deps);
    expect(sp.calls[0]).toEqual({ cmd: "ssh", args: SSH.slice(1) });
    const errs: MicError[] = [];
    mic.onError((e) => errs.push(e));
    sp.last().stderr.write("ssh: connect to host 127.0.0.1 port 8022: Connection refused\n");
    await tick();
    sp.last().close(255);
    expect(errs).toEqual([
      {
        code: "CONNECTION",
        message:
          "Phone connection failed (ssh exit 255): ssh: connect to host 127.0.0.1 port 8022: Connection refused",
        hint: PHONE_UNREACHABLE_HINT,
      },
    ]);
  });

  test("remote non-255 exit is EXITED; NO_AUDIO uses 8s", async () => {
    const a = setup();
    const mic = await openMic({ kind: "remote", sampleRate: 16000, command: SSH }, a.deps);
    const errs: MicError[] = [];
    mic.onError((e) => errs.push(e));
    a.sp.last().close(1);
    expect(errs[0]?.code).toBe("EXITED");

    const b = setup();
    const mic2 = await openMic({ kind: "remote", sampleRate: 16000, command: SSH }, b.deps);
    const errs2: MicError[] = [];
    mic2.onError((e) => errs2.push(e));
    b.clock.advance(4000);
    expect(errs2).toHaveLength(0);
    b.clock.advance(4000);
    expect(errs2[0]?.code).toBe("NO_AUDIO");
  });

  test("remote stop uses SIGTERM without error", async () => {
    const { sp, deps } = setup();
    const mic = await openMic({ kind: "remote", sampleRate: 16000, command: SSH }, deps);
    const errs: MicError[] = [];
    mic.onError((e) => errs.push(e));
    const p = mic.stop();
    expect(sp.last().signals).toEqual(["SIGTERM"]);
    sp.last().close(255);
    await p;
    expect(errs).toHaveLength(0);
  });

  test("usbAutoForward: forwards the loopback port before spawning", async () => {
    const ports: number[] = [];
    const { sp, deps } = setup({
      ensureUsbForward: async (port) => {
        ports.push(port);
        return { ok: true };
      },
    });
    await openMic({ kind: "remote", sampleRate: 16000, command: SSH, usbAutoForward: true }, deps);
    expect(ports).toEqual([8022]);
    expect(sp.calls).toHaveLength(1);
  });

  test("usbAutoForward failure rejects CONNECTION with its hint, no spawn", async () => {
    const { sp, deps } = setup({
      ensureUsbForward: async () => ({
        ok: false,
        message: "No Android phone attached over USB",
        hint: "Plug in the phone with USB debugging enabled",
      }),
    });
    await expect(
      openMic({ kind: "remote", sampleRate: 16000, command: SSH, usbAutoForward: true }, deps),
    ).rejects.toMatchObject({
      code: "CONNECTION",
      message: "No Android phone attached over USB",
      hint: "Plug in the phone with USB debugging enabled",
    });
    expect(sp.calls).toHaveLength(0);
  });

  test("usbAutoForward skipped for non-loopback hosts", async () => {
    let called = false;
    const { deps } = setup({
      ensureUsbForward: async () => {
        called = true;
        return { ok: true };
      },
    });
    await openMic(
      {
        kind: "remote",
        sampleRate: 16000,
        command: ["ssh", "-p", "8022", "u@100.1.2.3", "capture.sh"],
        usbAutoForward: true,
      },
      deps,
    );
    expect(called).toBe(false);
  });

  test("missing command rejects SPAWN_FAILED", async () => {
    const { deps } = setup();
    await expect(openMic({ kind: "remote", sampleRate: 16000 }, deps)).rejects.toMatchObject({
      code: "SPAWN_FAILED",
    });
  });
});

describe("listInputDevices", () => {
  test("macOS: parses system_profiler input devices", async () => {
    const json = JSON.stringify({
      SPAudioDataType: [
        {
          _items: [
            { _name: "MacBook Pro Microphone", coreaudio_input_source: "spaudio_default" },
            { _name: "MacBook Pro Speakers", coreaudio_output_source: "x" },
            { _name: "x", coreaudio_device_name: "USB Mic", coreaudio_input_source: "y" },
          ],
        },
      ],
    });
    const run: RunFn = async () => ({ code: 0, stdout: json, stderr: "" });
    expect(await listInputDevices({ run, platform: "darwin" })).toEqual([
      "MacBook Pro Microphone",
      "USB Mic",
    ]);
  });

  test("linux: pactl json, falls back to short; [] on failure", async () => {
    const json = JSON.stringify([{ name: "alsa_input.usb" }, { name: "alsa_output.monitor" }]);
    const ok: RunFn = async () => ({ code: 0, stdout: json, stderr: "" });
    expect(await listInputDevices({ run: ok, platform: "linux" })).toEqual(["alsa_input.usb"]);
    const fallback: RunFn = async (_c, args) =>
      args[0] === "-f"
        ? { code: 1, stdout: "", stderr: "" }
        : { code: 0, stdout: "1\tmic.a\tx\n2\tout.monitor\tx\n", stderr: "" };
    expect(await listInputDevices({ run: fallback, platform: "linux" })).toEqual(["mic.a"]);
    const bad: RunFn = async () => ({ code: 0, stdout: "not json", stderr: "" });
    expect(await listInputDevices({ run: bad, platform: "darwin" })).toEqual([]);
    expect(parsePactlSourcesShort("")).toEqual([]);
  });
});
