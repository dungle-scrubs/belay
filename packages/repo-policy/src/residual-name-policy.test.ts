import { describe, expect, it } from "vitest";
import {
  findResidualNameViolations,
  formatResidualNameViolations,
  isResidualNamePolicyPath,
} from "./residual-name-policy";

describe("residual name policy", () => {
  it("scans docs, downstream plan docs, and Claude skills", () => {
    expect(isResidualNamePolicyPath("AGENTS.md")).toBe(true);
    expect(isResidualNamePolicyPath("CLAUDE.md")).toBe(true);
    expect(isResidualNamePolicyPath("docs/telemetry.md")).toBe(true);
    expect(
      isResidualNamePolicyPath(".plans/49-open-source-launch-readiness/implementation.md"),
    ).toBe(true);
    expect(isResidualNamePolicyPath(".claude/skills/implement-plan/SKILL.md")).toBe(true);
  });

  it("does not scan source files or the active rename plan narrative", () => {
    expect(isResidualNamePolicyPath("apps/web/src/app.tsx")).toBe(false);
    expect(isResidualNamePolicyPath(".plans/56-rename-to-trevor/implementation.md")).toBe(false);
  });

  it("flags the pre-Belay name in scanned files with line numbers", () => {
    const files = {
      "AGENTS.md": "Trevor is the harness\n~/.trevor/rules\n",
      ".claude/skills/implement-plan/SKILL.md": "repo /Users/kevin/dev/trevor\n",
      ".plans/56-rename-to-trevor/implementation.md": "Trevor is historical here\n",
    } as const;

    expect(
      findResidualNameViolations(Object.keys(files), (path) => files[path as keyof typeof files]),
    ).toEqual([
      { path: ".claude/skills/implement-plan/SKILL.md", line: 1, match: "trevor" },
      { path: "AGENTS.md", line: 1, match: "Trevor" },
      { path: "AGENTS.md", line: 2, match: "trevor" },
    ]);
  });

  it("allows the historical forms that name the retired project", () => {
    const historical = [
      "Legacy data may still sit under ~/.trevor_legacy from trevor legacy",
      "Read ~/dev/trevor_legacy only for Trevor legacy prior art",
      "The retired .plans/trevor-v2 umbrella and the V2-to-Trevor rename",
      "Plan 56 renamed trevorV2 to the Trevor V2 home",
    ].join("\n");

    expect(findResidualNameViolations(["AGENTS.md"], () => historical)).toEqual([]);
  });

  it("keeps output stable and actionable", () => {
    expect(formatResidualNameViolations([{ path: "AGENTS.md", line: 3, match: "Trevor" }])).toBe(
      [
        "Residual name policy failed: docs and Claude skills must not use the pre-Belay Trevor name.",
        "",
        '- AGENTS.md:3 contains "Trevor"',
      ].join("\n"),
    );
  });
});
