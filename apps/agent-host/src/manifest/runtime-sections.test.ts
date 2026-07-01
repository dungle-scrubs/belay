import type { CatalogEntry, ManifestScope, SourceSummary } from "@trevor/session";
import { describe, expect, it } from "vitest";
import type { CatalogSnapshot } from "../providers/catalog";
import {
  catalogSection,
  doctorSection,
  peripheralSection,
  protocolSection,
  runtimeSection,
  workspaceSection,
} from "./runtime-sections";

const AT = "2026-07-01T00:00:00.000Z";
const run = (
  section: ReturnType<typeof protocolSection>,
  scope: ManifestScope = "human",
): ReturnType<typeof section.provide> => section.provide({ scope });

describe("peripheral sections (MCP / LSP / hooks / docs) - explicit when no backend (M4)", () => {
  it("reports an unavailable status with a note when the runtime is not configured", async () => {
    const body = await run(
      peripheralSection({
        id: "mcp",
        title: "MCP servers",
        source: "mcp-runtime",
        state: { kind: "unconfigured", note: "no MCP runtime configured" },
      }),
    );
    expect(body.status).toBe("unavailable");
    expect(body.note).toBe("no MCP runtime configured");
    expect(body.items).toHaveLength(0);
  });

  it("summarizes configured peripherals with counts when a backend IS present", async () => {
    const body = await run(
      peripheralSection({
        id: "hooks",
        title: "Hooks",
        source: "hooks-runtime",
        state: { kind: "ready", items: [{ id: "pre-commit", label: "pre-commit" }] },
      }),
    );
    expect(body.status).toBe("ok");
    expect(body.items[0]?.id).toBe("pre-commit");
  });
});

describe("doctor section summarizes areas, not findings (M4)", () => {
  it("emits one item per doctor area carrying its status + verdict", async () => {
    const body = await run(
      doctorSection({
        areas: [
          { id: "core", label: "Core", status: "ok", verdict: "healthy" },
          { id: "providers", label: "Providers", status: "warn", verdict: "1 source needs auth" },
        ],
      }),
    );
    expect(body.items.map((i) => i.id)).toEqual(["core", "providers"]);
    expect(body.items.find((i) => i.id === "providers")?.meta?.status).toBe("warn");
    expect(body.items.find((i) => i.id === "providers")?.summary).toBe("1 source needs auth");
  });
});

describe("catalog section summarizes sources + quant/arch, never inlines models (M4, D-005)", () => {
  function source(id: string, modelCount: number): SourceSummary {
    return {
      sourceId: id,
      type: "local",
      label: id,
      status: "ready",
      modelCount,
      auth: "none",
      freshness: { refreshedAt: AT, stale: false },
      actions: [],
    };
  }
  function entry(modelId: string, quant: string, arch: string, caps: string[]): CatalogEntry {
    return {
      sourceId: "lmstudio",
      modelId,
      displayName: modelId,
      kind: "local",
      capabilities: caps,
      contextLength: 8192,
      costTier: null,
      aliases: [],
      freshness: { refreshedAt: AT, stale: false },
      reasoningLevels: [],
      defaultReasoning: "off",
      quantization: quant,
      arch,
    };
  }

  it("emits one item per source with a model count, and reflects local quant/arch/capabilities", async () => {
    const snapshot: CatalogSnapshot = {
      sources: [source("lmstudio", 2)],
      catalogBySource: {
        lmstudio: [
          entry("qwen3-a", "4bit", "qwen3", ["tools"]),
          entry("qwen3-b", "8bit", "llama", ["vision", "tools"]),
        ],
      },
    };
    const body = await run(catalogSection({ snapshot }));
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item?.id).toBe("lmstudio");
    expect(item?.meta?.models).toBe(2);
    // D-005: quantization + arch + live capabilities are reflected as aggregated (deduped) facts.
    expect(String(item?.meta?.quant)).toContain("4bit");
    expect(String(item?.meta?.quant)).toContain("8bit");
    expect(String(item?.meta?.arch)).toContain("qwen3");
    expect(String(item?.meta?.caps)).toContain("vision");
  });

  it("does NOT inline a huge model list - a 1000-model source stays one summarized item", async () => {
    const many = Array.from({ length: 1000 }, (_, i) =>
      entry(`m-${i}`, "4bit", "qwen3", ["tools"]),
    );
    const snapshot: CatalogSnapshot = {
      sources: [source("lmstudio", 1000)],
      catalogBySource: { lmstudio: many },
    };
    const body = await run(catalogSection({ snapshot }));
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.meta?.models).toBe(1000);
    // The whole section serialized stays small - no per-model entry is inlined.
    expect(JSON.stringify(body).length).toBeLessThan(2000);
  });
});

describe("runtime / protocol / workspace summaries (M4)", () => {
  it("runtime section reports role + turn state", async () => {
    const body = await run(runtimeSection({ role: "leader", instanceId: "abc123", turn: "idle" }));
    expect(body.status).toBe("ok");
    expect(body.items.find((i) => i.id === "role")?.summary).toBe("leader");
    expect(body.items.find((i) => i.id === "turn")?.summary).toBe("idle");
  });

  it("protocol section reports the manifest schema version + host build when known", async () => {
    const body = await run(protocolSection({ hostVersion: "2.0.0", hostBuild: "abcdef" }));
    expect(body.items.find((i) => i.id === "manifest")?.meta?.version).toBeGreaterThanOrEqual(1);
    expect(body.items.find((i) => i.id === "host")?.summary).toBe("2.0.0");
  });

  it("workspace section shows the project basename + branch, never the absolute home path", async () => {
    const body = await run(
      workspaceSection({
        root: "/Users/secret/dev/trevorV2",
        cwd: "/Users/secret/dev/trevorV2/apps/web",
        branch: "main",
      }),
    );
    expect(JSON.stringify(body)).not.toContain("/Users/secret");
    expect(body.items.find((i) => i.id === "root")?.summary).toBe("trevorV2");
    expect(body.items.find((i) => i.id === "branch")?.summary).toBe("main");
  });
});
