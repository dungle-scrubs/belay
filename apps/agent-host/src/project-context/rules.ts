/**
 * Responsible for: .belay/rules collection - frontmatter + folder metadata, globs, inclusion.
 * Not for: AGENTS.md ingestion or per-session lazy state - agents-md.ts / registry.ts own those.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { collectMarkdownFiles } from "@host/boot/manifest-discovery";
import { parse as parseYaml } from "yaml";
import { type ContextRuleSource, type ContextScope, expandContextImports } from "./agents-md";
import { CONTEXT_SOURCE_KINDS, type ContextSource, type ContextSourceDiagnostic } from "./sources";

export const RULES_DIR = join(".belay", "rules");
export const RULE_FOLDER_METADATA_FILES = ["metadata.yaml", "metadata.yml"] as const;

export const RULE_INCLUSION_MODES = {
  always: "always",
  scoped: "scoped",
} as const;

export type RuleInclusionMode = (typeof RULE_INCLUSION_MODES)[keyof typeof RULE_INCLUSION_MODES];

export interface RuleMetadata {
  readonly description: string | undefined;
  readonly enabled: boolean;
  readonly globs: readonly string[];
  readonly id: string | undefined;
  readonly inclusion: RuleInclusionMode;
  readonly priority: number;
  readonly title: string | undefined;
}

export interface RuleFolderMetadata {
  readonly description: string | undefined;
  readonly enabled: boolean;
  readonly globs: readonly string[];
  readonly path: string;
  readonly priority: number;
  readonly title: string | undefined;
}

export interface BelayRuleSource extends ContextSource<RuleMetadata> {
  readonly folder: RuleFolderMetadata | undefined;
  readonly inclusionReason: "always" | "file-access";
  readonly metadata: RuleMetadata;
}

export interface RulesReport {
  readonly diagnostics: readonly ContextSourceDiagnostic[];
  readonly rules: readonly BelayRuleSource[];
}

interface ParsedFrontmatter {
  readonly body: string;
  readonly diagnostics: readonly ContextSourceDiagnostic[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

const DEFAULT_RULE_METADATA: RuleMetadata = {
  description: undefined,
  enabled: true,
  globs: [],
  id: undefined,
  inclusion: "always",
  priority: 0,
  title: undefined,
};

function diagnostic(
  code: string,
  message: string,
  path: string,
  severity: ContextSourceDiagnostic["severity"] = "warn",
): ContextSourceDiagnostic {
  return { code, message, path, severity };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseInclusion(value: unknown): RuleInclusionMode {
  return value === "scoped" ? "scoped" : "always";
}

function parseFrontmatter(path: string, raw: string): ParsedFrontmatter {
  if (!raw.startsWith("---\n")) {
    return { body: expandContextImports(raw, dirname(path), path), diagnostics: [], metadata: {} };
  }
  const end = raw.indexOf("\n---", 4);
  if (end === -1) {
    return {
      body: raw.trim(),
      diagnostics: [diagnostic("invalid_frontmatter", "Frontmatter is not closed.", path)],
      metadata: {},
    };
  }
  const yaml = raw.slice(4, end);
  const body = raw.slice(end + 4).trim();
  try {
    const parsed = parseYaml(yaml);
    if (!isRecord(parsed)) {
      return {
        body: expandContextImports(body, dirname(path), path),
        diagnostics: [diagnostic("invalid_frontmatter", "Frontmatter must be a mapping.", path)],
        metadata: {},
      };
    }
    return {
      body: expandContextImports(body, dirname(path), path),
      diagnostics: [],
      metadata: parsed,
    };
  } catch (error) {
    return {
      body: expandContextImports(body, dirname(path), path),
      diagnostics: [
        diagnostic(
          "invalid_frontmatter",
          error instanceof Error ? error.message : "Frontmatter could not be parsed.",
          path,
        ),
      ],
      metadata: {},
    };
  }
}

function metadataFromRecord(
  metadata: Readonly<Record<string, unknown>>,
  path: string,
): { readonly diagnostics: readonly ContextSourceDiagnostic[]; readonly metadata: RuleMetadata } {
  const diagnostics: ContextSourceDiagnostic[] = [];
  for (const key of Object.keys(metadata)) {
    if (
      !["description", "enabled", "globs", "id", "inclusion", "priority", "title"].includes(key)
    ) {
      diagnostics.push(
        diagnostic("unknown_metadata", `Unknown rule metadata field: ${key}.`, path),
      );
    }
  }
  if (
    metadata.inclusion !== undefined &&
    metadata.inclusion !== "always" &&
    metadata.inclusion !== "scoped"
  ) {
    diagnostics.push(
      diagnostic("invalid_inclusion", "Rule inclusion must be always or scoped.", path),
    );
  }
  return {
    diagnostics,
    metadata: {
      description: optionalString(metadata.description),
      enabled: parseBoolean(metadata.enabled, DEFAULT_RULE_METADATA.enabled),
      globs: stringArray(metadata.globs),
      id: optionalString(metadata.id),
      inclusion: parseInclusion(metadata.inclusion),
      priority: parseNumber(metadata.priority, DEFAULT_RULE_METADATA.priority),
      title: optionalString(metadata.title),
    },
  };
}

function folderMetadataFromRecord(
  metadata: Readonly<Record<string, unknown>>,
  path: string,
): {
  readonly diagnostics: readonly ContextSourceDiagnostic[];
  readonly metadata: RuleFolderMetadata;
} {
  const diagnostics: ContextSourceDiagnostic[] = [];
  for (const key of Object.keys(metadata)) {
    if (!["description", "enabled", "globs", "priority", "title"].includes(key)) {
      diagnostics.push(
        diagnostic("unknown_folder_metadata", `Unknown folder metadata field: ${key}.`, path),
      );
    }
  }
  return {
    diagnostics,
    metadata: {
      description: optionalString(metadata.description),
      enabled: parseBoolean(metadata.enabled, true),
      globs: stringArray(metadata.globs),
      path,
      priority: parseNumber(metadata.priority, 0),
      title: optionalString(metadata.title),
    },
  };
}

function readFolderMetadata(dir: string): {
  readonly diagnostics: readonly ContextSourceDiagnostic[];
  readonly metadata: RuleFolderMetadata | undefined;
} {
  for (const file of RULE_FOLDER_METADATA_FILES) {
    const path = join(dir, file);
    if (!existsSync(path)) {
      continue;
    }
    const parsed = parseFrontmatter(path, readFileSync(path, "utf8"));
    const record =
      Object.keys(parsed.metadata).length > 0
        ? parsed.metadata
        : parseFolderMetadataBody(path, parsed.body);
    const folder = folderMetadataFromRecord(record, path);
    return {
      diagnostics: [...parsed.diagnostics, ...folder.diagnostics],
      metadata: folder.metadata,
    };
  }
  return { diagnostics: [], metadata: undefined };
}

function parseFolderMetadataBody(path: string, body: string): Readonly<Record<string, unknown>> {
  try {
    const parsed = parseYaml(body);
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    return {
      _diagnostic: error instanceof Error ? error.message : `Could not parse ${path}`,
    };
  }
}

function nearestFolderMetadata(
  path: string,
  root: string,
  cache: Map<
    string,
    { diagnostics: readonly ContextSourceDiagnostic[]; metadata: RuleFolderMetadata | undefined }
  >,
): {
  readonly diagnostics: readonly ContextSourceDiagnostic[];
  readonly metadata: RuleFolderMetadata | undefined;
} {
  let dir = dirname(path);
  while (dir.startsWith(root)) {
    const cached = cache.get(dir);
    const value = cached ?? readFolderMetadata(dir);
    cache.set(dir, value);
    if (value.metadata !== undefined) {
      return value;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return { diagnostics: [], metadata: undefined };
}

function mergeMetadata(rule: RuleMetadata, folder: RuleFolderMetadata | undefined): RuleMetadata {
  if (folder === undefined) {
    return rule;
  }
  return {
    description: rule.description,
    enabled: folder.enabled && rule.enabled,
    globs: rule.globs.length > 0 ? rule.globs : folder.globs,
    id: rule.id,
    inclusion: rule.inclusion,
    priority: rule.priority !== 0 ? rule.priority : folder.priority,
    title: rule.title,
  };
}

export function collectBelayRuleSources(cwd: string): RulesReport {
  const root = resolve(cwd, RULES_DIR);
  const folderCache = new Map<
    string,
    { diagnostics: readonly ContextSourceDiagnostic[]; metadata: RuleFolderMetadata | undefined }
  >();
  const diagnostics: ContextSourceDiagnostic[] = [];
  const rules: BelayRuleSource[] = [];
  const seenIds = new Map<string, string>();

  for (const path of collectMarkdownFiles(root)) {
    const parsed = parseFrontmatter(path, readFileSync(path, "utf8"));
    const rule = metadataFromRecord(parsed.metadata, path);
    const folder = nearestFolderMetadata(path, root, folderCache);
    const metadata = mergeMetadata(rule.metadata, folder.metadata);
    const sourceDiagnostics = [...parsed.diagnostics, ...rule.diagnostics, ...folder.diagnostics];
    if (metadata.id !== undefined) {
      const firstPath = seenIds.get(metadata.id);
      if (firstPath !== undefined) {
        sourceDiagnostics.push(
          diagnostic(
            "duplicate_rule_id",
            `Duplicate rule id "${metadata.id}" first seen at ${firstPath}.`,
            path,
          ),
        );
      } else {
        seenIds.set(metadata.id, path);
      }
    }
    if (!metadata.enabled) {
      diagnostics.push(
        ...sourceDiagnostics,
        diagnostic("disabled_rule", "Rule is disabled.", path, "info"),
      );
      continue;
    }
    const source: BelayRuleSource = {
      bytes: Buffer.byteLength(parsed.body),
      content: parsed.body,
      diagnostics: sourceDiagnostics,
      folder: folder.metadata,
      inclusionReason: metadata.inclusion === "always" ? "always" : "file-access",
      kind: CONTEXT_SOURCE_KINDS.belayRule,
      metadata,
      path,
      provenance: relative(cwd, path),
    };
    rules.push(source);
    diagnostics.push(...sourceDiagnostics);
  }

  return {
    diagnostics,
    rules: rules.sort(
      (a, b) => a.metadata.priority - b.metadata.priority || a.path.localeCompare(b.path),
    ),
  };
}

function globMatches(pattern: string, relativePath: string): boolean {
  if (pattern === relativePath || pattern === "**") {
    return true;
  }
  if (pattern.endsWith("/**")) {
    return relativePath.startsWith(pattern.slice(0, -2));
  }
  if (pattern.startsWith("**/*.")) {
    return relativePath.endsWith(pattern.slice(4));
  }
  return false;
}

