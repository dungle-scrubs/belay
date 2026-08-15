import { readFileSync } from "node:fs";

export interface ResidualNameViolation {
  readonly line: number;
  readonly match: string;
  readonly path: string;
}

const OLD_VERSION_SUFFIX = "V2";
const RESIDUAL_PATTERN = new RegExp(
  [
    `~\\/\\.belay${OLD_VERSION_SUFFIX}`,
    `Belay ${OLD_VERSION_SUFFIX}`,
    `belay${OLD_VERSION_SUFFIX}`,
  ].join("|"),
  "g",
);

const isMarkdownDoc = (path: string): boolean =>
  path.endsWith(".md") &&
  (path === "AGENTS.md" ||
    path === "CLAUDE.md" ||
    path === "CONTEXT.md" ||
    path === "FEATURES.md" ||
    path === "SECURITY_RISKS.md" ||
    path.startsWith("docs/") ||
    path.startsWith("apps/") ||
    path.startsWith(".plans/46-worktree-fleet/") ||
    path.startsWith(".plans/48-desktop-shell-tauri/") ||
    path.startsWith(".plans/49-open-source-launch-readiness/"));

const isClaudeSkill = (path: string): boolean =>
  path.startsWith(".claude/skills/") && path.endsWith("/SKILL.md");

export const isResidualNamePolicyPath = (path: string): boolean =>
  isMarkdownDoc(path) || isClaudeSkill(path);

const findMatches = (path: string, contents: string): readonly ResidualNameViolation[] => {
  const violations: ResidualNameViolation[] = [];
  const lines = contents.split("\n");
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(RESIDUAL_PATTERN)) {
      violations.push({ path, line: index + 1, match: match[0] });
    }
  }
  return violations;
};

export const findResidualNameViolations = (
  paths: readonly string[],
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): readonly ResidualNameViolation[] =>
  paths
    .filter(isResidualNamePolicyPath)
    .flatMap((path) => findMatches(path, readFile(path)))
    .sort(
      (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.match.localeCompare(b.match),
    );

export const formatResidualNameViolations = (
  violations: readonly ResidualNameViolation[],
): string => {
  if (violations.length === 0) {
    return "Residual name policy OK: docs and Claude skills use the Belay name.";
  }

  const lines = [
    "Residual name policy failed: docs and Claude skills must not use old Belay rename markers.",
    "",
    ...violations.map(
      ({ line, match, path }) => `- ${path}:${line} contains ${JSON.stringify(match)}`,
    ),
  ];

  return lines.join("\n");
};
