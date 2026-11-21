import { describe, expect, test } from "bun:test";
import { fakeMic, fakePlayer } from "../testing/fakes.ts";
import type { MicConfig, PlayerOutput } from "../types.ts";
import { parseNodeConfig } from "./config.ts";
import {
  inputInterruptCount,
  micConfigFor,
  parseAndroidIdle,
  parseLinuxAudio,
  parseMacIdle,
  playerOutputFor,
  sshArgv,
  termuxCaptureScript,
  type DeviceConfig,
} from "./devices.ts";
import { createHub, HubError, type RunResult } from "./hub.ts";
import { isLoopback, isTailnetIp } from "./server.ts";
import { tailnetCandidates } from "./client.ts";

const CTX = { sshConfig: "/cfg/ssh_config", sampleRate: 16000 };
const MAC: DeviceConfig = { id: "mac", label: "Mac", kind: "local" };
const PHONE: DeviceConfig = {
  id: "phone",
  label: "Phone",
  kind: "termux",
  ssh: "phone-usb",
  adb: "S1",
  adbForwardPort: 8022,
};
const BOX: DeviceConfig = { id: "box", label: "box", kind: "linux", ssh: "box" };
const DEAF: DeviceConfig = { id: "deaf", label: "deaf", kind: "linux", ssh: "deaf" };

describe("device commands", () => {
  test("ssh argv runs the script with bash whatever the login shell", () => {
    const a = sshArgv(CTX, "box", "echo 'hi'");
    expect(a.slice(0, 5)).toEqual(["ssh", "-F", "/cfg/ssh_config", "-T", "box"]);
    expect(a[5]).toBe(`bash -c 'echo '\\''hi'\\'''`);
  });

  test("linux mic uses tagged pw-record, graceful SIGINT stop and exact kill", () => {
    const m = micConfigFor(BOX, CTX);
    expect(m.kind).toBe("remote");
    expect(m.label).toBe("box");
    expect(m.command?.join(" ")).toContain(
      "exec -a ocv-mic pw-cat --record --raw --rate 16000 --channels 1 --format s16 -",
    );
    expect(m.stopCommand?.join(" ")).toContain("pkill -INT -f '\\''^ocv-mic'\\''");
    expect(m.killCommand?.join(" ")).toContain("pkill -f '\\''^ocv-mic'\\''");
    expect(m.unreachableHint).toContain("Tailscale");
  });

  test("termux mic streams the live Opus recording and always cleans up", () => {
    const m = micConfigFor(PHONE, CTX);
    expect(m.usbAutoForward).toBe(true);
    const script = termuxCaptureScript(16000);
    expect(script).toContain('termux-microphone-record -f "$f" -e opus -l 0');
    expect(script).toContain("exec -a ocv-mic-tail tail -c +1 -f");
    expect(script).toContain("-f s16le -ar 16000 -ac 1 -");
    expect(script.trim().split("\n").at(-1)).toBe('rm -f "$f"');
    expect(m.stopCommand?.join(" ")).toContain("termux-microphone-record -q");
  });

  test("player outputs carry rate and an exact kill", () => {
    const box = playerOutputFor(BOX, CTX) as Extract<PlayerOutput, { kind: "remote" }>;
    expect(box.rate).toBe(16000);
    expect(box.command.join(" ")).toContain(
      "exec -a ocv-play pacat --playback --raw --format=s16le --rate=16000 --channels=1",
    );
    expect(box.kill?.join(" ")).toContain("^ocv-play");
    const ph = playerOutputFor(PHONE, CTX) as Extract<PlayerOutput, { kind: "remote" }>;
    expect(ph.command.join(" ")).toContain("exec -a ocv-play play -q -t raw -r 16000");
    expect(playerOutputFor(MAC, CTX)).toEqual({ kind: "local" });
  });
});

