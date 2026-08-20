/**
 * Responsible for: the /init proposal - collecting repo evidence and drafting a root AGENTS.md.
 * Not for: CLAUDE.md migration inventory - claude-migration.ts owns that.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { AGENTS_FILE } from "./agents-md";
import { RuleCollector } from "./rules";
import { walkContextTree } from "./walk";

export interface InitEvidence {
  readonly claudeFiles: readonly string[];
  readonly docs: readonly string[];
  readonly existingAgents: readonly string[];
  readonly packageScripts: Readonly<Record<string, string>>;
  readonly packageJson: string | undefined;
  readonly rules: readonly string[];
  readonly testConfigs: readonly string[];
}

export interface InitProposal {
  readonly action: "create" | "merge" | "noop";
  readonly diff: readonly string[];
  readonly draft: string;
  readonly evidence: InitEvidence;
  readonly nestedScopedAgents: readonly string[];
  readonly preview: string;
}

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function readPackageScripts(root: string): {
  readonly packageJson: string | undefined;
  readonly scripts: Readonly<Record<string, string>>;
} {
  const path = join(root, "package.json");
  const raw = safeRead(path);
  if (raw === undefined) {
    return { packageJson: undefined, scripts: {} };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || !("scripts" in parsed)) {
      return { packageJson: path, scripts: {} };
    }
    const scripts = (parsed as { readonly scripts?: unknown }).scripts;
    if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
      return { packageJson: path, scripts: {} };
    }
    return {
      packageJson: path,
      scripts: Object.fromEntries(
        Object.entries(scripts).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    };
  } catch {
    return { packageJson: path, scripts: {} };
  }
}

function relativeList(root: string, paths: readonly string[]): readonly string[] {
  return paths.map((path) => relative(root, path)).sort();
}

export function collectInitEvidence(cwd: string): InitEvidence {
  const root = resolve(cwd);
  const files = walkContextTree(root);
  const packageInfo = readPackageScripts(root);
  const docs = files.filter((path) => {
    const name = basename(path).toLowerCase();
    return name === "readme.md" || (name.endsWith(".md") && path.includes(`${root}/docs/`));
  });
  const testConfigs = files.filter((path) =>
    /(?:vitest|playwright|jest|cypress|tsconfig)\.config\./u.test(basename(path)),
  );
  const existingAgents = files.filter((path) => basename(path) === AGENTS_FILE);
  const claudeFiles = files.filter((path) => basename(path) === "CLAUDE.md");
  const rules = new RuleCollector(root).rules.map((rule) => rule.path);
  return {
    claudeFiles: relativeList(root, claudeFiles),
    docs: relativeList(root, docs).slice(0, 12),
    existingAgents: relativeList(root, existingAgents),
    packageJson:
      packageInfo.packageJson === undefined ? undefined : relative(root, packageInfo.packageJson),
    packageScripts: packageInfo.scripts,
    rules: relativeList(root, rules),
    testConfigs: relativeList(root, testConfigs),
  };
}

function commandLine(script: string): string {
  return `pnpm ${script}`;
}

export function buildAgentsDraft(evidence: InitEvidence): string {
  const lines = [
    "# AGENTS.md",
    "",
    "## Project Map",
    evidence.packageJson
      ? `- Package metadata: \`${evidence.packageJson}\``
      : "- Package metadata: not detected.",
    evidence.docs.length > 0
      ? `- Start with: ${evidence.docs.map((doc) => `\`${doc}\``).join(", ")}`
      : "- Start with repository source files; no README/docs were detected.",
    evidence.existingAgents.length > 0
      ? `- Existing scoped instructions: ${evidence.existingAgents.map((file) => `\`${file}\``).join(", ")}`
      : "- Existing scoped instructions: none detected.",
    evidence.rules.length > 0
      ? `- Belay rules: ${evidence.rules.map((file) => `\`${file}\``).join(", ")}`
      : "- Belay rules: none detected.",
    "",
    "## Commands",
  ];
  for (const script of [
    "lint",
    "typecheck",
    "test",
    "test:unit",
    "test:integration",
    "test:web",
    "test:e2e",
  ]) {
    if (evidence.packageScripts[script] !== undefined) {
      lines.push(`- \`${commandLine(script)}\` - ${evidence.packageScripts[script]}`);
    }
  }
  if (lines.at(-1) === "## Commands") {
    lines.push("- Add project build, lint, typecheck, and test commands after verifying them.");
  }
  lines.push("", "## Operating Rules");
  lines.push("- Prefer exact repository commands and existing docs over invented conventions.");
  lines.push("- Keep changes scoped to the requested task and update tests with behavior changes.");
  if (evidence.testConfigs.length > 0) {
    lines.push(
      `- Test configuration: ${evidence.testConfigs.map((file) => `\`${file}\``).join(", ")}`,
    );
  }
  if (evidence.claudeFiles.length > 0) {
    lines.push(
      `- CLAUDE.md migration candidates: ${evidence.claudeFiles.map((file) => `\`${file}\``).join(", ")}`,
    );
  }
  lines.push("", "## Review Expectations");
  lines.push("- Report commands run and any commands that could not be run.");
  lines.push("- Do not edit generated files or changelogs unless the task explicitly says to.");
  return `${lines.join("\n")}\n`;
}

export function buildInitProposal(cwd: string): InitProposal {
  const root = resolve(cwd);
  const evidence = collectInitEvidence(root);
  const rootAgents = join(root, AGENTS_FILE);
  const draftEvidence: InitEvidence = {
    ...evidence,
    existingAgents: evidence.existingAgents.filter((file) => file !== AGENTS_FILE),
  };
  const draft = buildAgentsDraft(draftEvidence);
  const existing = safeRead(rootAgents);
  const action =
    existing === undefined ? "create" : existing.trim() === draft.trim() ? "noop" : "merge";
  const nestedScopedAgents = evidence.claudeFiles
    .filter((file) => dirname(file) !== ".")
    .map((file) => join(dirname(file), AGENTS_FILE));
  const diff =
    action === "noop"
      ? ["No AGENTS.md changes proposed."]
      : [
          `${action === "create" ? "Create" : "Refresh"} ${AGENTS_FILE}.`,
          ...nestedScopedAgents.map((file) => `Propose scoped ${file}.`),
        ];
  const boundedDraft = draft.trim().slice(0, 4_000);
  return {
    action,
    diff,
    draft,
    evidence,
    nestedScopedAgents,
    preview: [
      `/init proposal: ${action} ${AGENTS_FILE}`,
      nestedScopedAgents.length > 0
        ? `Nested scoped AGENTS.md candidates: ${nestedScopedAgents.map((file) => `\`${file}\``).join(", ")}`
        : "Nested scoped AGENTS.md candidates: none",
      "",
      "Structured diff:",
      ...diff.map((line) => `- ${line}`),
      "",
      "No files were written. Review is required before applying this proposal.",
      "",
      "```markdown",
      boundedDraft,
      boundedDraft.length < draft.trim().length ? "...[truncated]" : "",
      "```",
    ].join("\n"),
  };
}
