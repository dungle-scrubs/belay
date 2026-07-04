import { describe, expect, it } from "vitest";
import {
  applyInterpolationOutputPolicy,
  boundInterpolationOutput,
  DEFAULT_INTERPOLATION_ALLOWLIST,
  INTERPOLATION_GATE_ENV,
  interpolationRefusal,
  isInterpolationTargetAllowed,
  redactDiagnosticTarget,
  resolveInterpolationConfig,
  splitInterpolationArgv,
} from "./interpolation";

describe("interpolation gate defaults disabled (M7, D-003)", () => {
  it("is DISABLED when the trust-gate env var is unset", () => {
    const config = resolveInterpolationConfig({});
    expect(config.enabled).toBe(false);
    // Nothing is an allowed interpolation target while disabled.
    expect(config.allowedCommands.size).toBe(0);
  });

  it("stays disabled for any value other than an explicit opt-in", () => {
    expect(resolveInterpolationConfig({ TREVOR_ENABLE_INTERPOLATION: "0" }).enabled).toBe(false);
    expect(resolveInterpolationConfig({ TREVOR_ENABLE_INTERPOLATION: "" }).enabled).toBe(false);
    expect(resolveInterpolationConfig({ TREVOR_ENABLE_INTERPOLATION: "yes-please" }).enabled).toBe(
      false,
    );
  });

  it("enables ONLY with the explicit opt-in, and then only allow-lists bounded read-only targets", () => {
    const config = resolveInterpolationConfig({ TREVOR_ENABLE_INTERPOLATION: "1" });
    expect(config.enabled).toBe(true);
    expect([...config.allowedCommands]).toEqual([...DEFAULT_INTERPOLATION_ALLOWLIST]);
    expect(config.allowedCommands.has("/trevor-export")).toBe(true);
    // The policy is bounded: caps, a timeout, and a fixed cwd.
    expect(config.maxOutputBytes).toBeGreaterThan(0);
    expect(config.timeoutMs).toBeGreaterThan(0);
    expect(config.cwd).toBe("workspace-root");
  });
});

describe("interpolation target allow-listing (M7)", () => {
  it("permits trevor-export as an interpolation target ONLY when interpolation is enabled", () => {
    const off = resolveInterpolationConfig({});
    const on = resolveInterpolationConfig({ TREVOR_ENABLE_INTERPOLATION: "1" });
    expect(isInterpolationTargetAllowed(off, "/trevor-export")).toBe(false);
    expect(isInterpolationTargetAllowed(on, "/trevor-export")).toBe(true);
  });

  it("never permits a non-allow-listed command, even when interpolation is enabled", () => {
    const on = resolveInterpolationConfig({ TREVOR_ENABLE_INTERPOLATION: "1" });
    expect(isInterpolationTargetAllowed(on, "/shell")).toBe(false);
    expect(isInterpolationTargetAllowed(on, "rm -rf /")).toBe(false);
  });
});

describe("interpolation output policy (M7)", () => {
  const config = resolveInterpolationConfig({ TREVOR_ENABLE_INTERPOLATION: "1" });

  it("redacts secrets/paths and caps the spliced output", () => {
    const out = applyInterpolationOutputPolicy(
      config,
      "leak /Users/kevin/dev/secret.key token sk-ABCDEF1234567890XYZ",
    );
    expect(out).not.toContain("/Users/kevin");
    expect(out).not.toContain("sk-ABCDEF");
  });

  it("truncates output past the byte cap with an explicit marker", () => {
    const huge = "x".repeat(config.maxOutputBytes + 500);
    const out = applyInterpolationOutputPolicy(config, huge);
    expect(out.length).toBeLessThanOrEqual(config.maxOutputBytes + 40);
    expect(out).toMatch(/truncat/i);
  });
});

