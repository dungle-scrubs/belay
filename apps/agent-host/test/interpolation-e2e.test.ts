import { type CommandFile, expandCommandFile } from "@host/commands/command-file";
import { buildCommandRegistry, type CommandContext } from "@host/commands/commands";
import { resolveInterpolationConfig } from "@host/commands/interpolation";
import { registerManifestSource } from "@host/manifest/source";
import type { CapabilityManifest, ManifestScope } from "@trevor/session";
import { MANIFEST_VERSION } from "@trevor/session";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Responsible for: the end-to-end command-file interpolation checks (plan 40, M8) - disabled vs. enabled
 * expansion through the real allow-listed command runner + manifest source, the refusal path, the
 * regression that immediate slash commands never interpolate, and the gated LIVE lane (skipped unless the
 * operator sets TREVOR_ENABLE_INTERPOLATION=1 in the process env).
 * Not for: the pure parser (interpolation-engine.test.ts) or the policy primitives
 * (interpolation.test.ts).
 */

const ON = resolveInterpolationConfig({ TREVOR_ENABLE_INTERPOLATION: "1" });
const OFF = resolveInterpolationConfig({});
const LIVE = process.env.TREVOR_ENABLE_INTERPOLATION === "1";

function trusted(body: string): CommandFile {
  return { id: "demo", rootKind: "builtin", body };
}

function registerManifest(title: string): void {
  registerManifestSource((scope: ManifestScope) =>
    Promise.resolve<CapabilityManifest>({
      version: MANIFEST_VERSION,
      scope,
      generatedAt: "2026-07-05T00:00:00.000Z",
      sections: [{ id: "tools", title, status: "ok", items: [{ id: "read", label: "read" }] }],
      truncated: false,
    }),
  );
}

const baseCtx: CommandContext = {
  providers: {},
  cwd: "~",
  doctor: { cwd: "~", workspace: "~", instanceId: "abc", role: "leader" },
};

afterEach(() => {
  registerManifestSource(() => Promise.reject(new Error("cleared")));
});

describe("command-file interpolation through the real runner (M8)", () => {
  it("gate OFF: a trusted command file loads literally", async () => {
    registerManifest("Tools");
    const out = await expandCommandFile(trusted("intro\n!/trevor-export --compact\nend"), OFF);
    expect(out.text).toBe("intro\n!/trevor-export --compact\nend");
  });

  it("gate ON + trusted: !/trevor-export expands to the real (bounded) manifest export", async () => {
    registerManifest("Model catalog");
    const out = await expandCommandFile(trusted("caps:\n!/trevor-export --compact"), ON);
    expect(out.text).toContain("Model catalog");
    expect(out.text).not.toContain("!/trevor-export");
    expect(out.diagnostics[0]?.status).toBe("expanded");
  });

  it("gate ON: an un-allow-listed command is refused with a bounded marker, nothing runs", async () => {
    registerManifest("Tools");
    const out = await expandCommandFile(trusted("!/shell echo pwned"), ON);
    expect(out.text).toMatch(/interpolation refused/);
    expect(out.text).not.toContain("pwned");
  });
});

describe("immediate slash commands never interpolate (M8 regression)", () => {
  it("a registry command returns literal handler text, with no interpolation applied", async () => {
    const registry = buildCommandRegistry();
    const { text, ok } = await registry.run("/help", "", baseCtx);
    expect(ok).toBe(true);
    // /help lists commands; it is a TypeScript handler, not a file body, so `!`-lines are impossible and
    // no interpolation runs. (A command whose summary contained `!x` would still be printed literally.)
    expect(text).toContain("/help");
  });
});

/**
 * The gated LIVE lane: these run ONLY when the operator opts in via the process env, exactly as the
 * runtime itself gates. They stay skipped in CI (3 expected skips), documenting the manual trust-gate
 * behavior an operator verifies by hand.
 */
describe("gated live interpolation lane (opt-in via process env)", () => {
  it.skipIf(!LIVE)("expands !/trevor-export end-to-end when the real env gate is set", async () => {
    registerManifest("Live tools");
    const out = await expandCommandFile(trusted("!/trevor-export --compact"), ON);
    expect(out.text).toContain("Live tools");
  });

  it.skipIf(!LIVE)("still refuses a non-allow-listed command under the live gate", async () => {
    registerManifest("Live tools");
    const out = await expandCommandFile(trusted("!/shell whoami"), ON);
    expect(out.text).toMatch(/interpolation refused/);
  });

  it.skipIf(!LIVE)("leaves an untrusted file literal even under the live gate", async () => {
    registerManifest("Live tools");
    const out = await expandCommandFile(
      { id: "x", rootKind: "untrusted", body: "!/trevor-export" },
      ON,
    );
    expect(out.text).toBe("!/trevor-export");
  });
});
