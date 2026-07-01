import type { CapabilityManifest, ManifestScope } from "@trevor/session";
import { MANIFEST_VERSION } from "@trevor/session";
import { describe, expect, it } from "vitest";
import { resolveInterpolationConfig } from "../interpolation";
import { expertManifestExport } from "./expert-access";
import { registerManifestSource } from "./source";

function fakeManifest(scope: ManifestScope): CapabilityManifest {
  return {
    version: MANIFEST_VERSION,
    scope,
    generatedAt: "2026-07-01T00:00:00.000Z",
    sections: [
      { id: "tools", title: "Tools", status: "ok", items: [{ id: "read", label: "read" }] },
    ],
    truncated: false,
  };
}

describe("expert direct export access is independent of the interpolation gate (M7, D-004)", () => {
  it("returns null when there is no live manifest source", async () => {
    // Runs before registration in this file - the source is unset.
    expect(await expertManifestExport("expert", { format: "text", detail: "compact" })).toBeNull();
  });

  it("exports even while general interpolation is DISABLED", async () => {
    registerManifestSource((scope) => Promise.resolve(fakeManifest(scope)));
    // General interpolation is off...
    const interpolation = resolveInterpolationConfig({});
    expect(interpolation.enabled).toBe(false);
    // ...yet the trusted built-in still reads the manifest directly.
    const text = await expertManifestExport("expert", { format: "text", detail: "compact" });
    expect(text).not.toBeNull();
    expect(text).toContain("Tools");
  });

  it("serves a JSON slice for a single section", async () => {
    registerManifestSource((scope) => Promise.resolve(fakeManifest(scope)));
    const json = await expertManifestExport("expert", {
      format: "json",
      detail: "full",
      section: "tools",
    });
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json ?? "{}") as CapabilityManifest;
    expect(parsed.sections.map((s) => s.id)).toEqual(["tools"]);
  });
});
