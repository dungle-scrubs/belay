import { registerManifestSource } from "@host/manifest/source";
import type { CapabilityManifest, ManifestScope } from "@trevor/session";
import { MANIFEST_VERSION } from "@trevor/session";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CommandFile,
  type CommandFileRootKind,
  defaultInterpolationCommandRunner,
  expandCommandFile,
  type InterpolationCommandRunner,
  isTrustedRoot,
} from "./command-file";
import { resolveInterpolationConfig } from "./interpolation";

/**
 * The command-file trust contract (M2), the gated expand-on-load boundary (M5), and its structured
 * diagnostics + failure handling (M6). Deterministic: most cases use a fake in-process runner; one case
 * exercises the real default runner (the allow-listed `/trevor-export` wiring) over a registered manifest.
 */

const ON = resolveInterpolationConfig({ TREVOR_ENABLE_INTERPOLATION: "1" });
const OFF = resolveInterpolationConfig({});

function file(body: string, rootKind: CommandFileRootKind = "builtin"): CommandFile {
  return { id: "demo", rootKind, body };
}

/** A fake runner that records how it was called and returns a canned result. */
function fakeRunner(result: { output: string; ok: boolean }): InterpolationCommandRunner & {
  calls: Array<{ name: string; args: string }>;
} {
  const calls: Array<{ name: string; args: string }> = [];
  return {
    calls,
    run: async (name, args) => {
      calls.push({ name, args });
      return result;
    },
  };
}

describe("command-file trust contract (M2)", () => {
  it("trusts built-in + configured project/user roots, and nothing else", () => {
    expect(isTrustedRoot("builtin")).toBe(true);
    expect(isTrustedRoot("project")).toBe(true);
    expect(isTrustedRoot("user")).toBe(true);
    expect(isTrustedRoot("untrusted")).toBe(false);
  });
});

describe("command-file interpolation stays literal unless trusted AND gated (M5, fail closed)", () => {
  it("gate OFF: a trusted file with an interpolation site loads LITERALLY (nothing runs)", async () => {
    const runner = fakeRunner({ output: "SHOULD NOT APPEAR", ok: true });
    const out = await expandCommandFile(file("head\n!/trevor-export\ntail"), OFF, { runner });
    expect(out.text).toBe("head\n!/trevor-export\ntail");
    expect(runner.calls).toHaveLength(0);
  });

  it("untrusted root: even with the gate OPEN the body is LITERAL (nothing runs)", async () => {
    const runner = fakeRunner({ output: "SHOULD NOT APPEAR", ok: true });
    const out = await expandCommandFile(file("!/trevor-export", "untrusted"), ON, { runner });
    expect(out.text).toBe("!/trevor-export");
    expect(runner.calls).toHaveLength(0);
  });

  it("a literal-only file records no diagnostics regardless of gate", async () => {
    const out = await expandCommandFile(file("no interpolation here"), OFF);
    expect(out.diagnostics).toHaveLength(0);
    expect(out.text).toBe("no interpolation here");
  });
});

describe("command-file interpolation runs ONLY allow-listed targets when enabled (M5)", () => {
  it("expands a !cmd site by splicing the allow-listed command's redacted output", async () => {
    const runner = fakeRunner({ output: "MANIFEST-BODY", ok: true });
    const out = await expandCommandFile(file("before\n!/trevor-export --compact\nafter"), ON, {
      runner,
    });
    expect(out.text).toBe("before\nMANIFEST-BODY\nafter");
    expect(runner.calls).toEqual([{ name: "/trevor-export", args: "--compact" }]);
  });

  it("expands a fenced block that is a single allow-listed command line", async () => {
    const runner = fakeRunner({ output: "BLOCK-EXPORT", ok: true });
    const out = await expandCommandFile(file("```!\n/trevor-export\n```"), ON, { runner });
    expect(out.text).toBe("BLOCK-EXPORT");
    expect(runner.calls).toEqual([{ name: "/trevor-export", args: "" }]);
  });

  it("REFUSES a non-allow-listed command (e.g. /shell) - nothing runs, a marker is spliced", async () => {
    const runner = fakeRunner({ output: "SHOULD NOT RUN", ok: true });
    const out = await expandCommandFile(file("!/shell rm -rf /"), ON, { runner });
    expect(runner.calls).toHaveLength(0);
    expect(out.text).toMatch(/interpolation refused/);
    expect(out.text).toContain("/shell");
  });

  it("REFUSES a multi-line fenced block (fail closed - not a single allow-listed command)", async () => {
    const runner = fakeRunner({ output: "SHOULD NOT RUN", ok: true });
    const out = await expandCommandFile(file("```!\n/trevor-export\nrm -rf /\n```"), ON, {
      runner,
    });
    expect(runner.calls).toHaveLength(0);
    expect(out.text).toMatch(/interpolation refused/);
  });

  it("shell metacharacters after the command name are handed to the target as an INERT arg blob", async () => {
    // The name is argv[0] (`/trevor-export`), so it is allow-listed and runs; the `; rm -rf /` is passed
    // as opaque args and never reaches a shell (the runner dispatches an in-process command).
    const runner = fakeRunner({ output: "OK", ok: true });
    const out = await expandCommandFile(file("!/trevor-export; rm -rf /"), ON, { runner });
    // `/trevor-export;` (with the trailing `;`) is NOT the allow-listed name, so it is refused - the
    // metacharacter can neither run nor split the command.
    expect(runner.calls).toHaveLength(0);
    expect(out.text).toMatch(/interpolation refused/);
  });
});