describe("presence parsers", () => {
  test("mac HIDIdleTime is nanoseconds", () => {
    expect(parseMacIdle('  |   "HIDIdleTime" = 2500000000\n')).toBe(2.5);
    expect(parseMacIdle("nothing")).toBeNull();
  });

  test("android: awake uses the last touch, screen off is never home", () => {
    const awake =
      "mWakefulness=Awake\n mLastWakeTime=1 (900000 ms ago)\n mLastInteractivePowerHintTime=2 (4000 ms ago)\n";
    expect(parseAndroidIdle(awake)).toBe(4);
    expect(parseAndroidIdle("mWakefulness=Asleep\n")).toBe(Number.POSITIVE_INFINITY);
    // Using another app on the phone: its mic is blocked for Termux, so it is not "home".
    expect(
      parseAndroidIdle(`${awake}  mCurrentFocus=Window{2 u0 com.binance.dev/x.Activity}\n`),
    ).toBe(Number.POSITIVE_INFINITY);
    expect(
      parseAndroidIdle(
        `${awake}  mCurrentFocus=Window{27 u0 com.termux/com.termux.app.TermuxActivity}\n`,
      ),
    ).toBe(4);
    expect(parseAndroidIdle("")).toBeNull();
  });

  test("linux input interrupts are summed across CPUs; storage controllers ignored", () => {
    const irq = [
      "           CPU0       CPU1",
      "  1:         10          5  IO-APIC   1-edge      i8042",
      " 12:        100         20  IO-APIC  12-edge      i8042",
      " 16:       9999       9999  PCI-MSI  xhci_hcd",
      " 95:          3          0  IR-IO-APIC 95-fasteoi ELAN1203:00",
    ].join("\n");
    expect(inputInterruptCount(irq)).toBe(138);
    expect(inputInterruptCount("  0: 5 IO-APIC timer")).toBeNull();
  });

  test("linux audio caps: auto_null and missing default source mean no audio", () => {
    expect(parseLinuxAudio("@@audio src=alsa_input.x sink=alsa_output.x inputs=1")).toEqual({
      mic: true,
      speaker: true,
    });
    expect(parseLinuxAudio("@@audio src=@DEFAULT_SOURCE@ sink=auto_null inputs=0")).toEqual({
      mic: false,
      speaker: false,
    });
    expect(parseLinuxAudio("no line")).toEqual({ mic: false, speaker: false });
  });
});

