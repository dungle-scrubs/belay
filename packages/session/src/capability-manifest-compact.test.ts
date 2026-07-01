import { describe, expect, it } from "vitest";
import type { CapabilityManifest, ManifestScope, ManifestSection } from "./capability-manifest";
import { MANIFEST_VERSION } from "./capability-manifest";
import {
  estimateManifestTokens,
  isPromptScope,
  renderCompactManifest,
} from "./capability-manifest-compact";

const AT = "2026-07-01T00:00:00.000Z";

function manifest(scope: ManifestScope, sections: ManifestSection[]): CapabilityManifest {
  return {
    version: MANIFEST_VERSION,
    scope,
    generatedAt: AT,
    sections,
    truncated: sections.some((s) => s.status === "truncated"),
  };
}

describe("compact manifest scope policy (M5)", () => {
  it("marks only the prompt-facing scopes as promptable", () => {
    expect(isPromptScope("compact")).toBe(true);
    expect(isPromptScope("subagent")).toBe(true);
    expect(isPromptScope("expert")).toBe(true);
    expect(isPromptScope("human")).toBe(false);
    expect(isPromptScope("client")).toBe(false);
  });

  it("REFUSES to render a full (human/client) manifest as prompt text - never injected into a turn", () => {
    const full = manifest("human", [
      { id: "tools", title: "Tools", status: "ok", items: [{ id: "read", label: "read" }] },
    ]);
    expect(() => renderCompactManifest(full)).toThrow(/scope/i);
  });
});

describe("compact manifest rendering (M5)", () => {
  const sampleSections: ManifestSection[] = [
    {
      id: "tools",
      title: "Tools",
      status: "ok",
      items: [
        { id: "read", label: "read" },
        { id: "write", label: "write" },
      ],
    },
    {
      id: "skills",
      title: "Skills",
      status: "truncated",
      items: [{ id: "a", label: "alpha" }],
      total: 40,
      detail: "skills_list",
    },
    { id: "mcp", title: "MCP servers", status: "unavailable", note: "not configured", items: [] },
  ];

  it("renders structured sections as compact one-liners with counts + a discovery pointer", () => {
    const text = renderCompactManifest(manifest("compact", sampleSections));
    expect(text).toContain("Tools");
    expect(text).toContain("read");
    // A truncated section surfaces its total + how to fetch the rest.
    expect(text).toContain("40");
    expect(text).toContain("skills_list");
    // An unavailable section is shown explicitly, not dropped.
    expect(text.toLowerCase()).toContain("unavailable");
  });

  it("stays within an explicit token budget even with many populated sections", () => {
    const many: ManifestSection[] = Array.from({ length: 15 }, (_, i) => ({
      id: "tools",
      title: `Section ${i}`,
      status: "ok" as const,
      items: Array.from({ length: 30 }, (_, j) => ({
        id: `i-${j}`,
        label: `item-${j}-with-a-fairly-long-label`,
      })),
    }));
    const text = renderCompactManifest(manifest("subagent", many), { maxTokens: 200 });
    expect(estimateManifestTokens(text)).toBeLessThanOrEqual(200);
    // When it drops sections to fit, it says so (never silently truncates).
    expect(text.toLowerCase()).toMatch(/truncat|more via|omitted/);
  });

  it("estimateManifestTokens grows with text length", () => {
    expect(estimateManifestTokens("")).toBe(0);
    expect(estimateManifestTokens("a".repeat(40))).toBeGreaterThan(
      estimateManifestTokens("a".repeat(4)),
    );
  });
});
