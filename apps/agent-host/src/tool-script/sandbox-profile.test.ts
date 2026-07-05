import { selectSandboxMode } from "@trevor/session";
import { describe, expect, it } from "vitest";
import {
  buildDenyFirstProfile,
  probeSandboxEnvironment,
  SANDBOX_EXEC_PATH,
  sandboxExecCommand,
  sandboxPolicyHash,
} from "./sandbox-profile";

const PROFILE_INPUT = {
  runtimePath: "/usr/local/bin/node",
  scratchDir: "/tmp/trevor-ts-abc",
  readRoots: ["/work/repo"],
};

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

  it("DENY-reads by default: no blanket file-read*, only allowlisted subpaths", () => {
    // The old blanket read is gone - a script that escaped the JS boundary cannot read $HOME secrets.
    expect(profile).not.toMatch(/\(allow file-read\*\)\s*$/m);
    // Reads are confined to explicit roots: system boot dirs, the runtime prefix, workspace, and scratch.
    expect(profile).toContain('(allow file-read* (subpath "/usr"))');
    expect(profile).toContain('(allow file-read* (subpath "/System"))');
    // The runtime install prefix (dirname(dirname(runtimePath))) is readable so Node can boot.
    expect(profile).toContain('(allow file-read* (subpath "/usr/local"))');
    // The workspace the read tools operate in is allowed.
    expect(profile).toContain('(allow file-read* (subpath "/work/repo"))');
    // The scratch dir is readable + writable.
    expect(profile).toContain('(allow file-read* (subpath "/tmp/trevor-ts-abc"))');
    // Metadata (stat) stays broadly allowed - it carries no file content.
    expect(profile).toContain("(allow file-read-metadata)");
  });

  it("does NOT allow reading the user's home secrets outside the allowlist", () => {
    // No allow line covers $HOME broadly - the crown jewels (~/.ssh, ~/.pi, ~/.trevor) stay deny-read.
    const allowedReadRoots = [
      ...profile.matchAll(/\(allow file-read\* \(subpath "([^"]+)"\)\)/g),
    ].map((m) => m[1]);
    for (const root of allowedReadRoots) {
      expect(root).not.toMatch(/\/\.ssh(\/|$)/);
      expect(root).not.toMatch(/\/\.pi(\/|$)/);
    }
    // And the home directory itself is never a blanket read root.
    expect(allowedReadRoots).not.toContain(process.env.HOME ?? "~");
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
    const env = probeSandboxEnvironment({ platform: "darwin", sandboxExecAvailable: true });
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
