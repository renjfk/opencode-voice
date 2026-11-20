import { describe, expect, test } from "bun:test";
import { ensureUsbForward, loopbackSshPort, parseSshArgv } from "./usb.ts";
import type { RunFn, RunResult } from "./usb.ts";

function fakeRun(results: Record<string, RunResult>): {
  run: RunFn;
  calls: { cmd: string; args: readonly string[]; timeoutMs: number }[];
} {
  const calls: { cmd: string; args: readonly string[]; timeoutMs: number }[] = [];
  const run: RunFn = async (cmd, args, timeoutMs) => {
    calls.push({ cmd, args, timeoutMs });
    const key = args[0] === "-s" ? "forward" : (args[0] ?? "");
    return results[key] ?? { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

describe("loopbackSshPort", () => {
  test("ssh to 127.0.0.1 / localhost returns -p port", () => {
    expect(loopbackSshPort(["ssh", "-p", "8022", "u0_a1@127.0.0.1", "capture.sh"])).toBe(8022);
    expect(loopbackSshPort(["/usr/bin/ssh", "-T", "-p8022", "localhost", "x"])).toBe(8022);
    expect(loopbackSshPort(["ssh", "-Tp", "2222", "me@localhost"])).toBe(2222);
    expect(loopbackSshPort(["ssh", "-o", "Port=9000", "127.0.0.1"])).toBe(9000);
    expect(loopbackSshPort(["ssh", "ssh://u@127.0.0.1:7000", "x"])).toBe(7000);
  });

  test("default port 22, option values are not taken as the host", () => {
    expect(
      loopbackSshPort(["ssh", "-i", "~/.ssh/k", "-o", "StrictHostKeyChecking=no", "u@127.0.0.1"]),
    ).toBe(22);
  });

  test("non-loopback or non-ssh returns null", () => {
    expect(loopbackSshPort(["ssh", "-p", "8022", "u@100.1.2.3", "x"])).toBeNull();
    expect(loopbackSshPort(["arecord", "-p", "8022", "localhost"])).toBeNull();
    expect(loopbackSshPort([])).toBeNull();
    expect(loopbackSshPort(["ssh", "-p", "8022"])).toBeNull();
  });

  test("parseSshArgv reports destination index", () => {
    const t = parseSshArgv(["ssh", "-i", "k", "-p", "8022", "u@h", "cmd", "16000"]);
    expect(t).toEqual({ destIndex: 5, host: "h", port: 8022 });
  });
});

describe("ensureUsbForward", () => {
  test("picks the physical device, skips emulators, forwards the port", async () => {
    const { run, calls } = fakeRun({
      devices: ok("List of devices attached\nemulator-5554\tdevice\nR58M123ABC\tdevice\n\n"),
    });
    expect(await ensureUsbForward(8022, { run })).toEqual({ ok: true });
    expect(calls[1]?.args).toEqual(["-s", "R58M123ABC", "forward", "tcp:8022", "tcp:8022"]);
    expect(calls.every((c) => c.cmd === "adb" && c.timeoutMs === 10_000)).toBe(true);
  });

  test("is idempotent: a second call forwards again without error", async () => {
    const { run, calls } = fakeRun({ devices: ok("List of devices attached\nABC\tdevice\n") });
    await ensureUsbForward(8022, { run });
    expect(await ensureUsbForward(8022, { run })).toEqual({ ok: true });
    expect(calls.filter((c) => c.args[0] === "-s")).toHaveLength(2);
  });

  test("forward failure reports stderr and the manual command", async () => {
    const { run } = fakeRun({
      devices: ok("List of devices attached\nABC\tdevice\n"),
      forward: {
        code: 1,
        stdout: "",
        stderr: "adb: error: cannot bind listener: Address in use\n",
      },
    });
    const r = await ensureUsbForward(8022, { run });
    expect(r).toEqual({
      ok: false,
      message: "adb forward tcp:8022 failed: adb: error: cannot bind listener: Address in use",
      hint: "Replug the USB cable, then run: adb forward tcp:8022 tcp:8022",
    });
  });

  test("only emulators → no phone", async () => {
    const { run } = fakeRun({ devices: ok("List of devices attached\nemulator-5554\tdevice\n") });
    const r = await ensureUsbForward(8022, { run });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe("Only emulators attached, no USB phone");
  });

  test("no device / unauthorized / multiple", async () => {
    const none = await ensureUsbForward(1, { run: fakeRun({ devices: ok("List\n") }).run });
    expect(none.ok === false && none.message).toBe("No Android phone attached over USB");
    const unauth = await ensureUsbForward(1, {
      run: fakeRun({ devices: ok("List\nABC\tunauthorized\n") }).run,
    });
    expect(unauth.ok === false && unauth.hint).toBe(
      "Unlock the phone and accept the USB debugging prompt",
    );
    const multi = await ensureUsbForward(1, {
      run: fakeRun({ devices: ok("List\nA\tdevice\nB\tdevice\n") }).run,
    });
    expect(multi.ok === false && multi.message).toBe("Multiple Android devices attached (A, B)");
  });

  test("explicit serial must be attached", async () => {
    const { run, calls } = fakeRun({ devices: ok("List\nA\tdevice\nB\tdevice\n") });
    expect(await ensureUsbForward(8022, { run, serial: "B" })).toEqual({ ok: true });
    expect(calls[1]?.args[1]).toBe("B");
    const r = await ensureUsbForward(8022, { run, serial: "Z" });
    expect(r.ok).toBe(false);
  });

  test("adb missing / adb devices failing", async () => {
    const missing = await ensureUsbForward(1, {
      run: fakeRun({
        devices: { code: null, stdout: "", stderr: "", error: { code: "ENOENT", message: "x" } },
      }).run,
    });
    expect(missing.ok === false && missing.message).toBe("adb not found on PATH");
    const failing = await ensureUsbForward(1, {
      run: fakeRun({ devices: { code: 1, stdout: "", stderr: "daemon not running\n" } }).run,
    });
    expect(failing.ok === false && failing.message).toBe("adb devices failed: daemon not running");
  });
});
