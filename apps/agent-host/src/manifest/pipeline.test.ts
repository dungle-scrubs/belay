import { renderManifestExport } from "@belay/session";
import type { SkillEntry } from "@host/skills/skills";
import { describe, expect, it } from "vitest";
import { assembleManifest, type ManifestDeps } from "./build";
import { answerExpertQuery } from "./expert";
import { currentManifest, registerManifestSource } from "./source";

const AT = "2026-07-01T00:00:00.000Z";

/** Secrets + paths deliberately smuggled into every registry field, to prove the pipeline scrubs them. */
const LEAK_PATH = "/Users/kevin/.ssh/id_rsa";
const LEAK_TOKEN = "sk-LEAKABCDEF1234567890";
const LEAK_HEADER = "Authorization: Bearer topsecretvalue123";

function skill(id: string): SkillEntry {
  return {
    resourceType: "skill",
    id,
    name: id,
    description: `runs ${id}; reads ${LEAK_PATH} with ${LEAK_TOKEN}. Triggers: on demand`,
    triggers: "on demand",
    path: LEAK_PATH,
    rootKind: "global",
    status: "available",
  };
}

/** Realistic-but-leaky deps: enough sections populated to exercise ok / truncated / unavailable. */
function leakyDeps(): ManifestDeps {
  return {
    toolDefs: [{ name: "read", description: "Read a file" }],
    readOnlyTools: new Set(["read"]),
    commands: [{ name: "/help", summary: `list commands ${LEAK_TOKEN}` }],
    debugCommands: [{ name: "/restart", summary: "Restart (debug)" }],
    commandFamilies: [
      { family: "style", title: "Output style", rows: [{ id: "default", label: "Default" }] },
    ],
    styles: [
      { id: "default", label: "Default", description: "Standard", guidance: "", isDefault: true },
    ],
    // A large skill set to force truncation in a prompt scope.
    skills: Array.from({ length: 60 }, (_, i) => skill(`skill-${i}`)),
    agents: [
      { id: "explorer", description: `explore ${LEAK_HEADER}`, tools: ["read"], skills: [] },
    ],
    doctorAreas: [{ id: "core", label: "Core", status: "error", verdict: `boom ${LEAK_TOKEN}` }],
    catalog: null,
    runtime: { role: "leader", instanceId: "abc12345" },
    host: { version: "2.0.0" },
    workspace: { root: "/Users/kevin/dev/belay", cwd: "/Users/kevin/dev/belay" },
  };
}

/** Asserts no smuggled secret / auth header value / absolute home path survived into `output`. The path
 *  redactor collapses the sensitive prefix to `<path>` but deliberately keeps the basename as a hint, so
 *  we assert the home prefix is gone - not the tail filename. */
function expectScrubbed(output: string): void {
  expect(output).not.toContain("/Users/kevin");
  expect(output).not.toContain(".ssh/id_rsa");
  expect(output).not.toContain("sk-LEAK");
  expect(output).not.toContain("topsecretvalue");
}

describe("capability manifest end-to-end: registries -> manifest -> export (M10)", () => {
  it("composes a full manifest and exports human text with provenance + explicit unavailable sections", async () => {
    const manifest = await assembleManifest(leakyDeps(), "human", AT);
    const text = renderManifestExport(manifest, { format: "text", detail: "full" });
    // Full pipeline reached every section family.
    expect(text).toContain("Tools");
    expect(text).toContain("Commands");
    expect(text).toContain("Skills");
    // Unwired peripherals + unloaded catalog are explicit, not missing.
    expect(text.toLowerCase()).toContain("unavailable");
    expect(text).toContain("MCP servers");
    // Provenance is surfaced.
    expect(text).toContain("source:");
  });

  it("exports stable JSON that decodes, deterministically", async () => {
    const a = renderManifestExport(await assembleManifest(leakyDeps(), "human", AT), {
      format: "json",
      detail: "full",
    });
    const b = renderManifestExport(await assembleManifest(leakyDeps(), "human", AT), {
      format: "json",
      detail: "full",
    });
    expect(a).toBe(b);
    expect(() => JSON.parse(a)).not.toThrow();
  });

  it("truncates a large dynamic section in a prompt scope and points at how to fetch the rest", async () => {
    const manifest = await assembleManifest(leakyDeps(), "compact", AT);
    const skills = manifest.sections.find((s) => s.id === "skills");
    expect(skills?.status).toBe("truncated");
    expect(skills?.total).toBe(60);
    expect(skills?.detail).toBe("skills_list");
    expect(manifest.truncated).toBe(true);
  });

  it("REDACTS secrets, auth headers, and home paths across human, JSON, compact, and expert variants", async () => {
    const human = await assembleManifest(leakyDeps(), "human", AT);
    const compact = await assembleManifest(leakyDeps(), "compact", AT);
    const expert = await assembleManifest(leakyDeps(), "expert", AT);
    expectScrubbed(renderManifestExport(human, { format: "text", detail: "full" }));
    expectScrubbed(renderManifestExport(human, { format: "json", detail: "full" }));
    expectScrubbed(renderManifestExport(compact, { format: "text", detail: "compact" }));
    expectScrubbed(renderManifestExport(expert, { format: "text", detail: "compact" }));
  });
});

describe("capability manifest end-to-end: manifest -> belay-expert answer (M10)", () => {
  it("answers a capability question through the registered live source, redacted", async () => {
    registerManifestSource((scope) => assembleManifest(leakyDeps(), scope, AT));
    // The expert routes "skills" -> the skills section and reads the live manifest (default getManifest).
    const answer = await answerExpertQuery("what skills do you have?");
    expect(answer).toContain("Skills");
    expectScrubbed(answer);
  });

  it("serves an expert-scoped section slice end to end", async () => {
    registerManifestSource((scope) => assembleManifest(leakyDeps(), scope, AT));
    const manifest = await currentManifest("expert");
    expect(manifest).not.toBeNull();
    const slice = manifest
      ? renderManifestExport(manifest, { format: "json", detail: "full", section: "commands" })
      : "";
    expect(JSON.parse(slice).sections[0].id).toBe("commands");
    expectScrubbed(slice);
  });
});
