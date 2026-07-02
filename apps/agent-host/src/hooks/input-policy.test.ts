import { describe, expect, test } from "vitest";
import { evaluateUpdatedInput, HOOK_UPDATABLE_INPUT_FIELDS } from "./input-policy";

describe("the updatedInput allowlist table (D-003)", () => {
  test("the first cut allows exactly bash.command and web_fetch.url", () => {
    expect(HOOK_UPDATABLE_INPUT_FIELDS).toEqual({
      bash: ["command"],
      web_fetch: ["url"],
    });
  });
});

describe("evaluateUpdatedInput - allowlisted rewrites", () => {
  test("bash.command rides through", () => {
    const result = evaluateUpdatedInput("bash", { command: "echo rewritten" });
    expect(result).toEqual({ ok: true, fields: { command: "echo rewritten" } });
  });

  test("web_fetch.url rides through", () => {
    const result = evaluateUpdatedInput("web_fetch", { url: "https://example.com/" });
    expect(result).toEqual({ ok: true, fields: { url: "https://example.com/" } });
  });

  test("an empty object is a no-op, not a rejection", () => {
    expect(evaluateUpdatedInput("bash", {})).toEqual({ ok: true, fields: {} });
  });

  test("values pass through untouched - type validation is the tool schema's job", () => {
    // A wrong-typed value is NOT the policy's concern: it flows to the tool's normal schema
    // decode, which rejects it exactly like a model-authored bad argument.
    expect(evaluateUpdatedInput("bash", { command: 42 })).toEqual({
      ok: true,
      fields: { command: 42 },
    });
  });
});

describe("evaluateUpdatedInput - rejections (reject whole update, original input used)", () => {
  test("a non-object update is rejected", () => {
    const result = evaluateUpdatedInput("bash", "echo hi");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain("object");
    }
  });

  test("an array update is rejected", () => {
    expect(evaluateUpdatedInput("bash", ["echo hi"]).ok).toBe(false);
  });

  test("a tool outside the table is rejected and the detail names the supported tools", () => {
    const result = evaluateUpdatedInput("read", { file_path: "/etc/passwd" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain("read");
      expect(result.detail).toContain("bash");
    }
  });

  test("an unsupported field on a supported tool is rejected and named", () => {
    const result = evaluateUpdatedInput("bash", { cwd: "/" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain("cwd");
      expect(result.detail).toContain("command");
    }
  });

  test("one unsupported field poisons the whole update - no partial application", () => {
    const result = evaluateUpdatedInput("bash", { command: "echo ok", cwd: "/" });
    expect(result.ok).toBe(false);
  });
});