/** Scriptable presence: per device, what the probe returns. */
function hubHarness(devices: DeviceConfig[] = [MAC, PHONE, BOX, DEAF]) {
  let t = 1_000_000;
  const presence: Record<string, () => RunResult> = {
    mac: () => ({ code: 0, stdout: '"HIDIdleTime" = 30000000000', stderr: "" }),
    phone: () => ({ code: 0, stdout: "mWakefulness=Asleep", stderr: "" }),
    box: () => ({ code: 0, stdout: "1: 10 i8042\n@@audio src=a sink=b inputs=1", stderr: "" }),
    deaf: () => ({
      code: 0,
      stdout: "1: 10 i8042\n@@audio src=@DEFAULT_SOURCE@ sink=auto_null inputs=0",
      stderr: "",
    }),
  };
  const adbCalls: string[] = [];
  let forwards = "";
  const opened: MicConfig[] = [];
  const mics: ReturnType<typeof fakeMic>[] = [];
  let lastOutput: PlayerOutput | null = null;
  const player = fakePlayer();
  let pinStore: string | null = null;
  const hub = createHub({
    devices,
    ctx: CTX,
    run: async (cmd, args) => {
      const joined = [cmd, ...args].join(" ");
      if (cmd === "ioreg") return presence.mac?.() ?? { code: 1, stdout: "", stderr: "" };
      if (cmd === "adb" && args.includes("forward")) {
        adbCalls.push(args.join(" "));
        if (args.includes("--list")) return { code: 0, stdout: forwards, stderr: "" };
        forwards = "S1 tcp:8022 tcp:8022\n";
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "adb") return presence.phone?.() ?? { code: 1, stdout: "", stderr: "" };
      for (const id of ["box", "deaf"])
        if (joined.includes(` ${id} `))
          return presence[id]?.() ?? { code: 255, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    },
    openMic: async (cfg) => {
      opened.push(cfg);
      const m = fakeMic();
      mics.push(m);
      return m;
    },
    createPlayer: (getOutput) => {
      const realPlay = player.play.bind(player);
      player.play = (wav) => {
        lastOutput = getOutput();
        return realPlay(wav);
      };
      return player;
    },
    transcriber: () => ({
      transcribe: async () => "hi",
      warm: async () => {},
      describe: () => "t",
      dispose: async () => {},
    }),
    synth: () => ({
      name: "piper",
      synthesize: async () => Buffer.from("x"),
      supports: () => true,
      warm() {},
      dispose: async () => {},
    }),
    loadPin: () => pinStore,
    savePin: (id) => void (pinStore = id),
    now: () => t,
  });
  return {
    hub,
    presence,
    opened,
    mics,
    player,
    lastOutput: () => lastOutput,
    advance: (ms: number) => void (t += ms),
    pinStore: () => pinStore,
    adbCalls,
    dropForward: () => void (forwards = ""),
  };
}

describe("hub: follow me", () => {
  test("the device touched last is home; a deaf box is never chosen", async () => {
    const h = hubHarness();
    await h.hub.refresh(); // first linux sample: no change seen yet
    expect(h.hub.home().id).toBe("mac"); // mac idle 30s, phone asleep
    h.presence.phone = () => ({
      code: 0,
      stdout: "mWakefulness=Awake\nmLastInteractivePowerHintTime=1 (2000 ms ago)",
      stderr: "",
    });
    await h.hub.refresh();
    expect(h.hub.home().id).toBe("phone");
    // Someone types on box: its interrupt counter moves.
    h.advance(1000);
    h.presence.box = () => ({
      code: 0,
      stdout: "1: 99 i8042\n@@audio src=a sink=b inputs=1",
      stderr: "",
    });
    h.presence.deaf = () => ({
      code: 0,
      stdout: "1: 999 i8042\n@@audio src=@x sink=auto_null inputs=0",
      stderr: "",
    });
    await h.hub.refresh();
    expect(h.hub.home().id).toBe("box");
    const deaf = h.hub.devices().find((d) => d.id === "deaf");
    expect(deaf).toMatchObject({ online: true, mic: false, speaker: false });
  });

  test("phone without sshd is skipped; a lost USB forward is restored", async () => {
    const h = hubHarness([MAC, PHONE]);
    const awake = "mWakefulness=Awake\nmLastInteractivePowerHintTime=1 (2000 ms ago)\n";
    h.presence.phone = () => ({ code: 0, stdout: `${awake}sshd=down\n`, stderr: "" });
    await h.hub.refresh();
    // Touched most recently, but ssh would be refused: audio stays on the Mac.
    expect(h.hub.home().id).toBe("mac");
    expect(h.hub.devices().find((d) => d.id === "phone")).toMatchObject({
      mic: false,
      speaker: false,
    });
    expect(h.adbCalls).toEqual([]); // no forward work while sshd is down

    h.presence.phone = () => ({ code: 0, stdout: `${awake}sshd=up\n`, stderr: "" });
    await h.hub.refresh(); // forward missing (cable replugged): restored
    expect(h.adbCalls).toEqual(["-s S1 forward --list", "-s S1 forward tcp:8022 tcp:8022"]);
    expect(h.hub.home().id).toBe("phone");

    h.adbCalls.length = 0;
    await h.hub.refresh(); // still there: only listed
    expect(h.adbCalls).toEqual(["-s S1 forward --list"]);

    h.dropForward();
    h.adbCalls.length = 0;
    await h.hub.refresh();
    expect(h.adbCalls.at(-1)).toBe("-s S1 forward tcp:8022 tcp:8022");
  });

  test("a device that keeps failing is probed less and less often", async () => {
    const h = hubHarness([MAC, BOX]);
    let probes = 0;
    h.presence.box = () => {
      probes += 1;
      return { code: 255, stdout: "", stderr: "Permission denied (publickey,password)." };
    };
    const tick = async (ms: number) => {
      h.advance(ms);
      await h.hub.refresh();
    };
    await h.hub.refresh(); // fail 1 → wait 3 s
    await tick(1000); // not due
    expect(probes).toBe(1);
    await tick(2000); // fail 2 → wait 6 s
    await tick(3000); // not due
    expect(probes).toBe(2);
    await tick(3000); // fail 3 → wait 12 s
    expect(probes).toBe(3);
    for (let i = 0; i < 400; i++) await tick(3000); // 20 min of 3 s ticks
    // 3+6+12+...+192 s, then every 300 s: far from 400 probes.
    expect(probes).toBeLessThan(12);
    // Back online: probed every tick again.
    h.presence.box = () => {
      probes += 1;
      return { code: 0, stdout: "1: 10 i8042\n@@audio src=a sink=b inputs=1", stderr: "" };
    };
    await tick(300_000);
    const before = probes;
    await tick(3000);
    await tick(3000);
    expect(probes).toBe(before + 2);
    expect(h.hub.devices().find((d) => d.id === "box")?.online).toBe(true);
  });

  test("offline devices drop out; with nothing else the local machine stays home", async () => {
    const h = hubHarness([MAC, BOX]);
    h.presence.box = () => ({ code: 255, stdout: "", stderr: "" });
    h.presence.mac = () => ({ code: 0, stdout: '"HIDIdleTime" = 900000000000', stderr: "" });
    await h.hub.refresh();
    expect(h.hub.devices().find((d) => d.id === "box")?.online).toBe(false);
    expect(h.hub.home().id).toBe("mac");
  });

  test("pin wins over idle time, persists, and refuses unusable devices", async () => {
    const h = hubHarness();
    await h.hub.refresh();
    h.hub.pin("box");
    expect(h.hub.home().id).toBe("box");
    expect(h.pinStore()).toBe("box");
    expect(() => h.hub.pin("deaf")).toThrow(HubError);
    expect(() => h.hub.pin("nope")).toThrow("Unknown device");
    h.hub.pin(null);
    expect(h.hub.home().id).toBe("mac");
  });
});

describe("hub: shared mic and speaker", () => {
  test("mic opens on home; one session at a time; lock released on stop, kill and error", async () => {
    const h = hubHarness();
    await h.hub.refresh();
    h.hub.pin("box");
    const a = await h.hub.openMic("duy:opencode");
    expect(a.device.id).toBe("box");
    expect(h.opened[0]?.label).toBe("box");
    expect(h.hub.micOwner()).toBe("duy:opencode");
    await expect(h.hub.openMic("mac:opencode")).rejects.toThrow("in use by duy:opencode");
    await a.mic.stop();
    expect(h.hub.micOwner()).toBeNull();
    const b = await h.hub.openMic("mac:opencode");
    b.mic.kill();
    expect(h.hub.micOwner()).toBeNull();
    await h.hub.openMic("x");
    h.mics.at(-1)?.fail({ code: "EXITED", message: "gone" });
    expect(h.hub.micOwner()).toBeNull();
  });

  test("mic open failure releases the lock and reports the hint", async () => {
    const h = hubHarness();
    const failing = createHub({
      devices: [MAC],
      ctx: CTX,
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      openMic: async () => {
        throw Object.assign(new Error("Phone not reachable"), { hint: "run sshd" });
      },
      createPlayer: () => h.player,
      transcriber: () => {
        throw new Error("unused");
      },
      synth: () => {
        throw new Error("unused");
      },
    });
    const err = await failing.openMic("a").catch((e: unknown) => e as HubError);
    expect(err).toBeInstanceOf(HubError);
    expect((err as HubError).hint).toBe("run sshd");
    expect(failing.micOwner()).toBeNull();
  });

  test("the speaker follows home at the start of each clip", async () => {
    const h = hubHarness();
    await h.hub.refresh();
    void h.hub.player.play(Buffer.from("a"));
    expect(h.lastOutput()).toEqual({ kind: "local" });
    h.hub.pin("phone");
    void h.hub.player.play(Buffer.from("b"));
    expect(h.lastOutput()?.kind).toBe("remote");
    expect(h.hub.playerDevice()).toBe("phone");
  });

  test("VieNeu requests from several clients run one at a time, each with its voice", async () => {
    const order: string[] = [];
    let voice = "";
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const hub = createHub({
      devices: [MAC],
      ctx: CTX,
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      openMic: async () => fakeMic(),
      createPlayer: () => fakePlayer(),
      transcriber: () => {
        throw new Error("unused");
      },
      synth: () => ({
        name: "vieneu",
        async synthesize(seg) {
          order.push(`start ${seg.text} as ${voice}`);
          if (seg.text === "one") await gate;
          order.push(`end ${seg.text}`);
          return Buffer.from(seg.text);
        },
        supports: () => true,
        warm() {},
        dispose: async () => {},
      }),
      setVieneuVoice: (v) => void (voice = v),
    });
    const p1 = hub.synthesize("vieneu", { lang: "vi", text: "one" }, undefined, "Mai Anh");
    const p2 = hub.synthesize("vieneu", { lang: "vi", text: "two" }, undefined, "Ngọc");
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(["start one as Mai Anh"]);
    release();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["start one as Mai Anh", "end one", "start two as Ngọc", "end two"]);
  });
});

