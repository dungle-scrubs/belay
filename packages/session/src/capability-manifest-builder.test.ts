import { describe, expect, it } from "vitest";
import type { SectionBody, SectionProvider } from "./capability-manifest-builder";
import { buildManifest, createSectionProviderRegistry } from "./capability-manifest-builder";

const AT = "2026-07-01T00:00:00.000Z";

/** A provider that returns a fixed body for `id`/`title`. */
function ok(
  id: SectionProvider["id"],
  title: string,
  body?: Partial<SectionBody>,
): SectionProvider {
  return {
    id,
    title,
    provide: () => ({ status: "ok", items: [], ...body }),
  };
}

describe("section-provider registry + manifest builder (M2)", () => {
  it("composes registered providers into canonical section order, not registration order", async () => {
    const registry = createSectionProviderRegistry();
    registry.register(ok("workspace", "Workspace"));
    registry.register(ok("tools", "Tools"));
    registry.register(ok("skills", "Skills"));
    const manifest = await buildManifest(registry.providers(), { scope: "human", generatedAt: AT });
    expect(manifest.sections.map((s) => s.id)).toEqual(["tools", "skills", "workspace"]);
    expect(manifest.version).toBeGreaterThanOrEqual(1);
    expect(manifest.generatedAt).toBe(AT);
    expect(manifest.scope).toBe("human");
  });

  it("stamps id + title from the provider registration (a provider body cannot spoof another id)", async () => {
    const provider: SectionProvider = {
      id: "commands",
      title: "Commands",
      // Body has no id/title; even if it did, registration is authoritative.
      provide: () => ({ status: "ok", items: [{ id: "help", label: "/help" }] }),
    };
    const manifest = await buildManifest([provider], { scope: "human", generatedAt: AT });
    expect(manifest.sections[0]?.id).toBe("commands");
    expect(manifest.sections[0]?.title).toBe("Commands");
    expect(manifest.sections[0]?.items[0]?.label).toBe("/help");
  });

  it("de-duplicates providers by id (last registration wins)", async () => {
    const registry = createSectionProviderRegistry();
    registry.register(ok("tools", "Tools v1", { items: [{ id: "a", label: "a" }] }));
    registry.register(ok("tools", "Tools v2", { items: [{ id: "b", label: "b" }] }));
    const providers = registry.providers();
    expect(providers).toHaveLength(1);
    const manifest = await buildManifest(providers, { scope: "human", generatedAt: AT });
    expect(manifest.sections).toHaveLength(1);
    expect(manifest.sections[0]?.title).toBe("Tools v2");
    expect(manifest.sections[0]?.items[0]?.id).toBe("b");
  });

  it("passes an explicit `unavailable` section through with its note", async () => {
    const provider = ok("mcp", "MCP servers", {
      status: "unavailable",
      note: "no MCP runtime configured",
    });
    const manifest = await buildManifest([provider], { scope: "human", generatedAt: AT });
    expect(manifest.sections[0]?.status).toBe("unavailable");
    expect(manifest.sections[0]?.note).toBe("no MCP runtime configured");
  });

  it("sets truncated when any section is capped", async () => {
    const provider = ok("skills", "Skills", {
      status: "truncated",
      items: [{ id: "a", label: "a" }],
      total: 40,
      detail: "skills_list",
    });
    const manifest = await buildManifest([provider], { scope: "human", generatedAt: AT });
    expect(manifest.truncated).toBe(true);
  });
});

describe("manifest builder is fault-isolating - one bad provider never fails the export (M2)", () => {
  it("turns a provider that throws synchronously into an explicit error section", async () => {
    const bad: SectionProvider = {
      id: "tools",
      title: "Tools",
      provide: () => {
        throw new Error("boom in /Users/secret/path");
      },
    };
    const good = ok("commands", "Commands", { items: [{ id: "help", label: "/help" }] });
    const manifest = await buildManifest([bad, good], { scope: "human", generatedAt: AT });
    const tools = manifest.sections.find((s) => s.id === "tools");
    expect(tools?.status).toBe("error");
    expect(tools?.items).toEqual([]);
    // Note is present + sanitized: the raw home path must not leak verbatim.
    expect(tools?.note).toBeDefined();
    expect(tools?.note).not.toContain("/Users/secret");
    // The healthy section still composed.
    expect(manifest.sections.find((s) => s.id === "commands")?.status).toBe("ok");
  });

  it("turns a rejected async provider into an explicit error section", async () => {
    const bad: SectionProvider = {
      id: "catalog",
      title: "Catalog",
      provide: () => Promise.reject(new Error("registry offline")),
    };
    const manifest = await buildManifest([bad], { scope: "human", generatedAt: AT });
    expect(manifest.sections[0]?.status).toBe("error");
    expect(manifest.sections[0]?.note).toBeDefined();
  });

  it("turns a provider that exceeds its time budget into an explicit error section", async () => {
    const slow: SectionProvider = {
      id: "docs",
      title: "Docs",
      // Never resolves - only the timeout can settle this, so the outcome is deterministic.
      provide: () => new Promise<SectionBody>(() => {}),
    };
    const manifest = await buildManifest([slow], {
      scope: "human",
      generatedAt: AT,
      providerTimeoutMs: 10,
    });
    expect(manifest.sections[0]?.status).toBe("error");
    expect(manifest.sections[0]?.note).toMatch(/tim(e|ed) out/i);
  });
});
