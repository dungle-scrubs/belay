/**
 * Responsible for: frontmatter + directory-listing primitives for skill/subagent manifests.
 */
import { readdirSync } from "node:fs";
import { parse as parseYaml } from "yaml";

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

export function parseFrontmatter(text: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const match = text.match(FRONTMATTER);

  if (!match) {
    return { data: {}, body: text };
  }

  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(match[1] ?? "");
    if (parsed && typeof parsed === "object") {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }

  return { data, body: text.slice(match[0].length) };
}

export const trimStr = (value: unknown): string | undefined =>
  typeof value === "string" ? value.trim() : undefined;

export function strList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((v): v is string => typeof v === "string").map((v) => v.trim());
}

export function sortedVisibleEntries(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((entry) => !entry.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}