export function ruleMatchesFile(rule: BelayRuleSource, absFile: string, cwd: string): boolean {
  const rel = relative(cwd, absFile);
  const globs = rule.metadata.globs.length > 0 ? rule.metadata.globs : (rule.folder?.globs ?? []);
  return globs.some((pattern) => globMatches(pattern, rel));
}

export function ruleToContextScope(
  rule: BelayRuleSource,
  scope: Extract<ContextScope["scope"], "belay-rule" | "below-cwd-rule">,
): ContextScope {
  return {
    bytes: rule.bytes,
    content: rule.content,
    path: rule.path,
    scope,
  };
}

export function ruleToReportSource(rule: BelayRuleSource): ContextRuleSource {
  return {
    bytes: rule.bytes,
    folder: rule.folder?.title,
    inclusionReason: rule.inclusionReason,
    metadata: rule.metadata,
    path: rule.path,
  };
}

/**
 * Facade for Belay rules at one cwd: collection, scoped-file matching, and the two transformations
 * registry needs (prompt scopes and report provenance). ContextRegistry owns instances of this class
 * instead of stitching collect/filter/map steps itself.
 */
export class RuleCollector {
  readonly diagnostics: readonly ContextSourceDiagnostic[];
  readonly rules: readonly BelayRuleSource[];

  constructor(private readonly cwd: string) {
    const report = collectBelayRuleSources(cwd);
    this.diagnostics = report.diagnostics;
    this.rules = report.rules;
  }

  alwaysRules(): readonly BelayRuleSource[] {
    return this.rules.filter((rule) => rule.metadata.inclusion === "always");
  }

  scopedRulesForFile(absFile: string): readonly BelayRuleSource[] {
    return this.rules.filter(
      (rule) => rule.metadata.inclusion === "scoped" && ruleMatchesFile(rule, absFile, this.cwd),
    );
  }

  contextScope(
    rule: BelayRuleSource,
    scope: Extract<ContextScope["scope"], "belay-rule" | "below-cwd-rule">,
  ): ContextScope {
    return ruleToContextScope(rule, scope);
  }

  reportSource(rule: BelayRuleSource): ContextRuleSource {
    return ruleToReportSource(rule);
  }
}

/** @deprecated Use BelayRuleSource */
export type TrevorRuleSource = BelayRuleSource;
/** @deprecated Use collectBelayRuleSources */
export const collectTrevorRuleSources = collectBelayRuleSources;
