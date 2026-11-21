import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { PlayEnd, PlayerOutput } from "../types.ts";
import type { SpawnFn } from "./mic.ts";
import { createPlayer, remoteKillArgv, remoteRate } from "./player.ts";
import type { PlayerDeps } from "./player.ts";
import { wrapPcm } from "./wav.ts";

class FakeChild extends EventEmitter {
  pid = 7;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  received: Buffer[] = [];
  constructor(
    readonly cmd: string,
    readonly args: readonly string[],
  ) {
    super();
    this.stdin.on("data", (c: Buffer) => this.received.push(c));
  }
  kill(sig: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(sig);
    return true;
  }
  close(code: number | null, sig: NodeJS.Signals | null = null): void {
    this.emit("close", code, sig);
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

// 2 seconds of silence at 16 kHz.
const WAV = wrapPcm(Buffer.alloc(64000), 16000);
const REMOTE = ["ssh", "-i", "k", "-p", "8022", "u@127.0.0.1", "$HOME/bin/playback.sh", "24000"];

function harness(output: PlayerOutput, extra: Partial<PlayerDeps> = {}) {
  const children: FakeChild[] = [];
  let t = 1000;
  const kills: (readonly string[])[] = [];
  const killResolvers: (() => void)[] = [];
  const spawn: SpawnFn = (cmd, args) => {
    const c = new FakeChild(cmd, args);
    children.push(c);
    return c;
  };
  const deps: PlayerDeps = {
    spawn,
    now: () => t,
    remoteKill: (command) =>
      new Promise<void>((resolve) => {
        kills.push(command);
        killResolvers.push(resolve);
      }),
    ...extra,
  };
  let out = output;
  const player = createPlayer(() => out, deps);
  return {
    player,
    children,
    kills,
    resolveKills: () => killResolvers.splice(0).forEach((r) => r()),
    advance: (ms: number) => {
      t += ms;
    },
    setOutput: (o: PlayerOutput) => {
      out = o;
    },
    byCmd: (cmd: string) => children.filter((c) => c.cmd === cmd),
  };
}

function track(p: Promise<PlayEnd>): { result: PlayEnd | Error | null } {
  const box: { result: PlayEnd | Error | null } = { result: null };
  p.then(
    (r) => {
      box.result = r;
    },
    (e: Error) => {
      box.result = e;
    },
  );
  return box;
}

describe("player local", () => {
  test("plays via sox on stdin and resolves ended on natural close", async () => {
    const h = harness({ kind: "local" });
    const p = h.player.play(WAV);
    const sox = h.children[0];
    expect(sox?.cmd).toBe("sox");
    expect(sox?.args).toEqual(["-q", "--buffer", "1024", "-t", "wav", "-", "-d"]);
    await tick();
    expect(Buffer.concat(sox?.received ?? []).equals(WAV)).toBe(true);
    expect(h.player.status()).toBe("playing");
    expect(h.player.durationSec()).toBe(2);
    h.advance(500);
    expect(h.player.positionSec()).toBeCloseTo(0.5, 6);
    sox?.close(0);
    expect(await p).toBe("ended");
    expect(h.player.status()).toBe("idle");
  });

  test("pause SIGSTOPs and freezes position; resume SIGCONTs", () => {
    const h = harness({ kind: "local" });
    void h.player.play(WAV);
    h.advance(700);
    expect(h.player.pause()).toBe(true);
    expect(h.player.pause()).toBe(false);
    h.advance(5000);
    expect(h.player.positionSec()).toBeCloseTo(0.7, 6);
    expect(h.player.resume()).toBe(true);
    h.advance(300);
    expect(h.player.positionSec()).toBeCloseTo(1.0, 6);
    expect(h.children[0]?.signals).toEqual(["SIGSTOP", "SIGCONT"]);
    expect(h.children).toHaveLength(1);
  });

  test("play supersedes: previous resolves stopped, its stale close is ignored", async () => {
    const h = harness({ kind: "local" });
    const first = h.player.play(WAV);
    const second = track(h.player.play(WAV));
    expect(await first).toBe("stopped");
    expect(h.children[0]?.signals).toContain("SIGKILL");
    h.children[0]?.close(null, "SIGKILL");
    await tick();
    expect(second.result).toBeNull();
    expect(h.player.status()).toBe("playing");
    h.children[1]?.close(0);
    await tick();
    expect(second.result).toBe("ended");
  });

  test("stop resolves stopped, late close does not change state", async () => {
    const h = harness({ kind: "local" });
    const p = h.player.play(WAV);
    h.player.stop();
    expect(await p).toBe("stopped");
    expect(h.player.status()).toBe("idle");
    h.children[0]?.close(0);
    expect(h.player.status()).toBe("idle");
    expect(h.kills).toHaveLength(0);
  });

  test("spawn ENOENT rejects with install hint", async () => {
    const h = harness({ kind: "local" });
    const p = h.player.play(WAV);
    h.children[0]?.emit("error", Object.assign(new Error("spawn sox ENOENT"), { code: "ENOENT" }));
    h.children[0]?.close(-2);
    await expect(p).rejects.toThrow("sox not found: install it with brew install sox");
  });

  test("non-zero exit rejects with stderr tail", async () => {
    const h = harness({ kind: "local" });
    const p = h.player.play(WAV);
    h.children[0]?.stderr.write("sox FAIL sox: no default audio device\n");
    await tick();
    h.children[0]?.close(1);
    await expect(p).rejects.toThrow(
      "Playback failed (sox exit 1): sox FAIL sox: no default audio device",
    );
  });

  test("invalid WAV rejects; dispose refuses further plays", async () => {
    const h = harness({ kind: "local" });
    await expect(h.player.play(Buffer.from("nope"))).rejects.toThrow("not a valid WAV");
    const p = h.player.play(WAV);
    h.player.dispose();
    expect(await p).toBe("stopped");
    expect(await h.player.play(WAV)).toBe("stopped");
    expect(h.children).toHaveLength(1);
    expect(h.player.resume()).toBe(false);
  });
});

describe("player remote", () => {
  test("pipes ffmpeg s16le at the command's rate into the remote command", async () => {
    const h = harness({ kind: "remote", command: REMOTE });
    void h.player.play(WAV);
    const [ssh] = h.byCmd("ssh");
    const [ff] = h.byCmd("ffmpeg");
    expect(ssh?.args).toEqual(REMOTE.slice(1));
    expect(ff?.args).toContain("24000");
    expect(ff?.args).not.toContain("-ss");
    await tick();
    expect(Buffer.concat(ff?.received ?? []).equals(WAV)).toBe(true);
    ff?.stdout.end(Buffer.from([1, 2, 3, 4]));
    await tick();
    expect(Buffer.concat(ssh?.received ?? [])).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  test("pause kills both ends; killed close keeps it paused; resume respawns at offset after kill", async () => {
    const h = harness({ kind: "remote", command: REMOTE });
    const p = track(h.player.play(WAV));
    h.advance(1250);
    expect(h.player.pause()).toBe(true);
    const [ssh1] = h.byCmd("ssh");
    const [ff1] = h.byCmd("ffmpeg");
    expect(ssh1?.signals).toContain("SIGKILL");
    expect(ff1?.signals).toContain("SIGKILL");
    expect(h.kills).toEqual([REMOTE]);

    // The killed ssh's close arrives: must not end the utterance.
    ssh1?.close(null, "SIGKILL");
    await tick();
    expect(p.result).toBeNull();
    expect(h.player.status()).toBe("paused");
    expect(h.player.positionSec()).toBeCloseTo(1.25, 6);

    // Resume waits for the remote kill before respawning.
    expect(h.player.resume()).toBe(true);
    await tick();
    expect(h.byCmd("ssh")).toHaveLength(1);
    h.resolveKills();
    await tick();
    expect(h.byCmd("ssh")).toHaveLength(2);
    const ff2 = h.byCmd("ffmpeg")[1];
    expect(ff2?.args.slice(3, 5)).toEqual(["-ss", "1.250"]);
    h.advance(250);
    expect(h.player.positionSec()).toBeCloseTo(1.5, 6);

    h.byCmd("ssh")[1]?.close(0);
    await tick();
    expect(p.result).toBe("ended");
  });

  test("pause again before the kill settles cancels the pending respawn", async () => {
    const h = harness({ kind: "remote", command: REMOTE });
    void h.player.play(WAV);
    h.player.pause();
    h.player.resume();
    expect(h.player.pause()).toBe(true);
    h.resolveKills();
    await tick();
    expect(h.byCmd("ssh")).toHaveLength(1);
    expect(h.player.status()).toBe("paused");
  });

  test("new play over remote playback kills remote audio first (no overlap)", async () => {
    const h = harness({ kind: "remote", command: REMOTE });
    const first = h.player.play(WAV);
    const second = track(h.player.play(WAV));
    expect(await first).toBe("stopped");
    expect(h.kills).toHaveLength(1);
    expect(h.byCmd("ssh")).toHaveLength(1);
    h.resolveKills();
    await tick();
    expect(h.byCmd("ssh")).toHaveLength(2);
    h.byCmd("ssh")[0]?.close(null, "SIGKILL");
    await tick();
    expect(second.result).toBeNull();
  });

  test("play after natural end does not run a remote kill", async () => {
    const h = harness({ kind: "remote", command: REMOTE });
    const p = h.player.play(WAV);
    h.byCmd("ssh")[0]?.close(0);
    expect(await p).toBe("ended");
    void h.player.play(WAV);
    expect(h.kills).toHaveLength(0);
    expect(h.byCmd("ssh")).toHaveLength(2);
  });

  test("stop kills local and remote", async () => {
    const h = harness({ kind: "remote", command: REMOTE });
    const p = h.player.play(WAV);
    h.player.stop();
    expect(await p).toBe("stopped");
    expect(h.byCmd("ssh")[0]?.signals).toContain("SIGKILL");
    expect(h.kills).toEqual([REMOTE]);
  });

  test("output is read per spawn (switch speaker live)", () => {
    const h = harness({ kind: "local" });
    void h.player.play(WAV);
    h.setOutput({ kind: "remote", command: REMOTE });
    void h.player.play(WAV);
    expect(h.children.map((c) => c.cmd)).toEqual(["sox", "ssh", "ffmpeg"]);
  });
});

describe("helpers", () => {
  test("remoteKillArgv reuses the ssh target", () => {
    expect(remoteKillArgv(REMOTE)).toEqual([
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=3",
      "-i",
      "k",
      "-p",
      "8022",
      "u@127.0.0.1",
      "killall play 2>/dev/null; killall mpv 2>/dev/null; pkill -f '[p]layback.sh' 2>/dev/null; true",
    ]);
    expect(remoteKillArgv(["paplay"])).toBeNull();
  });

  test("remoteRate parses the last arg, else fallback", () => {
    expect(remoteRate(REMOTE, 16000)).toBe(24000);
    expect(remoteRate(["ssh", "h", "play.sh"], 16000)).toBe(16000);
    expect(remoteRate(["ssh", "h", "1"], 22050)).toBe(22050);
  });
});

describe("speed and seek", () => {
  test("speed respawns sox at the current position with tempo, position advances faster", async () => {
    const h = harness({ kind: "local" });
    void h.player.play(WAV);
    h.advance(500);
    h.player.setRate(1.5);
    const sox = h.byCmd("sox");
    expect(sox.length).toBe(2);
    expect(sox[0]?.signals).toContain("SIGKILL");
    expect(sox[1]?.args.join(" ")).toContain("trim 0.500 tempo -s 1.5");
    h.advance(400);
    expect(h.player.positionSec()).toBeCloseTo(1.1, 5);
    expect(h.player.rate()).toBe(1.5);
  });

  test("the killed process's close never ends the clip after a speed change", async () => {
    const h = harness({ kind: "local" });
    const t = track(h.player.play(WAV));
    h.player.setRate(2);
    h.byCmd("sox")[0]?.close(null, "SIGKILL");
    await tick();
    expect(t.result).toBeNull();
    expect(h.player.status()).toBe("playing");
  });

  test("speed change while paused applies on resume, from the paused position", () => {
    const h = harness({ kind: "local" });
    void h.player.play(WAV);
    h.advance(800);
    h.player.pause();
    h.player.setRate(0.75);
    expect(h.player.status()).toBe("paused");
    expect(h.byCmd("sox").length).toBe(1);
    h.player.resume();
    const sox = h.byCmd("sox");
    expect(sox.length).toBe(2);
    expect(sox[1]?.args.join(" ")).toContain("trim 0.800 tempo -s 0.75");
  });

  test("seek forward/back clamps at 0 and keeps playing", () => {
    const h = harness({ kind: "local" });
    void h.player.play(WAV);
    h.advance(1000);
    expect(h.player.seek(h.player.positionSec() - 5)).toBe(true);
    expect(h.byCmd("sox")[1]?.args.includes("trim")).toBe(false); // clamped to 0
    expect(h.player.positionSec()).toBe(0);
    h.player.seek(1.25);
    expect(h.byCmd("sox")[2]?.args.join(" ")).toContain("trim 1.250");
  });

  test("seek past the end finishes the clip as ended", async () => {
    const h = harness({ kind: "local" });
    const t = track(h.player.play(WAV));
    h.player.seek(10);
    await tick();
    expect(t.result).toBe("ended");
    expect(h.player.status()).toBe("idle");
  });

  test("seek while paused stays paused and resumes at the new spot", () => {
    const h = harness({ kind: "local" });
    void h.player.play(WAV);
    h.player.pause();
    h.player.seek(1.5);
    expect(h.player.status()).toBe("paused");
    expect(h.player.positionSec()).toBe(1.5);
    h.player.resume();
    expect(h.byCmd("sox")[1]?.args.join(" ")).toContain("trim 1.500");
  });

  test("remote: speed uses ffmpeg atempo and silences the phone before respawning", async () => {
    const h = harness({ kind: "remote", command: REMOTE });
    void h.player.play(WAV);
    h.player.setRate(1.25);
    expect(h.kills.length).toBe(1);
    expect(h.byCmd("ffmpeg").length).toBe(1); // waits for the remote kill
    h.resolveKills();
    await tick();
    const ff = h.byCmd("ffmpeg");
    expect(ff.length).toBe(2);
    expect(ff[1]?.args.join(" ")).toContain("-af atempo=1.25");
  });

  test("rate is clamped and kept across clips; nothing loaded = seek false", () => {
    const h = harness({ kind: "local" });
    expect(h.player.seek(1)).toBe(false);
    h.player.setRate(9);
    expect(h.player.rate()).toBe(2);
    void h.player.play(WAV);
    expect(h.byCmd("sox")[0]?.args.join(" ")).toContain("tempo -s 2");
  });
});
