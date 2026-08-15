import type { CommandMenuPayload, CommandSpec, ManifestScope } from "@belay/session";
import type { OutputStyle } from "@host/prefs/styles";
import type { SkillEntry } from "@host/skills/skills";
import type { AgentDescriptor } from "@host/subagents/discovery";
import { describe, expect, it } from "vitest";
import {
  agentsSection,
  commandFamiliesSection,
  commandsSection,
  skillsSection,
  stylesSection,
  toolsSection,
} from "./core-sections";

const provide = (
  section: ReturnType<typeof toolsSection>,
  scope: ManifestScope,
): ReturnType<typeof section.provide> => section.provide({ scope });

describe("tools section (M3)", () => {
  const defs = [
    { name: "read", description: "Read a file" },
    { name: "write", description: "Write a file" },
  ];
  const readOnly = new Set(["read"]);

  it("summarizes each tool with a readOnly meta flag, in every scope", async () => {
    const section = toolsSection({ defs, readOnly });
    for (const scope of ["human", "compact"] as const) {
      const body = await provide(section, scope);
      expect(body.status).toBe("ok");
      const read = body.items.find((i) => i.id === "read");
      expect(read?.summary).toBe("Read a file");
      expect(read?.meta?.readOnly).toBe(true);
      expect(body.items.find((i) => i.id === "write")?.meta?.readOnly).toBe(false);
    }
  });
});

describe("commands section - debug commands are scope-gated (M3)", () => {
  const base: CommandSpec[] = [{ name: "/help", summary: "List commands" }];
  const debug: CommandSpec[] = [{ name: "/restart", summary: "Restart the host (debug)" }];

  it("marks debug commands with a debug scope tag in the human view", async () => {
    const body = await provide(commandsSection({ base, debug }), "human");
    expect(body.items.find((i) => i.id === "/help")?.scope).toBeUndefined();
    expect(body.items.find((i) => i.id === "/restart")?.scope).toBe("debug");
  });

  it("drops debug commands entirely from the compact/subagent/expert scopes", async () => {
    for (const scope of ["compact", "subagent", "expert"] as const) {
      const body = await provide(commandsSection({ base, debug }), scope);
      expect(body.items.map((i) => i.id)).toEqual(["/help"]);
    }
  });
});

describe("command-families section summarizes, never dumps (M3)", () => {
  const style: CommandMenuPayload = {
    family: "style",
    title: "Output style",
    rows: [
      { id: "default", label: "Default" },
      { id: "concise", label: "Concise" },
    ],
    searchable: false,
  };

  it("emits one item per family with a row count, not the rows themselves", async () => {
    const body = await provide(commandFamiliesSection({ families: [style] }), "human");
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item?.id).toBe("style");
    expect(item?.label).toBe("Output style");
    expect(item?.meta?.rows).toBe(2);
    // The top-level choice labels are previewed, but no row ids/children are dumped.
    expect(item?.summary).toBe("Default, Concise");
  });

  it("elides the choice preview past the cap so a huge family stays bounded", async () => {
    const big: CommandMenuPayload = {
      family: "big",
      title: "Big family",
      rows: Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, label: `Row ${i}` })),
    };
    const body = await provide(commandFamiliesSection({ families: [big] }), "human");
    expect(body.items[0]?.summary).toMatch(/\+12 more$/);
    expect(body.items[0]?.meta?.rows).toBe(20);
  });
});

describe("styles section (M3)", () => {
  const styles: OutputStyle[] = [
    { id: "default", label: "Default", description: "Standard", guidance: "", isDefault: true },
    { id: "concise", label: "Concise", description: "Short", guidance: "Be short." },
  ];

  it("summarizes styles and marks the default", async () => {
    const body = await provide(stylesSection({ styles }), "human");
    expect(body.items.find((i) => i.id === "default")?.meta?.default).toBe(true);
    expect(body.items.find((i) => i.id === "concise")?.meta?.default).toBe(false);
    // The guidance body (a turn-threading detail) is never inlined into the manifest.
    expect(JSON.stringify(body)).not.toContain("Be short.");
  });
});

describe("skills section - status-gated + capped (M3)", () => {
  function entry(id: string, status: SkillEntry["status"]): SkillEntry {
    return {
      resourceType: "skill",
      id,
      name: id,
      description: `${id} does things. Triggers: when asked`,
      triggers: "when asked",
      path: `/Users/secret/skills/${id}/SKILL.md`,
      rootKind: "global",
      status,
    };
  }

  it("includes only available skills in the compact scope, all (tagged) in the human scope", async () => {
    const entries = [entry("alpha", "available"), entry("beta", "shadowed")];
    const human = await provide(skillsSection({ entries }), "human");
    expect(human.items.map((i) => i.id).sort()).toEqual(["alpha", "beta"]);
    expect(human.items.find((i) => i.id === "beta")?.scope).toBe("shadowed");

    const compact = await provide(skillsSection({ entries }), "compact");
    expect(compact.items.map((i) => i.id)).toEqual(["alpha"]);
  });

  it("never leaks the on-disk skill path", async () => {
    const body = await provide(skillsSection({ entries: [entry("alpha", "available")] }), "human");
    expect(JSON.stringify(body)).not.toContain("/Users/secret");
  });

  it("caps a large registry and points at skills_list for the rest", async () => {
    const entries = Array.from({ length: 60 }, (_, i) => entry(`skill-${i}`, "available"));
    const body = await provide(skillsSection({ entries }), "compact");
    expect(body.status).toBe("truncated");
    expect(body.total).toBe(60);
    expect(body.items.length).toBeLessThan(60);
    expect(body.detail).toBe("skills_list");
  });
});

describe("agents section (M3)", () => {
  const agents: AgentDescriptor[] = [
    { id: "explorer", description: "Explores code", tools: ["read", "grep"], skills: ["search"] },
  ];

  it("summarizes each agent with tool + skill counts, not the full allow-lists", async () => {
    const body = await provide(agentsSection({ agents }), "human");
    const item = body.items[0];
    expect(item?.id).toBe("explorer");
    expect(item?.summary).toBe("Explores code");
    expect(item?.meta?.tools).toBe(2);
    expect(item?.meta?.skills).toBe(1);
  });

  it("reports an empty section explicitly when there are no agents", async () => {
    const body = await provide(agentsSection({ agents: [] }), "human");
    expect(body.status).toBe("empty");
    expect(body.items).toHaveLength(0);
  });
});
