import { readFileSync } from "node:fs";

export interface ResidualNameViolation {
  readonly line: number;
  readonly match: string;
  readonly path: string;
}

/** Forms of the pre-Belay name that are legitimate history, not residue: the real `~/.trevor_legacy`
 *  and `~/dev/trevor_legacy` directories, prose naming the retired project, and the artifacts of the
 *  earlier trevorV2 -> trevor rename. These are redacted from a line before residue is looked for, so
 *  a doc may still say "Trevor legacy" while "~/.trevor" fails the build. */
const HISTORICAL_FORMS: readonly RegExp[] = [
  /V2-to-Trevor/g,
  /rename-to-trevor/g,
  /trevor-v2/g,
  /[Tt]revorV2/g,
  /Trevor V2/g,
  /Trevor v2/g,
  /trevor v2/g,
  /trevor_legacy/g,
  /Trevor legacy/g,
  /trevor legacy/g,
];

const RESIDUAL_PATTERN = /trevor/gi;

/** Blanks out historical forms while preserving offsets, so reported line/column stay truthful. */
const redactHistorical = (line: string): string =>
  HISTORICAL_FORMS.reduce(
    (acc, form) => acc.replace(form, (match) => " ".repeat(match.length)),
    line,
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
    for (const match of redactHistorical(line).matchAll(RESIDUAL_PATTERN)) {
      // Redaction preserves offsets, so the original spelling is read back from the untouched line.
      const spelling = line.slice(match.index, match.index + match[0].length);
      violations.push({ path, line: index + 1, match: spelling });
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
    "Residual name policy failed: docs and Claude skills must not use the pre-Belay Trevor name.",
    "",
    ...violations.map(
      ({ line, match, path }) => `- ${path}:${line} contains ${JSON.stringify(match)}`,
    ),
  ];

  return lines.join("\n");
};
