import { type CatalogEntry, events, PRODUCER_IDS, type SourceSummary } from "@trevor/session";
import { recordingTransport, storedLog } from "@trevor/test-kit";
import { describe, expect, it } from "vitest";
import { EMPTY_CATALOG_SNAPSHOT, projectCatalog } from "./catalog";
import { createTrevorClient } from "./client";

const SESSION_URL = "http://127.0.0.1:17424";

function source(overrides: Partial<SourceSummary> = {}): SourceSummary {
  return {
    sourceId: "lmstudio",
    type: "local",
    label: "LM Studio",
    status: "ready",
    modelCount: 1,
    auth: "none",
    freshness: { refreshedAt: "2026-07-09T00:00:00.000Z", stale: false },
    actions: [],
    ...overrides,
  };
}

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    sourceId: "lmstudio",
    modelId: "qwen3",
    displayName: "Qwen 3",
    kind: "local",
    capabilities: ["reasoning"],
    contextLength: 128_000,
    costTier: null,
    aliases: [],
    freshness: { refreshedAt: "2026-07-09T00:00:00.000Z", stale: false },
    reasoningLevels: ["off", "low", "high"],
    defaultReasoning: "low",
    ...overrides,
  };
}

describe("catalog read", () => {
  it("projects host.online payload.catalog as SDK catalogBySource", async () => {
    const rec = recordingTransport();
    const client = createTrevorClient({
      sessionUrl: SESSION_URL,
      producerId: PRODUCER_IDS.web,
      transport: rec.transport,
    });
    const sources = [source()];
    const catalogBySource = { lmstudio: [entry()] };
    rec.seed(
      "s1",
      storedLog(
        events.hostOnline({
          providers: ["lmstudio"],
          default: "lmstudio",
          models: {},
          instanceId: "host-1",
          cwd: "/repo",
          workspace: "/repo",
          commands: [],
          agents: [],
          sources,
          catalog: catalogBySource,
        }),
      ),
    );

    await expect(client.listCatalog("s1")).resolves.toEqual({
      sources,
      catalogBySource,
    });
  });

  it("returns an empty snapshot when no host catalog is present", () => {
    expect(projectCatalog([])).toEqual(EMPTY_CATALOG_SNAPSHOT);
    expect(
      projectCatalog(storedLog(events.userMessage({ text: "hi", provider: "lmstudio" }))),
    ).toEqual(EMPTY_CATALOG_SNAPSHOT);
  });
});