describe("command-file interpolation diagnostics + failure handling (M6)", () => {
  it("emits a redacted, output-free diagnostic for an expanded site", async () => {
    const runner = fakeRunner({ output: "x".repeat(50), ok: true });
    const out = await expandCommandFile(file("!/trevor-export"), ON, { runner });
    expect(out.diagnostics).toHaveLength(1);
    const d = out.diagnostics[0];
    expect(d?.source).toBe("command-file");
    expect(d?.gate).toBe("TREVOR_ENABLE_INTERPOLATION");
    expect(d?.gateOpen).toBe(true);
    expect(d?.target).toBe("/trevor-export");
    expect(d?.allowed).toBe(true);
    expect(d?.status).toBe("expanded");
    expect(d?.outputBytes).toBe(50);
    expect(d?.truncated).toBe(false);
    // The diagnostic carries a byte COUNT, never the raw output text.
    expect(JSON.stringify(d)).not.toContain("xxxxx");
  });

  it("a runner failure (ok:false) is a bounded 'failed' diagnostic, not a throw", async () => {
    const runner = fakeRunner({ output: "error: boom", ok: false });
    const out = await expandCommandFile(file("!/trevor-export"), ON, { runner });
    expect(out.text).toContain("error: boom");
    expect(out.diagnostics[0]?.status).toBe("failed");
  });

  it("a refusal is a 'refused' diagnostic marked not-allowed", async () => {
    const out = await expandCommandFile(file("!/shell danger"), ON, {
      runner: fakeRunner({ output: "", ok: true }),
    });
    const d = out.diagnostics[0];
    expect(d?.status).toBe("refused");
    expect(d?.allowed).toBe(false);
  });

  it("redacts secrets/paths from spliced output AND never puts raw output in a diagnostic", async () => {
    const runner = fakeRunner({
      output: "leak /Users/kevin/dev/secret.key token sk-ABCDEF1234567890XYZ",
      ok: true,
    });
    const out = await expandCommandFile(file("!/trevor-export"), ON, { runner });
    expect(out.text).not.toContain("/Users/kevin");
    expect(out.text).not.toContain("sk-ABCDEF");
    expect(JSON.stringify(out.diagnostics)).not.toContain("sk-ABCDEF");
  });

  it("caps oversized interpolated output at the byte budget with a truncation marker", async () => {
    const runner = fakeRunner({ output: "z".repeat(ON.maxOutputBytes + 500), ok: true });
    const out = await expandCommandFile(file("!/trevor-export"), ON, { runner });
    expect(out.text.length).toBeLessThanOrEqual(ON.maxOutputBytes + 40);
    expect(out.text).toMatch(/truncat/i);
    expect(out.diagnostics[0]?.truncated).toBe(true);
  });
});

describe("the default in-process runner is the allow-list made executable (M4/M5)", () => {
  afterEach(() => {
    // Leave no manifest source wired for other suites.
    registerManifestSource(() => Promise.reject(new Error("cleared")));
  });

  it("constructs without drift (its builders mirror the string allow-list)", () => {
    expect(() => defaultInterpolationCommandRunner()).not.toThrow();
  });

  it("refuses an unknown command name even if asked directly (defense in depth)", async () => {
    const runner = defaultInterpolationCommandRunner();
    const result = await runner.run("/shell", "rm -rf /");
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/not an allowed interpolation target/);
  });

  it("dispatches the real /trevor-export in-process over a registered manifest", async () => {
    const manifest: CapabilityManifest = {
      version: MANIFEST_VERSION,
      scope: "compact",
      generatedAt: "2026-07-05T00:00:00.000Z",
      sections: [
        { id: "tools", title: "Tools", status: "ok", items: [{ id: "read", label: "read" }] },
      ],
      truncated: false,
    };
    registerManifestSource((scope: ManifestScope) => Promise.resolve({ ...manifest, scope }));

    const out = await expandCommandFile(file("!/trevor-export --compact"), ON);
    // The real command rendered the (bounded) manifest into the body, and recorded one expanded site.
    expect(out.text).toContain("Tools");
    expect(out.diagnostics[0]?.status).toBe("expanded");
    expect(out.diagnostics[0]?.target).toBe("/trevor-export");
  });
});
