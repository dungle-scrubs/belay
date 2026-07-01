import { describe, expect, it } from "vitest";
import {
  type CapabilityManifest,
  computeTruncated,
  decodeCapabilityManifest,
  isManifestSectionId,
  MANIFEST_SCOPES,
  MANIFEST_SECTION_ORDER,
  MANIFEST_VERSION,
  type ManifestSection,
  orderSections,
} from "./capability-manifest";

/** A minimal well-formed manifest for round-trip assertions. */
function sampleManifest(overrides: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return {
    version: MANIFEST_VERSION,
    scope: "human",
    generatedAt: "2026-07-01T00:00:00.000Z",
    sections: [
      {
        id: "commands",
        title: "Commands",
        status: "ok",
        items: [{ id: "help", label: "/help", summary: "List commands" }],
        provenance: { source: "command-registry", fresh: true },
      },
    ],
    truncated: false,
    ...overrides,
  };
}

describe("capability-manifest contract (M1)", () => {
  it("pins a positive integer version and a de-duplicated section order + scope set", () => {
    expect(MANIFEST_VERSION).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(MANIFEST_VERSION)).toBe(true);
    expect(new Set(MANIFEST_SECTION_ORDER).size).toBe(MANIFEST_SECTION_ORDER.length);
    // The five documented scopes must be describable.
    for (const scope of ["human", "client", "compact", "subagent", "expert"] as const) {
      expect(MANIFEST_SCOPES).toContain(scope);
    }
  });

  it("round-trips version, generatedAt, scope, sections, provenance, and truncation", () => {
    const decoded = decodeCapabilityManifest(JSON.parse(JSON.stringify(sampleManifest())));
    expect(decoded).not.toBeNull();
    expect(decoded?.version).toBe(MANIFEST_VERSION);
    expect(decoded?.scope).toBe("human");
    expect(decoded?.generatedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(decoded?.truncated).toBe(false);
    const section = decoded?.sections[0];
    expect(section?.id).toBe("commands");
    expect(section?.status).toBe("ok");
    expect(section?.provenance?.source).toBe("command-registry");
    expect(section?.items[0]?.label).toBe("/help");
  });

  it("returns null when the core manifest fields are missing (never a partial object)", () => {
    expect(decodeCapabilityManifest(null)).toBeNull();
    expect(decodeCapabilityManifest({})).toBeNull();
    expect(decodeCapabilityManifest({ version: 1, scope: "human" })).toBeNull();
  });

  it("normalizes an unknown scope to a safe default rather than trusting the input", () => {
    const decoded = decodeCapabilityManifest(sampleManifest({ scope: "root" as never }));
    expect(decoded?.scope).toBe("human");
  });

  it("represents an unavailable section EXPLICITLY (status + note), never silently omitted", () => {
    const manifest = sampleManifest({
      sections: [
        {
          id: "mcp",
          title: "MCP servers",
          status: "unavailable",
          note: "no MCP runtime configured",
          items: [],
        },
      ],
    });
    const decoded = decodeCapabilityManifest(JSON.parse(JSON.stringify(manifest)));
    const section = decoded?.sections[0];
    expect(section?.status).toBe("unavailable");
    expect(section?.note).toBe("no MCP runtime configured");
    expect(section?.items).toHaveLength(0);
  });

  it("orders sections into the canonical deterministic order regardless of input order", () => {
    const scrambled: ManifestSection[] = [
      { id: "workspace", title: "Workspace", status: "ok", items: [] },
      { id: "tools", title: "Tools", status: "ok", items: [] },
      { id: "skills", title: "Skills", status: "ok", items: [] },
    ];
    const ordered = orderSections(scrambled).map((s) => s.id);
    expect(ordered).toEqual(["tools", "skills", "workspace"]);
  });

  it("computes truncation from any capped section", () => {
    expect(computeTruncated([{ id: "tools", title: "Tools", status: "ok", items: [] }])).toBe(
      false,
    );
    expect(
      computeTruncated([
        {
          id: "skills",
          title: "Skills",
          status: "truncated",
          items: [{ id: "a", label: "a" }],
          total: 40,
          detail: "skills_list",
        },
      ]),
    ).toBe(true);
  });

  it("isManifestSectionId guards the closed id set", () => {
    expect(isManifestSectionId("commands")).toBe(true);
    expect(isManifestSectionId("nope")).toBe(false);
  });
});

describe("capability-manifest is descriptive-only, never executable authority (M1)", () => {
  it("drops executable / secret fields from items and keeps only descriptive primitives", () => {
    const hostile = {
      version: MANIFEST_VERSION,
      scope: "human",
      generatedAt: "2026-07-01T00:00:00.000Z",
      truncated: false,
      sections: [
        {
          id: "tools",
          title: "Tools",
          status: "ok",
          items: [
            {
              id: "write",
              label: "Write",
              summary: "Writes a file",
              scope: "default",
              // Everything below must NOT survive decode - a manifest describes, it never carries authority.
              run: "() => rm -rf /",
              handler: { exec: true },
              token: "sk-secret",
              meta: { calls: 3, allow: true, nested: { grant: "all" }, fn: () => 1 },
            },
          ],
        },
      ],
    };
    const decoded = decodeCapabilityManifest(hostile);
    const item = decoded?.sections[0]?.items[0] as Record<string, unknown> | undefined;
    expect(item).toBeDefined();
    expect(item?.id).toBe("write");
    expect(item?.label).toBe("Write");
    expect(item?.summary).toBe("Writes a file");
    expect(item?.scope).toBe("default");
    // No executable authority or secret material survives.
    expect(item?.run).toBeUndefined();
    expect(item?.handler).toBeUndefined();
    expect(item?.token).toBeUndefined();
    // meta keeps ONLY primitive descriptive facts - no nested objects, no functions.
    expect(item?.meta).toEqual({ calls: 3, allow: true });
  });

  it("drops sections whose id is not in the closed set (no smuggled capability surface)", () => {
    const decoded = decodeCapabilityManifest({
      version: MANIFEST_VERSION,
      scope: "human",
      generatedAt: "2026-07-01T00:00:00.000Z",
      truncated: false,
      sections: [
        { id: "commands", title: "Commands", status: "ok", items: [] },
        { id: "shell-exec", title: "Shell", status: "ok", items: [] },
      ],
    });
    expect(decoded?.sections.map((s) => s.id)).toEqual(["commands"]);
  });
});