describe("interpolation source provenance + separate gates (plan 40, M1)", () => {
  it("gates the two lanes with DIFFERENT env keys so enabling one never enables the other", () => {
    expect(INTERPOLATION_GATE_ENV["skill-shell"]).toBe("TREVOR_SKILL_SHELL");
    expect(INTERPOLATION_GATE_ENV["command-file"]).toBe("TREVOR_ENABLE_INTERPOLATION");
    expect(INTERPOLATION_GATE_ENV["skill-shell"]).not.toBe(INTERPOLATION_GATE_ENV["command-file"]);
  });

  it("the command-file gate env does NOT arm skill-shell, and vice versa", () => {
    // Setting only the command-file gate leaves the command-file lane enabled...
    expect(resolveInterpolationConfig({ TREVOR_ENABLE_INTERPOLATION: "1" }).enabled).toBe(true);
    // ...while setting only the skill-shell gate leaves the COMMAND-FILE config disabled.
    expect(resolveInterpolationConfig({ TREVOR_SKILL_SHELL: "1" }).enabled).toBe(false);
  });
});

describe("argv split is the shell-injection defense (plan 40, M4/D-007)", () => {
  it("splits a line into command NAME + inert ARG blob", () => {
    expect(splitInterpolationArgv("/trevor-export --compact")).toEqual({
      name: "/trevor-export",
      args: "--compact",
    });
    expect(splitInterpolationArgv("/trevor-export")).toEqual({ name: "/trevor-export", args: "" });
  });

  it("keeps shell metacharacters INSIDE the arg blob, never promoted to the command name", () => {
    // A malicious pattern's `;`, `|`, `$(…)`, backticks all stay in args; the name is just argv[0], so
    // the allow-list gates the real target and the metacharacters never reach a shell.
    expect(splitInterpolationArgv("/trevor-export; rm -rf /")).toEqual({
      name: "/trevor-export;",
      args: "rm -rf /",
    });
    expect(splitInterpolationArgv("/trevor-export $(rm -rf /)").name).toBe("/trevor-export");
    expect(splitInterpolationArgv("/shell | cat /etc/passwd").name).toBe("/shell");
  });

  it("an empty or whitespace line yields an empty (un-allow-listable) name", () => {
    expect(splitInterpolationArgv("   ").name).toBe("");
    expect(isInterpolationTargetAllowed(resolveInterpolationConfig({}), "")).toBe(false);
  });
});

describe("bounded-output metadata + refusal marker (plan 40, M6)", () => {
  const config = resolveInterpolationConfig({ TREVOR_ENABLE_INTERPOLATION: "1" });

  it("reports bytes + truncated=false for output under the cap", () => {
    const bounded = boundInterpolationOutput(config, "small output");
    expect(bounded.truncated).toBe(false);
    expect(bounded.bytes).toBe(bounded.text.length);
    expect(bounded.text).toBe("small output");
  });

  it("redacts BEFORE capping, so a secret near the boundary is masked", () => {
    const bounded = boundInterpolationOutput(config, `head sk-ABCDEF1234567890XYZ tail`);
    expect(bounded.text).not.toContain("sk-ABCDEF");
  });

  it("flags truncation + reports the capped byte length", () => {
    const bounded = boundInterpolationOutput(config, "y".repeat(config.maxOutputBytes + 500));
    expect(bounded.truncated).toBe(true);
    expect(bounded.bytes).toBe(bounded.text.length);
    expect(bounded.bytes).toBeLessThanOrEqual(config.maxOutputBytes + 40);
  });

  it("the refusal marker is a bounded, self-describing splice (not an execution)", () => {
    expect(interpolationRefusal('"/shell" is not allowed')).toBe(
      '[interpolation refused: "/shell" is not allowed]',
    );
  });

  it("redacts secrets/paths from a diagnostic target name", () => {
    expect(
      redactDiagnosticTarget("/Users/kevin/dev/secret token sk-ABCDEF1234567890XYZ"),
    ).not.toContain("sk-ABCDEF");
    expect(redactDiagnosticTarget("/Users/kevin/dev/secret")).not.toContain("/Users/kevin");
  });
});
