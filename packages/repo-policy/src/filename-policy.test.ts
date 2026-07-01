import { describe, expect, it } from "vitest";
import {
  expectedKebabPath,
  findFilenameViolations,
  formatFilenameViolations,
  isConventionalDocument,
} from "./filename-policy";

describe("filename policy", () => {
  it("flags PascalCase repo-owned source filenames with expected kebab-case paths", () => {
    expect(
      findFilenameViolations([
        "apps/web/src/App.tsx",
        "apps/web/src/components/panel/PanelHost.test.tsx",
      ]),
    ).toEqual([
      {
        path: "apps/web/src/App.tsx",
        expectedPath: "apps/web/src/app.tsx",
      },
      {
        path: "apps/web/src/components/panel/PanelHost.test.tsx",
        expectedPath: "apps/web/src/components/panel/panel-host.test.tsx",
      },
    ]);
  });

  it("allows conventional documentation names explicitly", () => {
    expect(isConventionalDocument("AGENTS.md")).toBe(true);
    expect(isConventionalDocument("apps/web/HOTKEYS.md")).toBe(true);
    expect(isConventionalDocument(".claude/skills/implement-plan/SKILL.md")).toBe(true);
    expect(isConventionalDocument("apps/web/src/SKILL.md")).toBe(false);
    expect(findFilenameViolations(["AGENTS.md", "CLAUDE.md", "apps/web/HOTKEYS.md"])).toEqual([]);
  });

  it("flags lowercase non-kebab source and support filenames", () => {
    expect(
      findFilenameViolations([
        "tests/browser/_container.sh",
        "apps/web/src/foo_bar.ts",
        "apps/web/src/has space.ts",
      ]),
    ).toEqual([
      {
        path: "apps/web/src/foo_bar.ts",
        expectedPath: "apps/web/src/foo-bar.ts",
      },
      {
        path: "apps/web/src/has space.ts",
        expectedPath: "apps/web/src/has-space.ts",
      },
      {
        path: "tests/browser/_container.sh",
        expectedPath: "tests/browser/container.sh",
      },
    ]);
  });

  it("includes stories, tests, and component source files in the migration set", () => {
    expect(
      findFilenameViolations([
        "apps/web/src/components/command-modal/CommandModal.stories.tsx",
        "apps/web/src/components/command-modal/CommandModal.test.tsx",
        "apps/web/src/components/command-modal/CommandModal.tsx",
      ]),
    ).toEqual([
      {
        path: "apps/web/src/components/command-modal/CommandModal.stories.tsx",
        expectedPath: "apps/web/src/components/command-modal/command-modal.stories.tsx",
      },
      {
        path: "apps/web/src/components/command-modal/CommandModal.test.tsx",
        expectedPath: "apps/web/src/components/command-modal/command-modal.test.tsx",
      },
      {
        path: "apps/web/src/components/command-modal/CommandModal.tsx",
        expectedPath: "apps/web/src/components/command-modal/command-modal.tsx",
      },
    ]);
  });

  it("keeps violation output stable and actionable", () => {
    const violations = findFilenameViolations([
      "apps/web/src/components/panel/SidePanel.tsx",
      "apps/web/src/App.tsx",
    ]);

    expect(formatFilenameViolations(violations)).toMatchInlineSnapshot(`
      "Filename policy failed: repo-owned source/support filenames must be kebab-case.

      - apps/web/src/App.tsx -> apps/web/src/app.tsx
      - apps/web/src/components/panel/SidePanel.tsx -> apps/web/src/components/panel/side-panel.tsx"
    `);
  });

  it("converts acronyms and compound names consistently", () => {
    expect(expectedKebabPath("apps/web/src/XMLHttpRequestPanel.test.tsx")).toBe(
      "apps/web/src/xml-http-request-panel.test.tsx",
    );
  });
});
