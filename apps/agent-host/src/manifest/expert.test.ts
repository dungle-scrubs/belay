import type { ManifestExportRequest, ManifestScope, ManifestSectionId } from "@trevor/session";
import { describe, expect, it } from "vitest";
import {
  answerExpertQuery,
  MAX_EXPERT_SECTIONS,
  selectExpertSections,
  TREVOR_EXPERT_DESCRIPTION,
  TREVOR_EXPERT_NAME,
} from "./expert";

describe("trevor-expert discovery metadata (M8)", () => {
  it("has a stable name and a description that states what it does + when to use it (triggers)", () => {
    expect(TREVOR_EXPERT_NAME).toBe("trevor_expert");
    expect(TREVOR_EXPERT_DESCRIPTION.toLowerCase()).toContain("capabilit");
    // Trigger visibility: the description tells the model when to reach for it.
    expect(TREVOR_EXPERT_DESCRIPTION.toLowerCase()).toMatch(/use (this |it )?when|ask/);
  });
});

describe("trevor-expert routes a question to a BOUNDED set of sections (M8)", () => {
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

describe("trevor-expert loads ONLY the sections a question needs (M8)", () => {
  it("requests just the routed section slices, not the full manifest", async () => {
    const requested: ManifestSectionId[] = [];
    const load = (
      _scope: ManifestScope,
      request: ManifestExportRequest,
    ): Promise<string | null> => {
      if (request.section) {
        requested.push(request.section);
      }
      return Promise.resolve(`slice for ${request.section}`);
    };
    const answer = await answerExpertQuery("what tools can you run?", { load });
    expect(requested).toEqual(["tools"]);
    // Never loaded an unrelated section.
    expect(requested).not.toContain("catalog");
    expect(answer).toContain("slice for tools");
  });

  it("uses the expert scope + section-scoped requests", async () => {
    const scopes = new Set<ManifestScope>();
    const load = (scope: ManifestScope, request: ManifestExportRequest): Promise<string | null> => {
      scopes.add(scope);
      expect(request.section).toBeDefined();
      return Promise.resolve("slice");
    };
    await answerExpertQuery("what providers exist?", { load });
    expect([...scopes]).toEqual(["expert"]);
  });

  it("reports an explicit unavailable answer when there is no live manifest", async () => {
    const load = (): Promise<string | null> => Promise.resolve(null);
    const answer = await answerExpertQuery("what tools exist?", { load });
    expect(answer.toLowerCase()).toContain("unavailable");
  });
});
