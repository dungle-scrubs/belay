import { selectSandboxMode } from "@trevor/session";
import { describe, expect, it } from "vitest";
import {
  buildDenyFirstProfile,
  probeSandboxEnvironment,
  SANDBOX_EXEC_PATH,
  sandboxExecCommand,
  sandboxPolicyHash,
} from "./sandbox-profile";

const PROFILE_INPUT = { runtimePath: "/usr/local/bin/node", scratchDir: "/tmp/trevor-ts-abc" };

describe("deny-first sandbox profile (M4)", () => {
  const profile = buildDenyFirstProfile(PROFILE_INPUT);

  it("denies by default and never grants network", () => {
    expect(profile).toContain("(deny default)");
    // No allow-network line anywhere - network is denied by the default.
    expect(profile).not.toMatch(/\(allow network/);
  });

  it("permits exec of ONLY the runtime binary", () => {
    expect(profile).toContain('(allow process-exec (literal "/usr/local/bin/node"))');
    // No blanket process-exec.
    expect(profile).not.toMatch(/\(allow process-exec\)\s*$/m);
  });

  it("confines writes to the scratch dir (blast-radius reduction)", () => {
    expect(profile).toContain('(allow file-write* (subpath "/tmp/trevor-ts-abc"))');
    // No unbounded file-write*.
    expect(profile).not.toMatch(/\(allow file-write\*\)\s*$/m);
  });

  it("allows the broad reads Node needs to boot (reads are not a blast-radius concern)", () => {
    expect(profile).toContain("(allow file-read*)");
  });
});

describe("sandbox launcher wrapping + diagnostics (M4)", () => {
  it("wraps an inner command under sandbox-exec with the profile", () => {
    const profile = buildDenyFirstProfile(PROFILE_INPUT);
    const cmd = sandboxExecCommand(profile, ["node", "--import", "tsx", "entry.ts"]);
    expect(cmd.slice(0, 3)).toEqual([SANDBOX_EXEC_PATH, "-p", profile]);
    expect(cmd.slice(3)).toEqual(["node", "--import", "tsx", "entry.ts"]);
  });

  it("hashes a profile to a short, path-free identifier (stable + no leaked paths)", () => {
    const hash = sandboxPolicyHash(buildDenyFirstProfile(PROFILE_INPUT));
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hash).not.toContain("/tmp");
    // Deterministic.
    expect(hash).toBe(sandboxPolicyHash(buildDenyFirstProfile(PROFILE_INPUT)));
  });
});

describe("sandbox environment probe + mode selection (M4)", () => {
  it("marks sandbox-exec available on macOS (where /usr/bin/sandbox-exec exists) and picks that mode", () => {
    const env = probeSandboxEnvironment({ platform: "darwin" });
    // On this macOS host sandbox-exec resolves; the selection then prefers it (no Safehouse installed).
    expect(env.sandboxExecAvailable).toBe(true);
    expect(selectSandboxMode(env)).toBe("sandbox-exec");
  });

  it("reports no OS sandbox off macOS and falls back to the child-process boundary", () => {
    const env = probeSandboxEnvironment({ platform: "linux" });
    expect(env.sandboxExecAvailable).toBe(false);
    expect(selectSandboxMode(env)).toBe("child-process");
  });
});
