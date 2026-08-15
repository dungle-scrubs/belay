import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path/posix";

const CONVENTIONAL_DOCUMENT_NAMES = new Set([
  "AGENTS.md",
  "ARCHITECTURE.md",
  "CHANGELOG.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "CONTEXT.md",
  "FEATURES.md",
  "HOTKEYS.md",
  "LICENSE",
  "PULL_REQUEST_TEMPLATE.md",
  "README.md",
  "SECURITY.md",
  "SECURITY_RISKS.md",
]);

const GENERATED_FILE_PATTERNS: readonly RegExp[] = [
  /^apps\/web\/__snapshots__\//,
  /^test-results\//,
  /^playwright-report\//,
];

const SKILL_FILE_PATTERNS: readonly RegExp[] = [
  /^\.claude\/skills\/[^/]+\/SKILL\.md$/,
  /^\.belay\/skills\/[^/]+\/SKILL\.md$/,
];

const GITHUB_TEMPLATE_PATTERNS: readonly RegExp[] = [
  /^\.github\/ISSUE_TEMPLATE\/.+\.yml$/,
  /^\.github\/PULL_REQUEST_TEMPLATE\.md$/,
  /^\.github\/workflows\/.+\.yml$/,
  /^\.github\/dependabot\.yml$/,
];

export interface FilenameViolation {
  readonly expectedPath: string;
  readonly path: string;
}

export const isConventionalDocument = (path: string): boolean => {
  const filename = basename(path);
  return (
    CONVENTIONAL_DOCUMENT_NAMES.has(filename) ||
    SKILL_FILE_PATTERNS.some((pattern) => pattern.test(path)) ||
    GITHUB_TEMPLATE_PATTERNS.some((pattern) => pattern.test(path))
  );
};

export const isGeneratedPath = (path: string): boolean =>
  GENERATED_FILE_PATTERNS.some((pattern) => pattern.test(path));

const toKebabCaseSegment = (segment: string): string =>
  segment
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

export const expectedKebabPath = (path: string): string => {
  const filename = basename(path);

  const expectedFilename = filename
    .split(".")
    .map((segment) => toKebabCaseSegment(segment))
    .join(".");

  const parent = dirname(path);
  return parent === "." ? expectedFilename : join(parent, expectedFilename);
};

export const findFilenameViolations = (paths: readonly string[]): readonly FilenameViolation[] =>
  paths
    .filter((path) => !isConventionalDocument(path))
    .filter((path) => !isGeneratedPath(path))
    .map((path) => ({ path, expectedPath: expectedKebabPath(path) }))
    .filter(({ path, expectedPath }) => path !== expectedPath)
    .sort((a, b) => a.path.localeCompare(b.path));

export const listGitTrackedFiles = (cwd = process.cwd()): readonly string[] => {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd,
    encoding: "utf8",
  });

  return output.split("\0").filter((path) => path.length > 0);
};

export const formatFilenameViolations = (violations: readonly FilenameViolation[]): string => {
  if (violations.length === 0) {
    return "Filename policy OK: all repo-owned filenames are kebab-case.";
  }

  const lines = [
    "Filename policy failed: repo-owned source/support filenames must be kebab-case.",
    "",
    ...violations.map(({ expectedPath, path }) => `- ${path} -> ${expectedPath}`),
  ];

  return lines.join("\n");
};
