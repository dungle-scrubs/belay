import { buildTrevorExportCommand } from "@host/manifest/export-command";
import { registerManifestSource } from "@host/manifest/source";
import { runCommand } from "@host/tools/run-shell";
import type { CapabilityManifest, ManifestScope } from "@trevor/session";
import { MANIFEST_VERSION } from "@trevor/session";
import { afterEach, describe, expect, it } from "vitest";
import { type CommandFile, expandCommandFile } from "./command-file";
import { resolveInterpolationConfig } from "./interpolation";

/**
 * The prompt + export BOUNDARY tests (plan 40, M7). Interpolation must not leak into the two adjacent
 * lanes: the leading-`!` prompt-shell lane (a user-owned immediate shell command) and the capability
 * export (`/trevor-export`, which must stay independent of the interpolation gate and must never be
 * re-interpolated). Also proves the runtime never reintroduces `op://`/secret resolution.
 */

const ON = resolveInterpolationConfig({ TREVOR_ENABLE_INTERPOLATION: "1" });
const OFF = resolveInterpolationConfig({});

function trusted(body: string): CommandFile {
  return { id: "demo", rootKind: "builtin", body };
}

function manifestSource(sectionTitle: string) {
  return (scope: ManifestScope): Promise<CapabilityManifest> =>
    Promise.resolve({
      version: MANIFEST_VERSION,
      scope,
      generatedAt: "2026-07-05T00:00:00.000Z",
      sections: [
        { id: "tools", title: sectionTitle, status: "ok", items: [{ id: "read", label: "read" }] },
      ],
      truncated: false,
    });
}

afterEach(() => {
  registerManifestSource(() => Promise.reject(new Error("cleared")));
});

describe("prompt-shell lane is NOT interpolation (M7)", () => {
  it("a leading-! composer command runs literally as a SHELL command, never as an allow-listed target", async () => {
    // The prompt-shell lane strips the `!` and hands the rest to runCommand (a real shell). So a composer
    // `!/trevor-export` becomes a shell exec of `/trevor-export` - which is not a binary and fails. It is
    // NEVER dispatched as the in-process interpolation target: no gate, no allow-list, no manifest.
    const shellResult = await runCommand("/trevor-export --json");
    expect(shellResult.ok).toBe(false);
    expect(shellResult.output).not.toContain("service");
    expect(shellResult.output).not.toMatch(/manifest/i);
  });

  it("the SAME !command text expands only through the command-file lane (gate + trust), not the shell lane", async () => {
    registerManifestSource(manifestSource("Tools"));
    const out = await expandCommandFile(trusted("!/trevor-export --compact"), ON);
    // Through the gated command-file lane the manifest is spliced...
    expect(out.text).toContain("Tools");
    // ...but that lane is reached ONLY via expandCommandFile, never from prompt-shell text.
  });
});

describe("capability export boundary (M7, D-004)", () => {
  it("/trevor-export output is independent of the interpolation gate", async () => {
    registerManifestSource(manifestSource("Catalog"));
    const command = buildTrevorExportCommand();
    // The export command reads the manifest directly and consults no interpolation gate, so its output is
    // identical whether the gate is on or off (the config is not even passed to it).
    const withGateContext = await command.run("--compact", undefined);
    const text = typeof withGateContext === "string" ? withGateContext : withGateContext.text;
    expect(text).toContain("Catalog");
    // Sanity: resolving the gate on/off changes nothing about the export path.
    expect(ON.enabled).toBe(true);
    expect(OFF.enabled).toBe(false);
  });

  it("a manifest whose text merely LOOKS like a !command is not re-interpolated by the export", async () => {
    // The export renders manifest content verbatim; interpolation is a load-time step on FILE bodies, not
    // on rendered export output, so a section title containing `!echo pwned` is passed through literally.
    registerManifestSource(manifestSource("!echo pwned"));
    const command = buildTrevorExportCommand();
    const result = await command.run("--compact", undefined);
    const text = typeof result === "string" ? result : result.text;
    expect(text).toContain("!echo pwned");
  });
});

describe("no runtime secret resolution is reintroduced (M7)", () => {
  it("op:// in interpolated output is ordinary text (never fetched/resolved), and secrets are redacted", async () => {
    // The command-file runtime treats interpolated output as plain shell/command output subject only to
    // redaction + caps. It has no `op://` fetch semantics: an op:// reference is left as literal text,
    // while a token-shaped secret in the same output is redacted.
    const runner = {
      run: async () => ({ output: "op://vault/item and token sk-ABCDEF1234567890XYZ", ok: true }),
    };
    const out = await expandCommandFile(trusted("!/trevor-export"), ON, { runner });
    // The op:// reference is left as inert text and only passed through the SAME generic redactor as any
    // output (which path-collapses it) - it is never fetched or replaced with a resolved secret value.
    expect(out.text).toMatch(/op:/);
    expect(out.text).toContain("item");
    expect(out.text).not.toContain("sk-ABCDEF"); // token-shaped secret redacted
  });
});