describe("network helpers", () => {
  test("only loopback and Tailscale ranges pass the address check", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isTailnetIp("100.67.7.5")).toBe(true);
    expect(isTailnetIp("::ffff:100.85.35.10")).toBe(true);
    expect(isTailnetIp("100.63.0.1")).toBe(false); // outside 100.64/10
    expect(isTailnetIp("192.168.1.6")).toBe(false);
    expect(isTailnetIp("fd7a:115c:a1e0::1")).toBe(true);
  });

  test("tailnet candidates: online computers only", () => {
    const status = JSON.stringify({
      Peer: {
        a: { Online: true, OS: "macOS", TailscaleIPs: ["100.75.30.92", "fd7a::1"] },
        b: { Online: true, OS: "android", TailscaleIPs: ["100.107.124.2"] },
        c: { Online: false, OS: "linux", TailscaleIPs: ["100.108.47.10"] },
        d: { Online: true, OS: "linux", TailscaleIPs: ["100.67.7.5"] },
      },
    });
    expect(tailnetCandidates(status).sort()).toEqual(["100.67.7.5", "100.75.30.92"]);
    expect(tailnetCandidates("not json")).toEqual([]);
  });

  test("node config: devices validated, local added, defaults", () => {
    const c = parseNodeConfig(
      {
        devices: [
          { id: "phone", kind: "termux", ssh: "phone-usb", adbForwardPort: 8022 },
          { id: "phone", kind: "linux" }, // duplicate id
          { id: "x", kind: "windows" }, // unsupported
        ],
      },
      "/cfg",
    );
    expect(c.devices.map((d) => d.id)).toEqual(["local", "phone"]);
    expect(c.port).toBe(47800);
    expect(c.sshConfig).toBe("/cfg/ssh_config");
    expect(c.devices[1]).toMatchObject({ adbForwardPort: 8022, label: "phone" });
  });
});
