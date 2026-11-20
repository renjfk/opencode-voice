// USB (adb) forward for phone-over-USB ssh. A remote command that targets
// localhost through ssh -p P needs `adb forward tcp:P tcp:P` to reach the
// phone's sshd. All execution is argv-based (no shell) and bounded.

import { execFile } from "node:child_process";

export interface RunResult {
  /** Exit code; null when the process could not run or was killed. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the binary could not run (ENOENT, timeout, ...). */
  readonly error?: { readonly code?: string; readonly message: string };
}

export type RunFn = (cmd: string, args: readonly string[], timeoutMs: number) => Promise<RunResult>;

export const defaultRun: RunFn = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(cmd, [...args], { timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ code: 0, stdout, stderr });
      } else if (typeof err.code === "number") {
        resolve({ code: err.code, stdout, stderr });
      } else {
        resolve({ code: null, stdout, stderr, error: { code: err.code, message: err.message } });
      }
    });
  });

export interface SshTarget {
  /** Index of the destination argument in argv. */
  readonly destIndex: number;
  readonly host: string;
  readonly port: number;
}

// ssh options that consume a value (from ssh(1)).
const SSH_VALUE_OPTS = new Set("BbcDEeFIiJLlmOoPpQRSWw");

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Parse an ssh argv: destination index, host (no user), port. null if not ssh. */
export function parseSshArgv(argv: readonly string[]): SshTarget | null {
  const bin = argv[0];
  if (bin === undefined || basename(bin) !== "ssh") return null;
  let port: number | null = null;
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) break;
    if (tok === "--") {
      const dest = argv[i + 1];
      return dest === undefined ? null : target(i + 1, dest, port);
    }
    if (tok.startsWith("-") && tok.length > 1) {
      // Combined flags like -Tp8022 or -T -p 8022.
      for (let j = 1; j < tok.length; j++) {
        const ch = tok.charAt(j);
        if (!SSH_VALUE_OPTS.has(ch)) continue;
        let value = tok.slice(j + 1);
        if (value === "") {
          i += 1;
          value = argv[i] ?? "";
        }
        if (ch === "p") port = toPort(value) ?? port;
        if (ch === "o") {
          const m = /^port[=\s]\s*(\d+)$/i.exec(value.trim());
          if (m?.[1] !== undefined && port === null) port = toPort(m[1]);
        }
        break;
      }
      continue;
    }
    return target(i, tok, port);
  }
  return null;
}

function toPort(v: string): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function target(destIndex: number, dest: string, port: number | null): SshTarget {
  let host = dest;
  let urlPort: number | null = null;
  if (host.startsWith("ssh://")) {
    host = host.slice(6);
    const m = /:(\d+)$/.exec(host);
    if (m?.[1] !== undefined) {
      urlPort = toPort(m[1]);
      host = host.slice(0, m.index);
    }
  }
  const at = host.lastIndexOf("@");
  if (at >= 0) host = host.slice(at + 1);
  return { destIndex, host, port: port ?? urlPort ?? 22 };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Port of an ssh command that targets this machine (localhost/127.0.0.1), else null. */
export function loopbackSshPort(argv: readonly string[]): number | null {
  const t = parseSshArgv(argv);
  if (!t || !LOOPBACK.has(t.host.toLowerCase())) return null;
  return t.port;
}

export type UsbForwardResult = { ok: true } | { ok: false; message: string; hint: string };

export interface UsbDeps {
  readonly run?: RunFn;
  readonly timeoutMs?: number;
  /** Explicit device serial; otherwise the single attached physical device. */
  readonly serial?: string;
}

const ADB_MISSING: UsbForwardResult = {
  ok: false,
  message: "adb not found on PATH",
  hint: "Install Android platform-tools: brew install android-platform-tools",
};

function lastLine(s: string): string {
  return s.trim().split("\n").pop()?.trim() ?? "";
}

/** Ensure `adb -s <serial> forward tcp:P tcp:P`. Re-running is harmless (adb replaces it). */
export async function ensureUsbForward(
  port: number,
  deps: UsbDeps = {},
): Promise<UsbForwardResult> {
  const run = deps.run ?? defaultRun;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const spec = `tcp:${port}`;

  const listed = await run("adb", ["devices"], timeoutMs);
  if (listed.error?.code === "ENOENT") return ADB_MISSING;
  if (listed.code !== 0) {
    const why = lastLine(listed.stderr) || listed.error?.message || `exit ${listed.code}`;
    return {
      ok: false,
      message: `adb devices failed: ${why}`,
      hint: "Restart adb: adb kill-server && adb start-server",
    };
  }

  const ready: string[] = [];
  const unauthorized: string[] = [];
  let emulators = 0;
  for (const line of listed.stdout.split("\n")) {
    const m = /^(\S+)\s+(\S+)$/.exec(line.trim());
    if (!m?.[1] || !m[2]) continue;
    const [, serial, state] = m;
    if (serial.startsWith("emulator-")) {
      emulators += 1;
      continue;
    }
    if (state === "device") ready.push(serial);
    else if (state === "unauthorized") unauthorized.push(serial);
  }

  let serial: string;
  if (deps.serial) {
    if (!ready.includes(deps.serial)) {
      return {
        ok: false,
        message: `Android device ${deps.serial} is not attached`,
        hint: "Plug in the phone or fix the configured device serial",
      };
    }
    serial = deps.serial;
  } else if (ready.length === 1 && ready[0] !== undefined) {
    serial = ready[0];
  } else if (ready.length > 1) {
    return {
      ok: false,
      message: `Multiple Android devices attached (${ready.join(", ")})`,
      hint: "Unplug the extra devices so only the phone is attached",
    };
  } else if (unauthorized.length > 0) {
    return {
      ok: false,
      message: "Phone is attached but USB debugging is not authorized",
      hint: "Unlock the phone and accept the USB debugging prompt",
    };
  } else {
    return {
      ok: false,
      message:
        emulators > 0
          ? "Only emulators attached, no USB phone"
          : "No Android phone attached over USB",
      hint: "Plug in the phone with USB debugging enabled",
    };
  }

  const fwd = await run("adb", ["-s", serial, "forward", spec, spec], timeoutMs);
  if (fwd.error?.code === "ENOENT") return ADB_MISSING;
  if (fwd.code !== 0) {
    const why = lastLine(fwd.stderr) || fwd.error?.message || `exit ${fwd.code}`;
    return {
      ok: false,
      message: `adb forward ${spec} failed: ${why}`,
      hint: `Replug the USB cable, then run: adb forward ${spec} ${spec}`,
    };
  }
  return { ok: true };
}
