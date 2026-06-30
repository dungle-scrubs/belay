import { describe, expect, test } from "vitest";
import {
  BUILTIN_STYLES,
  buildStyleMenu,
  DEFAULT_STYLE_ID,
  defaultStyle,
  handleStyleCommand,
  isStyleActionId,
  type OutputStyle,
  resolveStyle,
} from "./styles";

describe("style metadata", () => {
  test("every style has a stable id, label, description, and guidance", () => {
    for (const style of BUILTIN_STYLES) {
      expect(style.id).toMatch(/^[a-z]+$/);
      expect(style.label.length).toBeGreaterThan(0);
      expect(style.description.length).toBeGreaterThan(0);
      expect(typeof style.guidance).toBe("string");
    }
  });

  test("exactly one default style, and it carries no guidance (standard voice)", () => {
    const defaults = BUILTIN_STYLES.filter((s) => s.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaultStyle().id).toBe(DEFAULT_STYLE_ID);
    expect(defaultStyle().guidance).toBe("");
  });

  test("covers the plan's named behaviors (concise, diagnostic, reviewer, explanatory, default)", () => {
    const ids = BUILTIN_STYLES.map((s) => s.id);
    for (const id of ["default", "concise", "diagnostic", "reviewer", "explanatory"]) {
      expect(ids).toContain(id);
    }
  });

  test("a style is presentation-only: it carries no model/tool/reasoning/agent/routing fields", () => {
    // The shape itself enforces M6 - the only behavior-bearing field is `guidance` (response shape).
    const keys = Object.keys(BUILTIN_STYLES[1] as OutputStyle).sort();
    expect(keys).toEqual(["description", "guidance", "id", "label"]);
  });
});

describe("resolveStyle - unknown ids fall back to default", () => {
  test("a known id resolves to itself", () => {
    expect(resolveStyle("concise").id).toBe("concise");
  });
  test("an unknown / retired / null id falls back to the default", () => {
    expect(resolveStyle("retired-style").id).toBe(DEFAULT_STYLE_ID);
    expect(resolveStyle(null).id).toBe(DEFAULT_STYLE_ID);
    expect(resolveStyle(undefined).id).toBe(DEFAULT_STYLE_ID);
  });
});

describe("buildStyleMenu", () => {
  test("renders one row per style from host data, marking the active + badging the default", () => {
    const menu = buildStyleMenu("diagnostic");
    expect(menu.family).toBe("style");
    expect(menu.rows.map((r) => r.id)).toEqual(BUILTIN_STYLES.map((s) => s.id));
    expect(menu.rows.find((r) => r.id === "diagnostic")?.selected).toBe(true);
    expect(menu.rows.find((r) => r.id === "concise")?.selected).toBeUndefined();
    expect(menu.rows.find((r) => r.id === "default")?.badge).toBe("default");
  });
});

describe("handleStyleCommand", () => {
  test("bare /style shows the menu for the active style, with no change", () => {
    const result = handleStyleCommand("", "concise");
    expect(result.kind).toBe("menu");
    if (result.kind !== "menu") return;
    expect(result.menu.rows.find((r) => r.id === "concise")?.selected).toBe(true);
  });

  test("/style <id> selects a valid style", () => {
    const result = handleStyleCommand("reviewer", "default");
    expect(result).toEqual({
      kind: "selected",
      styleId: "reviewer",
      text: "✓ output style: Reviewer",
    });
  });

  test("/style select <id> (the menu-row dispatch form) selects too", () => {
    const result = handleStyleCommand("select concise", "default");
    expect(result.kind === "selected" && result.styleId).toBe("concise");
  });

  test("/style reset and /style default both pick the default", () => {
    expect(handleStyleCommand("reset", "concise")).toMatchObject({
      kind: "selected",
      styleId: "default",
    });
    expect(handleStyleCommand("default", "concise")).toMatchObject({ styleId: "default" });
  });

  test("an unknown id errors without changing the active style", () => {
    const result = handleStyleCommand("nonsense", "concise");
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.text).toMatch(/unknown style: nonsense/);
  });
});

describe("isStyleActionId (dispatch guard)", () => {
  test("recognizes built-in style ids and rejects others", () => {
    expect(isStyleActionId("concise")).toBe(true);
    expect(isStyleActionId("default")).toBe(true);
    expect(isStyleActionId("not-a-style")).toBe(false);
  });
});
