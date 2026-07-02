import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { type HookDefinition, normalizeHooksConfig } from "./config";
import { computeHookTrustFingerprint, evaluateHookTrust, type HookTrustIo } from "./trust";

const BASE = "/repo";

function fakeIo(files: Record<string, string>): HookTrustIo {
  return {
    isFile: (path) => files[path] !== undefined,
    readFile: (path) => {
      const contents = files[path];
      if (contents === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return contents;
    },
  };
}

const guard: HookDefinition = {
  id: "guard",
  event: "PreToolUse",
  command: "./scripts/guard.sh",
  args: ["--strict"],
  timeoutMs: 5_000,
  enabled: true,
  source: "project",
};

const guardScript = resolve(BASE, "./scripts/guard.sh");

describe("computeHookTrustFingerprint - normalization stability", () => {
  test("the hash is stable across definition property order (canonical JSON)", () => {
    const reordered = {
      source: "project",
      enabled: true,
      timeoutMs: 5_000,
      args: ["--strict"],
      command: "./scripts/guard.sh",
      event: "PreToolUse",
      id: "guard",
    } as HookDefinition;
    const io = fakeIo({ [guardScript]: "#!/bin/sh\nexit 0\n" });
    expect(computeHookTrustFingerprint(reordered, BASE, io).hash).toBe(
      computeHookTrustFingerprint(guard, BASE, io).hash,
    );
  });

  test("the hash is stable across raw-config key order through normalization", () => {
    const first = normalizeHooksConfig(
      { hooks: { guard: { event: "PreToolUse", command: "node", args: ["-v"] } } },
      "project",
    ).hooks[0] as HookDefinition;
    const second = normalizeHooksConfig(
      { hooks: { guard: { args: ["-v"], command: "node", event: "PreToolUse" } } },
      "project",
    ).hooks[0] as HookDefinition;
    const io = fakeIo({});
    expect(computeHookTrustFingerprint(first, BASE, io).hash).toBe(
      computeHookTrustFingerprint(second, BASE, io).hash,
    );
  });

  test("the hash has the sha256:<hex> shape", () => {
    const { hash } = computeHookTrustFingerprint(guard, BASE, fakeIo({}));
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("computeHookTrustFingerprint - config and script changes", () => {
  test("a config change (args, timeout, event) changes the hash", () => {
    const io = fakeIo({ [guardScript]: "#!/bin/sh\nexit 0\n" });
    const base = computeHookTrustFingerprint(guard, BASE, io).hash;
    expect(computeHookTrustFingerprint({ ...guard, args: ["--lax"] }, BASE, io).hash).not.toBe(
      base,
    );
    expect(computeHookTrustFingerprint({ ...guard, timeoutMs: 9_000 }, BASE, io).hash).not.toBe(
      base,
    );
    expect(computeHookTrustFingerprint({ ...guard, event: "Stop" }, BASE, io).hash).not.toBe(base);
  });

  test("editing the referenced script changes the hash", () => {
    const before = computeHookTrustFingerprint(
      guard,
      BASE,
      fakeIo({ [guardScript]: "#!/bin/sh\nexit 0\n" }),
    );
    const after = computeHookTrustFingerprint(
      guard,
      BASE,
      fakeIo({ [guardScript]: "#!/bin/sh\nrm -rf /\n" }),
    );
    expect(after.hash).not.toBe(before.hash);
  });

  test("an arg that resolves to an existing local file is hashed too", () => {
    const policy = resolve(BASE, "./policy.json");
    const withArgFile: HookDefinition = { ...guard, command: "node", args: ["./policy.json"] };
    const before = computeHookTrustFingerprint(
      withArgFile,
      BASE,
      fakeIo({ [policy]: `{"allow":[]}` }),
    );
    const after = computeHookTrustFingerprint(
      withArgFile,
      BASE,
      fakeIo({ [policy]: `{"allow":["bash"]}` }),
    );
    expect(before.referencedFiles).toEqual(["./policy.json"]);
    expect(after.hash).not.toBe(before.hash);
  });
});

describe("computeHookTrustFingerprint - local-path rule", () => {
  test("a bare command (PATH lookup) references no files and is never missing", () => {
    const bare = computeHookTrustFingerprint(
      { ...guard, command: "node", args: ["--version"] },
      BASE,
      fakeIo({}),
    );
    expect(bare.referencedFiles).toEqual([]);
    expect(bare.missingScript).toBe(false);
  });

  test("a path-like command that does not exist is a missing script", () => {
    const missing = computeHookTrustFingerprint(guard, BASE, fakeIo({}));
    expect(missing.missingScript).toBe(true);
    expect(missing.referencedFiles).toEqual([]);
  });

  test("an absolute command path resolves as-is", () => {
    const absolute: HookDefinition = { ...guard, command: "/opt/hooks/check.sh" };
    const io = fakeIo({ "/opt/hooks/check.sh": "#!/bin/sh\n" });
    const fingerprint = computeHookTrustFingerprint(absolute, BASE, io);
    expect(fingerprint.referencedFiles).toEqual(["/opt/hooks/check.sh"]);
    expect(fingerprint.missingScript).toBe(false);
  });

  test("a relative reference resolves against the hook's base dir", () => {
    const configHome = "/home/user/.config-home";
    const io = fakeIo({ [resolve(configHome, "./scripts/guard.sh")]: "#!/bin/sh\n" });
    const fingerprint = computeHookTrustFingerprint(guard, configHome, io);
    expect(fingerprint.missingScript).toBe(false);
    expect(fingerprint.referencedFiles).toEqual(["./scripts/guard.sh"]);
  });

  test("a missing arg file is not a missing script - only the command must exist", () => {
    const io = fakeIo({ [guardScript]: "#!/bin/sh\n" });
    const fingerprint = computeHookTrustFingerprint(
      { ...guard, args: ["./not-yet-written.log"] },
      BASE,
      io,
    );
    expect(fingerprint.missingScript).toBe(false);
    expect(fingerprint.referencedFiles).toEqual(["./scripts/guard.sh"]);
  });

  test("the command and an arg naming the same file hash it once", () => {
    const io = fakeIo({ [guardScript]: "#!/bin/sh\n" });
    const fingerprint = computeHookTrustFingerprint(
      { ...guard, args: ["./scripts/guard.sh"] },
      BASE,
      io,
    );
    expect(fingerprint.referencedFiles).toEqual(["./scripts/guard.sh"]);
  });
});

describe("evaluateHookTrust", () => {
  const io = fakeIo({ [guardScript]: "#!/bin/sh\n" });
  const fingerprint = computeHookTrustFingerprint(guard, BASE, io);

  test("no stored approval means unapproved", () => {
    expect(evaluateHookTrust(fingerprint, undefined)).toBe("unapproved");
  });

  test("a stored approval matching the current hash means approved", () => {
    expect(evaluateHookTrust(fingerprint, fingerprint.hash)).toBe("approved");
  });

  test("a stored approval for a different hash means changed", () => {
    expect(evaluateHookTrust(fingerprint, "sha256:0000")).toBe("changed");
  });

  test("a missing script wins over any stored approval", () => {
    const missing = computeHookTrustFingerprint(guard, BASE, fakeIo({}));
    expect(evaluateHookTrust(missing, missing.hash)).toBe("missing-script");
  });
});
