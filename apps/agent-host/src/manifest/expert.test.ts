import type { CapabilityManifest, ManifestScope, ManifestSection } from "@belay/session";
import { MANIFEST_VERSION } from "@belay/session";
import { resolveInterpolationConfig } from "@host/commands/interpolation";
import { describe, expect, it } from "vitest";
import {
  answerExpertQuery,
  BELAY_EXPERT_DESCRIPTION,
  BELAY_EXPERT_NAME,
  MAX_EXPERT_SECTIONS,
  selectExpertSections,
} from "./expert";

/** A manifest with a few named sections, for the routing/rendering assertions. */
function manifestWith(
  sections: ManifestSection[],
): (scope: ManifestScope) => Promise<CapabilityManifest> {
  return (scope) =>
    Promise.resolve({
      version: MANIFEST_VERSION,
      scope,
      generatedAt: "2026-07-01T00:00:00.000Z",
      sections,
      truncated: false,
    });
}

const TOOLS_SECTION: ManifestSection = {
  id: "tools",
  title: "Tools",
  status: "ok",
  items: [{ id: "read", label: "read" }],
};
const CATALOG_SECTION: ManifestSection = {
  id: "catalog",
  title: "Model catalog",
  status: "ok",
  items: [{ id: "lmstudio", label: "lmstudio" }],
};

describe("belay-expert discovery metadata (M8)", () => {
  it("has a stable name and a description that states what it does + when to use it (triggers)", () => {
    expect(BELAY_EXPERT_NAME).toBe("belay_expert");
    expect(BELAY_EXPERT_DESCRIPTION.toLowerCase()).toContain("capabilit");
    // Trigger visibility: the description tells the model when to reach for it.
    expect(BELAY_EXPERT_DESCRIPTION.toLowerCase()).toMatch(/use (this |it )?when|ask/);
  });
});

describe("belay-expert routes a question to a BOUNDED set of sections (M8)", () => {
  it("maps a question to only the relevant sections, never the whole manifest", () => {
    expect(selectExpertSections("what tools can you run?")).toEqual(["tools"]);
    expect(selectExpertSections("which providers and models are available?")).toEqual(["catalog"]);
    expect(selectExpertSections("what slash commands exist?")).toEqual([
      "commands",
      "commandFamilies",
    ]);
    expect(selectExpertSections("is the host healthy? run doctor")).toEqual(["doctor"]);
  });

  it("falls back to a small core overview for an unrecognized question", () => {
    const sections = selectExpertSections("tell me about yourself");
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.length).toBeLessThanOrEqual(MAX_EXPERT_SECTIONS);
  });

  it("never returns more than the bounded cap, even for a kitchen-sink question", () => {
    const sections = selectExpertSections(
      "tools commands styles skills agents mcp lsp hooks docs doctor providers runtime protocol workspace",
    );
    expect(sections.length).toBeLessThanOrEqual(MAX_EXPERT_SECTIONS);
  });
});

describe("belay-expert renders ONLY the sections a question needs (M8)", () => {
  it("renders just the routed section, not unrelated ones, from a single manifest read", async () => {
    const getManifest = manifestWith([TOOLS_SECTION, CATALOG_SECTION]);
    const answer = await answerExpertQuery("what tools can you run?", { getManifest });
    expect(answer).toContain("Tools");
    // The catalog section was in the manifest but not routed, so it is not in the answer.
    expect(answer).not.toContain("Model catalog");
  });

  it("reads the manifest at the expert scope", async () => {
    const scopes = new Set<ManifestScope>();
    const getManifest = (scope: ManifestScope): Promise<CapabilityManifest> => {
      scopes.add(scope);
      return manifestWith([TOOLS_SECTION])(scope);
    };
    await answerExpertQuery("what providers exist?", { getManifest });
    expect([...scopes]).toEqual(["expert"]);
  });

  it("reports an explicit unavailable answer when there is no live manifest", async () => {
    const answer = await answerExpertQuery("what tools exist?", {
      getManifest: () => Promise.resolve(null),
    });
    expect(answer.toLowerCase()).toContain("unavailable");
  });

  it("reads the manifest directly, so it works while general interpolation is DISABLED (D-004)", async () => {
    expect(resolveInterpolationConfig({}).enabled).toBe(false);
    const answer = await answerExpertQuery("what tools exist?", {
      getManifest: manifestWith([TOOLS_SECTION]),
    });
    expect(answer).toContain("Tools");
  });
});
