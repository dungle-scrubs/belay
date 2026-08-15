import type { CapabilityManifest, ManifestScope } from "@belay/session";
import { MANIFEST_VERSION } from "@belay/session";
import { describe, expect, it } from "vitest";
import { buildTrevorExportCommand, parseExportArgs } from "./export-command";
import { registerManifestSource } from "./source";

function fakeManifest(scope: ManifestScope): CapabilityManifest {
  return {
    version: MANIFEST_VERSION,
    scope,
    generatedAt: "2026-07-01T00:00:00.000Z",
    sections: [
      {
        id: "tools",
        title: "Tools",
        status: "ok",
        items: [{ id: "read", label: "read", summary: "Read a file" }],
      },
    ],
    truncated: false,
  };
}

describe("parseExportArgs (M6)", () => {
  it("defaults to a full human text export", () => {
    const r = parseExportArgs("");
    expect(r).toEqual({
      ok: true,
      plan: { scope: "human", request: { format: "text", detail: "full" } },
    });
  });

  it("maps --json to the JSON format", () => {
    const r = parseExportArgs("--json");
    expect(r.ok && r.plan.request.format).toBe("json");
  });

  it("maps --compact + --expert to their prompt scopes and compact detail", () => {
    const compact = parseExportArgs("--compact");
    expect(compact.ok && compact.plan.scope).toBe("compact");
    expect(compact.ok && compact.plan.request.detail).toBe("compact");
    const expert = parseExportArgs("--expert");
    expect(expert.ok && expert.plan.scope).toBe("expert");
  });

  it("accepts a valid --section and rejects an invalid one", () => {
    const ok = parseExportArgs("--section skills");
    expect(ok.ok && ok.plan.request.section).toBe("skills");
    const bad = parseExportArgs("--section not-a-section");
    expect(bad.ok).toBe(false);
  });

  it("accepts an explicit --scope and rejects an unknown one", () => {
    const ok = parseExportArgs("--scope subagent");
    expect(ok.ok && ok.plan.scope).toBe("subagent");
    expect(parseExportArgs("--scope root").ok).toBe(false);
  });

  it("rejects an incoherent --compact against a full scope, and unknown flags", () => {
    expect(parseExportArgs("--scope human --compact").ok).toBe(false);
    expect(parseExportArgs("--wat").ok).toBe(false);
  });
});

describe("/belay-export command dispatch (M6)", () => {
  it("reports the manifest as unavailable when no live source is registered", async () => {
    // This runs before any registration in this file, so the source is unset.
    const command = buildTrevorExportCommand();
    const result = await command.run("", undefined);
    expect(typeof result === "object" && result.ok).toBe(false);
    expect(typeof result === "object" && result.text).toMatch(/unavailable/i);
  });

  it("renders JSON and human text from the live source, at the requested scope", async () => {
    registerManifestSource((scope) => Promise.resolve(fakeManifest(scope)));
    const command = buildTrevorExportCommand();

    const json = await command.run("--json", undefined);
    const jsonText = typeof json === "object" ? json.text : json;
    expect(() => JSON.parse(jsonText)).not.toThrow();
    expect(JSON.parse(jsonText).scope).toBe("human");

    const compact = await command.run("--compact", undefined);
    const compactText = typeof compact === "object" ? compact.text : compact;
    // The source was asked for the compact scope, and the compact projection rendered.
    expect(compactText.toLowerCase()).toContain("compact");
    expect(compactText).toContain("Tools");
  });
});
