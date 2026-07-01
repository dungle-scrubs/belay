import type { CapabilityManifest, ManifestScope, ManifestSection } from "@trevor/session";
import { MANIFEST_VERSION } from "@trevor/session";
import { describe, expect, it } from "vitest";
import { READ_ONLY_TOOLS } from "../tools";
import { answerExpertQuery, MAX_EXPERT_SECTIONS, TREVOR_EXPERT_NAME } from "./expert";

/**
 * A rich fake manifest covering every topic, plus one unavailable section, so the expert evals exercise
 * real routing + rendering without a live host. The `getManifest` below returns it for any scope.
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

/** A manifest getter over the fake, mirroring the live host seam. */
const getManifest = (scope: ManifestScope): Promise<CapabilityManifest> =>
  Promise.resolve(fakeManifest(scope));

describe("trevor-expert safety - read-only, no authority, bounded (M9)", () => {
  it("is classified read-only in the shared tool vocabulary", () => {
    expect(READ_ONLY_TOOLS.has(TREVOR_EXPERT_NAME)).toBe(true);
  });

  it("only READS the manifest at the expert scope - its sole external call is a manifest read", async () => {
    const scopes: ManifestScope[] = [];
    let calls = 0;
    await answerExpertQuery("what tools and commands exist?", {
      getManifest: (scope) => {
        calls++;
        scopes.push(scope);
        return getManifest(scope);
      },
    });
    // One read, at the expert scope - there is no field through which it could mutate or grant.
    expect(calls).toBe(1);
    expect(scopes).toEqual(["expert"]);
  });

  it("bounds its answer to a small number of sections", async () => {
    const answer = await answerExpertQuery(
      "tools commands skills agents providers doctor protocol workspace",
      { getManifest },
    );
    // At most MAX_EXPERT_SECTIONS "## <section>" blocks in the rendered answer.
    const blocks = answer.match(/^## /gm) ?? [];
    expect(blocks.length).toBeLessThanOrEqual(MAX_EXPERT_SECTIONS);
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
      const answer = await answerExpertQuery(question, { getManifest });
      expect(answer).toContain(expected);
      // Provenance is surfaced - the answer says where the facts came from.
      expect(answer).toContain("source:");
    });
  }

  it("reports an unavailable section explicitly rather than inventing an answer", async () => {
    const answer = await answerExpertQuery("what MCP servers are connected?", { getManifest });
    expect(answer.toLowerCase()).toContain("unavailable");
    expect(answer).toContain("not configured");
  });

  it("gives a general overview + an explicit area list for an unrecognized topic", async () => {
    // "rules and policies" matches no route (that is a later plan) - it must not fabricate.
    const answer = await answerExpertQuery("tell me about your rules and policies", {
      getManifest,
    });
    expect(answer.toLowerCase()).toContain("ask trevor-expert about");
    // Falls back to the core overview (commands/tools), not a made-up rules list.
    expect(answer).toContain("/help");
  });
});
