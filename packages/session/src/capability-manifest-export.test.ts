import { describe, expect, it } from "vitest";
import type { CapabilityManifest, ManifestScope, ManifestSection } from "./capability-manifest";
import { decodeCapabilityManifest, MANIFEST_VERSION } from "./capability-manifest";
import { redactManifest, renderManifestExport } from "./capability-manifest-export";

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

const SECTIONS: ManifestSection[] = [
  {
    id: "tools",
    title: "Tools",
    status: "ok",
    items: [
      { id: "read", label: "read", summary: "Read a file", meta: { readOnly: true } },
      { id: "write", label: "write", summary: "Write a file" },
    ],
  },
  {
    id: "skills",
    title: "Skills",
    status: "truncated",
    items: [{ id: "alpha", label: "alpha" }],
    total: 40,
    detail: "skills_list",
  },
  { id: "mcp", title: "MCP servers", status: "unavailable", note: "not configured", items: [] },
];

describe("belay-export - JSON variant (M6)", () => {
  it("emits stable, decodable JSON that round-trips through the manifest decoder", () => {
    const json = renderManifestExport(manifest("human", SECTIONS), {
      format: "json",
      detail: "full",
    });
    const parsed = JSON.parse(json);
    const decoded = decodeCapabilityManifest(parsed);
    expect(decoded?.sections.map((s) => s.id)).toEqual(["tools", "skills", "mcp"]);
  });

  it("is deterministic - the same manifest exports byte-identical JSON", () => {
    const req = { format: "json" as const, detail: "full" as const };
    expect(renderManifestExport(manifest("human", SECTIONS), req)).toBe(
      renderManifestExport(manifest("human", SECTIONS), req),
    );
  });
});

describe("belay-export - text variants (M6)", () => {
  it("full text lists every section with counts, item labels, and explicit unavailable status", () => {
    const text = renderManifestExport(manifest("human", SECTIONS), {
      format: "text",
      detail: "full",
    });
    expect(text).toContain("Tools");
    expect(text).toContain("read");
    expect(text).toContain("Write a file");
    expect(text).toContain("skills_list");
    expect(text.toLowerCase()).toContain("unavailable");
    // Deterministic canonical order: tools before skills before mcp.
    expect(text.indexOf("Tools")).toBeLessThan(text.indexOf("Skills"));
    expect(text.indexOf("Skills")).toBeLessThan(text.indexOf("MCP"));
  });

  it("compact text uses the budgeted prompt projection at a prompt scope", () => {
    const text = renderManifestExport(manifest("compact", SECTIONS), {
      format: "text",
      detail: "compact",
    });
    expect(text.toLowerCase()).toContain("compact");
    expect(text).toContain("Tools");
  });
});

describe("belay-export - section scoping (M6)", () => {
  it("restricts the export to a single requested section", () => {
    const json = renderManifestExport(manifest("human", SECTIONS), {
      format: "json",
      detail: "full",
      section: "skills",
    });
    const parsed = JSON.parse(json) as CapabilityManifest;
    expect(parsed.sections.map((s) => s.id)).toEqual(["skills"]);
  });
});

describe("belay-export - redaction (M6)", () => {
  const leaky: ManifestSection[] = [
    {
      id: "tools",
      title: "Tools",
      status: "error",
      note: "failed reading /Users/kevin/dev/secret.key with token sk-ABCDEF1234567890XYZ",
      items: [{ id: "x", label: "x", summary: "see /Users/kevin/.belay/creds.json" }],
    },
  ];

  it("scrubs secrets and absolute home paths from BOTH text and JSON exports", () => {
    for (const format of ["text", "json"] as const) {
      const out = renderManifestExport(manifest("human", leaky), { format, detail: "full" });
      expect(out).not.toContain("/Users/kevin");
      expect(out).not.toContain("sk-ABCDEF");
      expect(out).toContain("«redacted»");
    }
  });

  it("redactManifest preserves structure while scrubbing string fields", () => {
    const safe = redactManifest(manifest("human", leaky));
    expect(safe.sections[0]?.id).toBe("tools");
    expect(safe.sections[0]?.note).not.toContain("/Users/kevin");
    expect(safe.sections[0]?.items[0]?.summary).not.toContain("/Users/kevin");
  });
});
