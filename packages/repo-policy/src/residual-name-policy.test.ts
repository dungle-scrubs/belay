import { describe, expect, it } from "vitest";
import {
  findResidualNameViolations,
  formatResidualNameViolations,
  isResidualNamePolicyPath,
} from "./residual-name-policy";

describe("residual name policy", () => {
  const oldSuffix = "V2";
  const oldTitle = `Belay ${oldSuffix}`;
  const oldProject = `belay${oldSuffix}`;
  const oldHome = `~/.belay${oldSuffix}`;

  it("scans docs and Claude skills", () => {
    expect(isResidualNamePolicyPath("AGENTS.md")).toBe(true);
    expect(isResidualNamePolicyPath("CLAUDE.md")).toBe(true);
    expect(isResidualNamePolicyPath("docs/telemetry.md")).toBe(true);
    expect(isResidualNamePolicyPath("apps/web/README.md")).toBe(true);
    expect(isResidualNamePolicyPath(".claude/skills/implement-plan/SKILL.md")).toBe(true);
  });

  it("does not scan source files", () => {
    expect(isResidualNamePolicyPath("apps/web/src/app.tsx")).toBe(false);
  });

  it("flags old project names in scanned files with line numbers", () => {
    const files = {
      "AGENTS.md": `${oldTitle}\n${oldHome}\n`,
      ".claude/skills/implement-plan/SKILL.md": `repo /Users/kevin/dev/${oldProject}\n`,
    } as const;

    expect(
      findResidualNameViolations(Object.keys(files), (path) => files[path as keyof typeof files]),
    ).toEqual([
      { path: ".claude/skills/implement-plan/SKILL.md", line: 1, match: oldProject },
      { path: "AGENTS.md", line: 1, match: oldTitle },
      { path: "AGENTS.md", line: 2, match: oldHome },
    ]);
  });

  it("keeps output stable and actionable", () => {
    expect(formatResidualNameViolations([{ path: "AGENTS.md", line: 3, match: oldTitle }])).toBe(
      [
        "Residual name policy failed: docs and Claude skills must not use old Belay rename markers.",
        "",
        `- AGENTS.md:3 contains ${JSON.stringify(oldTitle)}`,
      ].join("\n"),
    );
  });
});
