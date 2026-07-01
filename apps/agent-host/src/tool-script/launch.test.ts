import type { SandboxEnvironment } from "@trevor/session";
import { describe, expect, it } from "vitest";
import { resolveRunnerLaunch } from "./launch";
import { SANDBOX_EXEC_PATH } from "./sandbox-profile";

const RUNTIME = ["/usr/bin/node", "--import", "tsx", "entry.ts"];
const macOsWithSandbox: SandboxEnvironment = {
  platform: "darwin",
  safehouseAvailable: false,
  sandboxExecAvailable: true,
};
const linuxNoSandbox: SandboxEnvironment = {
  platform: "linux",
  safehouseAvailable: false,
  sandboxExecAvailable: false,
};

describe("tool_script launch resolution + sandbox fallback (M4)", () => {
  it("wraps the command in sandbox-exec + reports a policy hash when the profile boots", async () => {
    const resolved = await resolveRunnerLaunch({
      scratchDir: "/tmp/s",
      env: macOsWithSandbox,
      runtimeCommand: RUNTIME,
      probe: () => Promise.resolve(true),
    });
    if (!resolved.ok) {
      throw new Error(`expected a launch, got refusal: ${resolved.reason}`);
    }
    expect(resolved.sandboxMode).toBe("sandbox-exec");
    expect(resolved.command[0]).toBe(SANDBOX_EXEC_PATH);
    expect(resolved.command).toContain("entry.ts");
    expect(resolved.policyHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("FAILS CLOSED (refuses) by default when the sandbox profile cannot boot", async () => {
    const resolved = await resolveRunnerLaunch({
      scratchDir: "/tmp/s",
      env: macOsWithSandbox,
      runtimeCommand: RUNTIME,
      probe: () => Promise.resolve(false),
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      throw new Error("expected a refusal");
    }
    expect(resolved.reason).toContain("no OS sandbox");
  });

  it("FAILS CLOSED (refuses) by default off macOS", async () => {
    const resolved = await resolveRunnerLaunch({
      scratchDir: "/tmp/s",
      env: linuxNoSandbox,
      runtimeCommand: RUNTIME,
    });
    expect(resolved.ok).toBe(false);
  });

  it("DEGRADES to the child-process command when unsandboxed is explicitly allowed", async () => {
    const resolved = await resolveRunnerLaunch({
      scratchDir: "/tmp/s",
      env: macOsWithSandbox,
      runtimeCommand: RUNTIME,
      probe: () => Promise.resolve(false),
      allowUnsandboxed: true,
    });
    if (!resolved.ok) {
      throw new Error(`expected a launch, got refusal: ${resolved.reason}`);
    }
    // Falls back to the plain runtime command (no sandbox-exec wrapper), reported honestly.
    expect(resolved.sandboxMode).toBe("child-process");
    expect(resolved.command).toEqual(RUNTIME);
    expect(resolved.policyHash).toBeUndefined();
  });

  it("uses the plain child-process command off macOS without probing when unsandboxed is allowed", async () => {
    let probed = false;
    const resolved = await resolveRunnerLaunch({
      scratchDir: "/tmp/s",
      env: linuxNoSandbox,
      runtimeCommand: RUNTIME,
      allowUnsandboxed: true,
      probe: () => {
        probed = true;
        return Promise.resolve(true);
      },
    });
    if (!resolved.ok) {
      throw new Error(`expected a launch, got refusal: ${resolved.reason}`);
    }
    expect(resolved.sandboxMode).toBe("child-process");
    expect(resolved.command).toEqual(RUNTIME);
    expect(probed).toBe(false);
  });
});
