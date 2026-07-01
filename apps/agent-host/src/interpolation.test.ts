import { describe, expect, it } from "vitest";
import {
  applyInterpolationOutputPolicy,
  DEFAULT_INTERPOLATION_ALLOWLIST,
  isInterpolationTargetAllowed,
  resolveInterpolationConfig,
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
