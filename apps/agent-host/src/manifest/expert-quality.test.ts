import type {
  CapabilityManifest,
  ManifestExportRequest,
  ManifestScope,
  ManifestSection,
} from "@trevor/session";
import { MANIFEST_VERSION, renderManifestExport } from "@trevor/session";
import { describe, expect, it } from "vitest";
import { READ_ONLY_TOOLS } from "../tools";
import { answerExpertQuery, TREVOR_EXPERT_NAME } from "./expert";

/**
 * A rich fake manifest covering every topic, plus one unavailable section, so the expert evals exercise
 * real routing + rendering without a live host. The `load` used below renders a section slice from this.
 */
const SECTIONS: ManifestSection[] = [
  {
    id: "tools",
    title: "Tools",
    status: "ok",
    items: [{ id: "read", label: "read", summary: "Read a file", meta: { readOnly: true } }],
    provenance: { source: "tool-registry", fresh: true },
  },
  {
    id: "commands",
    title: "Commands",
    status: "ok",
    items: [{ id: "/help", label: "/help", summary: "List commands" }],
    provenance: { source: "command-registry", fresh: true },
  },
  {
    id: "skills",
    title: "Skills",
    status: "ok",
    items: [{ id: "planner", label: "planner", summary: "Plan work" }],
    provenance: { source: "skill-registry", fresh: true },
  },
  {
    id: "catalog",
    title: "Model catalog",
    status: "ok",
    items: [
      { id: "lmstudio", label: "lmstudio", summary: "ready", meta: { models: 3, quant: "4bit" } },
    ],
    provenance: { source: "catalog-snapshot", fresh: true },
  },
  {
    id: "doctor",
    title: "Doctor",
    status: "ok",
    items: [{ id: "core", label: "Core", summary: "healthy", meta: { status: "ok" } }],
    provenance: { source: "doctor-snapshot", fresh: true },
  },
  {
    id: "protocol",
    title: "Protocol",
    status: "ok",
    items: [{ id: "manifest", label: "Manifest schema", meta: { version: MANIFEST_VERSION } }],
    provenance: { source: "protocol", fresh: true },
  },
  { id: "mcp", title: "MCP servers", status: "unavailable", note: "not configured", items: [] },
];

function fakeManifest(scope: ManifestScope): CapabilityManifest {
  return {
    version: MANIFEST_VERSION,
    scope,
    generatedAt: "2026-07-01T00:00:00.000Z",
    sections: SECTIONS,
    truncated: false,
  };
}

/** A load that renders a real section slice from the fake manifest (mirrors the live path). */
const load = (scope: ManifestScope, request: ManifestExportRequest): Promise<string | null> =>
  Promise.resolve(renderManifestExport(fakeManifest(scope), request));

describe("trevor-expert safety - read-only, no authority, bounded (M9)", () => {
  it("is classified read-only in the shared tool vocabulary", () => {
    expect(READ_ONLY_TOOLS.has(TREVOR_EXPERT_NAME)).toBe(true);
  });

  it("only ever issues read requests (text/json exports), never a mutating action", async () => {
    const formats = new Set<string>();
    const details = new Set<string>();
    const spy = (_s: ManifestScope, r: ManifestExportRequest): Promise<string | null> => {
      formats.add(r.format);
      details.add(r.detail);
      return Promise.resolve("slice");
    };
    await answerExpertQuery("what tools and commands exist?", { load: spy });
    // Every request is a bounded export read - there is no field through which it could mutate or grant.
    expect([...formats].every((f) => f === "text" || f === "json")).toBe(true);
    expect([...details].every((d) => d === "full" || d === "compact")).toBe(true);
  });

  it("bounds its answer to a small number of sections", async () => {
    const requested: string[] = [];
    const spy = (_s: ManifestScope, r: ManifestExportRequest): Promise<string | null> => {
      if (r.section) {
        requested.push(r.section);
      }
      return Promise.resolve("slice");
    };
    await answerExpertQuery("tools commands skills agents providers doctor protocol workspace", {
      load: spy,
    });
    expect(requested.length).toBeLessThanOrEqual(4);
  });
});

describe("trevor-expert answer quality across topics (M9 evals)", () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["what tools can you run?", "read"],
    ["what slash commands exist?", "/help"],
    ["what skills do you have?", "planner"],
    ["which providers and models are available?", "lmstudio"],
    ["is the host healthy?", "Core"],
    ["what protocol version is this?", "Manifest schema"],
  ];

  for (const [question, expected] of cases) {
    it(`answers "${question}" from the manifest with provenance`, async () => {
      const answer = await answerExpertQuery(question, { load });
      expect(answer).toContain(expected);
      // Provenance is surfaced - the answer says where the facts came from.
      expect(answer).toContain("source:");
    });
  }

  it("reports an unavailable section explicitly rather than inventing an answer", async () => {
    const answer = await answerExpertQuery("what MCP servers are connected?", { load });
    expect(answer.toLowerCase()).toContain("unavailable");
    expect(answer).toContain("not configured");
  });

  it("gives a general overview + an explicit area list for an unrecognized topic", async () => {
    // "rules and policies" matches no route (that is a later plan) - it must not fabricate.
    const answer = await answerExpertQuery("tell me about your rules and policies", { load });
    expect(answer.toLowerCase()).toContain("ask trevor-expert about");
    // Falls back to the core overview (commands/tools), not a made-up rules list.
    expect(answer).toContain("/help");
  });
});
