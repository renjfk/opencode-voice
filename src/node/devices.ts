// Audio devices the voice node can listen and speak through: this Mac, Linux
// boxes over ssh (PipeWire/Pulse), and an Android phone running Termux (over
// adb-forwarded or tailnet ssh). Every device yields a MicConfig, a
// PlayerOutput and a presence probe ("how long since a human touched it").
import type { MicConfig, PlayerOutput } from "../types.ts";

export type DeviceKind = "local" | "linux" | "termux";

export interface DeviceConfig {
  readonly id: string;
  readonly label: string;
  readonly kind: DeviceKind;
  /** ssh destination (a Host alias in the node's ssh_config). */
  readonly ssh?: string;
  /** Android serial for adb (presence + port forward); "auto" = only device. */
  readonly adb?: string;
  /** adb forward port for a Termux sshd reached via 127.0.0.1. */
  readonly adbForwardPort?: number;
}

export interface CommandContext {
  /** Path of the ssh_config the node uses. */
  readonly sshConfig: string;
  readonly sampleRate: number;
}

/** Process tags: remote processes are started under these names so they can be killed exactly. */
export const MIC_TAG = "ocv-mic";
export const PLAY_TAG = "ocv-play";

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function sshArgv(ctx: CommandContext, dest: string, script: string): string[] {
  // `bash -c` so the script runs the same whatever the login shell is (fish, zsh...).
  return ["ssh", "-F", ctx.sshConfig, "-T", dest, `bash -c ${shq(script)}`];
}

const LINUX_ENV = "export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)};";

/** Termux: Termux:API records Opus/OGG continuously; the growing file is decoded live. */
export function termuxCaptureScript(rate: number): string {
  return [
    "set -u",
    `f="$TMPDIR/${MIC_TAG}-$$.ogg"`,
    "termux-microphone-record -q >/dev/null 2>&1",
    `pkill -f '^${MIC_TAG}' 2>/dev/null`,
    'rm -f "$f"',
    'termux-microphone-record -f "$f" -e opus -l 0 >/dev/null 2>&1 || { echo "termux-microphone-record failed (is Termux:API installed?)" >&2; exit 3; }',
    'for i in $(seq 60); do [ -s "$f" ] && break; sleep 0.1; done',
    '[ -s "$f" ] || { echo "microphone produced no data (mic busy or permission denied)" >&2; termux-microphone-record -q >/dev/null 2>&1; exit 4; }',
    // When the decoder ends (stop, or the ssh client went away and its next
    // write failed), end the tail too, so the pipeline and this script exit.
    `( exec -a ${MIC_TAG}-tail tail -c +1 -f "$f" ) | ( ( exec -a ${MIC_TAG} ffmpeg -hide_banner -loglevel error -f ogg -i - -f s16le -ar ${rate} -ac 1 - ); pkill -f '^${MIC_TAG}-tail' )`,
    // Always leave the phone clean: recorder off, temp file gone.
    "termux-microphone-record -q >/dev/null 2>&1",
    'rm -f "$f"',
  ].join("\n");
}

export function micConfigFor(d: DeviceConfig, ctx: CommandContext): MicConfig {
  const rate = ctx.sampleRate;
  if (d.kind === "local") return { kind: "local", sampleRate: rate, label: d.label };
  const dest = d.ssh ?? d.id;
  if (d.kind === "linux") {
    return {
      kind: "remote",
      sampleRate: rate,
      label: d.label,
      command: sshArgv(
        ctx,
        dest,
        // pw-cat/pacat pick their mode from argv0, which `exec -a` replaces:
        // the mode flag must be explicit. --raw: without it pw-cat writes a
        // Sun AU container (big-endian samples) to stdout.
        `${LINUX_ENV} exec -a ${MIC_TAG} pw-cat --record --raw --rate ${rate} --channels 1 --format s16 -`,
      ),
      killCommand: sshArgv(ctx, dest, `pkill -f '^${MIC_TAG}' ; true`),
      // SIGINT makes pw-record flush and exit.
      stopCommand: sshArgv(ctx, dest, `pkill -INT -f '^${MIC_TAG}' ; true`),
      unreachableHint: `${d.label} not reachable over ssh: check Tailscale and that the machine is awake`,
    };
  }
  return {
    kind: "remote",
    sampleRate: rate,
    label: d.label,
    command: sshArgv(ctx, dest, termuxCaptureScript(rate)),
    killCommand: sshArgv(
      ctx,
      dest,
      `termux-microphone-record -q >/dev/null 2>&1; pkill -f '^${MIC_TAG}' ; true`,
    ),
    // Stop the recorder (finalizes the file), let the decoder drain the
    // ~1 s the stream lags behind, then end the input so ffmpeg exits.
    stopCommand: sshArgv(
      ctx,
      dest,
      `termux-microphone-record -q >/dev/null 2>&1; sleep 1.5; pkill -f '^${MIC_TAG}-tail' ; true`,
    ),
    usbAutoForward: d.adbForwardPort !== undefined,
    zeroHint:
      "Android blocks the mic for background apps: open Termux on the phone and keep it on screen while you speak",
    unreachableHint: `${d.label} not reachable: open Termux on the phone and run sshd${
      d.adbForwardPort !== undefined ? " (USB: check the cable / adb)" : ""
    }`,
  };
}

