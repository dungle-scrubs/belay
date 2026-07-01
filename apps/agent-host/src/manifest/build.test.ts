import { MANIFEST_SECTION_ORDER } from "@trevor/session";
import { describe, expect, it } from "vitest";
import { assembleManifest, type ManifestDeps } from "./build";

const AT = "2026-07-01T00:00:00.000Z";

const deps: ManifestDeps = {
  toolDefs: [{ name: "read", description: "Read a file" }],
  readOnlyTools: new Set(["read"]),
  commands: [{ name: "/help", summary: "List commands" }],
  debugCommands: [{ name: "/restart", summary: "Restart (debug)" }],
  commandFamilies: [
    { family: "style", title: "Output style", rows: [{ id: "default", label: "Default" }] },
  ],
  styles: [
    { id: "default", label: "Default", description: "Standard", guidance: "", isDefault: true },
  ],
  skills: [],
  agents: [],
  doctorAreas: [{ id: "core", label: "Core", status: "ok", verdict: "healthy" }],
  catalog: null,
  runtime: { role: "leader", instanceId: "abc", turn: "idle" },
  host: { version: "2.0.0" },
  workspace: { root: "/Users/secret/dev/trevorV2", cwd: "/Users/secret/dev/trevorV2" },
};

describe("assembleManifest composition root (M6)", () => {
  it("composes every section in canonical order", async () => {
    const manifest = await assembleManifest(deps, "human", AT);
    expect(manifest.sections.map((s) => s.id)).toEqual([...MANIFEST_SECTION_ORDER]);
    expect(manifest.scope).toBe("human");
    expect(manifest.generatedAt).toBe(AT);
  });

  it("marks unwired peripherals + an unloaded catalog as explicitly unavailable", async () => {
    const manifest = await assembleManifest(deps, "human", AT);
    for (const id of ["mcp", "lsp", "hooks", "docs", "catalog"]) {
      expect(manifest.sections.find((s) => s.id === id)?.status).toBe("unavailable");
    }
  });

  it("drops debug commands in a compact scope but keeps them (tagged) for human", async () => {
    const human = await assembleManifest(deps, "human", AT);
    const compact = await assembleManifest(deps, "compact", AT);
    const humanCommands = human.sections.find((s) => s.id === "commands")?.items ?? [];
    const compactCommands = compact.sections.find((s) => s.id === "commands")?.items ?? [];
    expect(humanCommands.find((i) => i.id === "/restart")?.scope).toBe("debug");
    expect(compactCommands.find((i) => i.id === "/restart")).toBeUndefined();
  });

  it("does not leak the absolute workspace path into the composed manifest", async () => {
    const manifest = await assembleManifest(deps, "human", AT);
    expect(JSON.stringify(manifest)).not.toContain("/Users/secret");
  });
});