export function playerOutputFor(d: DeviceConfig, ctx: CommandContext): PlayerOutput {
  if (d.kind === "local") return { kind: "local" };
  const dest = d.ssh ?? d.id;
  const rate = ctx.sampleRate;
  // Anchored: only processes started under the tag (not this shell's own cmdline).
  const kill = sshArgv(ctx, dest, `pkill -f '^${PLAY_TAG}' ; true`);
  if (d.kind === "linux") {
    return {
      kind: "remote",
      rate,
      kill,
      command: sshArgv(
        ctx,
        dest,
        `${LINUX_ENV} exec -a ${PLAY_TAG} pacat --playback --raw --format=s16le --rate=${rate} --channels=1 --latency-msec=100`,
      ),
    };
  }
  return {
    kind: "remote",
    rate,
    kill,
    command: sshArgv(
      ctx,
      dest,
      `exec -a ${PLAY_TAG} play -q -t raw -r ${rate} -c 1 -b 16 -e signed-integer -`,
    ),
  };
}

// ------------------------------------------------------------- presence

/** Result of one presence probe: seconds since last human input, or offline. */
export type Presence =
  | { readonly online: true; readonly idleSec: number; readonly caps?: AudioCaps }
  | { readonly online: false };

/** macOS `ioreg -c IOHIDSystem` → seconds since the last keyboard/mouse event. */
export function parseMacIdle(ioreg: string): number | null {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioreg);
  return m ? Number(m[1]) / 1e9 : null;
}

/**
 * Android `dumpsys power` → seconds since the user last touched the screen,
 * or Infinity when the screen is off (nobody is using it).
 */
export function parseAndroidIdle(dumpsys: string): number | null {
  const wake = /mWakefulness=(\w+)/.exec(dumpsys)?.[1];
  if (!wake) return null;
  if (wake !== "Awake") return Number.POSITIVE_INFINITY;
  // Android silences the mic of background apps: the phone only counts as
  // "in use for voice" while Termux is on screen.
  const focus = /mCurrentFocus=Window\{[^}]*\}/.exec(dumpsys)?.[0];
  if (focus !== undefined && !/com\.termux/.test(focus)) return Number.POSITIVE_INFINITY;
  const ago = /mLastInteractivePowerHintTime=\d+ \((\d+) ms ago\)/.exec(dumpsys)?.[1];
  const wakeAgo = /mLastWakeTime=\d+ \((\d+) ms ago\)/.exec(dumpsys)?.[1];
  const ms = Math.min(
    ago !== undefined ? Number(ago) : Number.POSITIVE_INFINITY,
    wakeAgo !== undefined ? Number(wakeAgo) : Number.POSITIVE_INFINITY,
  );
  return ms / 1000;
}

/** Sum of keyboard/mouse/touchpad interrupt counts from /proc/interrupts. */
export function inputInterruptCount(procInterrupts: string): number | null {
  let total = 0;
  let found = false;
  for (const line of procInterrupts.split("\n")) {
    if (!/i8042|hid|elan|syna|touchpad|keyboard|mouse/i.test(line)) continue;
    if (/xhci|ehci|uhci|nvme|ahci/i.test(line)) continue;
    const cols = line.trim().split(/\s+/).slice(1);
    for (const c of cols) {
      if (!/^\d+$/.test(c)) break;
      total += Number(c);
      found = true;
    }
  }
  return found ? total : null;
}

export const LINUX_PRESENCE_SCRIPT = [
  LINUX_ENV,
  "cat /proc/interrupts;",
  'echo "@@audio src=$(pactl get-default-source 2>/dev/null) sink=$(pactl get-default-sink 2>/dev/null) inputs=$(pactl list short sources 2>/dev/null | grep -vc monitor)"',
].join(" ");

export interface AudioCaps {
  readonly mic: boolean;
  readonly speaker: boolean;
}

/** Parse the "@@audio" line of LINUX_PRESENCE_SCRIPT. */
export function parseLinuxAudio(out: string): AudioCaps {
  const line = out.split("\n").find((l) => l.startsWith("@@audio")) ?? "";
  const src = /src=(\S*)/.exec(line)?.[1] ?? "";
  const sink = /sink=(\S*)/.exec(line)?.[1] ?? "";
  const inputs = Number(/inputs=(\d+)/.exec(line)?.[1] ?? "0");
  return {
    mic: inputs > 0 && src !== "" && !src.startsWith("@") && !/auto_null/.test(src),
    speaker: sink !== "" && !sink.startsWith("@") && !/auto_null/.test(sink),
  };
}
export const MAC_PRESENCE_ARGV = ["ioreg", "-c", "IOHIDSystem", "-d", "4"];
export const ANDROID_PRESENCE_SCRIPT =
  "dumpsys power | grep -E 'mWakefulness=|mLastInteractivePowerHintTime=|mLastWakeTime='; dumpsys window | grep mCurrentFocus; pidof sshd >/dev/null && echo sshd=up || echo sshd=down";

/** Termux sshd state from ANDROID_PRESENCE_SCRIPT output; null when not reported. */
export function parseAndroidSshd(out: string): boolean | null {
  const m = /^sshd=(up|down)$/m.exec(out);
  return m ? m[1] === "up" : null;
}

/** True when `adb forward --list` already maps tcp:P to tcp:P. */
export function hasAdbForward(list: string, port: number): boolean {
  return list.split("\n").some((l) => l.trim().endsWith(`tcp:${port} tcp:${port}`));
}
