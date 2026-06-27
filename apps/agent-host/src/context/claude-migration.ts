import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { AGENTS_FILE } from "./agents-md";

const CLAUDE_FILE = "CLAUDE.md";
const IGNORED_DIRS = new Set([
  ".git",
  ".trevor/generated",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

export interface ClaudeMigrationItem {
  readonly agentsPath: string;
  readonly claudePath: string;
  readonly needsProposal: boolean;
  readonly pointer: boolean;
  readonly preview: string;
  readonly siblingAgentsExists: boolean;
}

export interface ClaudeMigrationInventory {
  readonly items: readonly ClaudeMigrationItem[];
  readonly proposalItems: readonly ClaudeMigrationItem[];
}

function shouldIgnoreDir(root: string, dir: string): boolean {
  const rel = relative(root, dir);
  return rel.split("/").some((part) => IGNORED_DIRS.has(part));
}

function walk(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  const visit = (dir: string): void => {
    if (shouldIgnoreDir(root, dir)) {
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name === CLAUDE_FILE) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files.sort();
}

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function isPointer(body: string): boolean {
  return /AGENTS\.md/u.test(body) && /moved|see|use|source of truth|pointer/i.test(body);
}

function preview(body: string): string {
  const trimmed = body.trim().replace(/\s+/gu, " ");
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}...[truncated]` : trimmed;
}

export function discoverClaudeMigrations(cwd: string): ClaudeMigrationInventory {
  const root = resolve(cwd);
  const items = walk(root).map((path): ClaudeMigrationItem => {
    const body = read(path);
    const dir = dirname(path);
    const pointer = isPointer(body);
    return {
      agentsPath: relative(root, join(dir, AGENTS_FILE)),
      claudePath: relative(root, path),
      needsProposal: !pointer,
      pointer,
      preview: preview(body),
      siblingAgentsExists: existsSync(join(dir, AGENTS_FILE)),
    };
  });
  return {
    items,
    proposalItems: items.filter((item) => item.needsProposal),
  };
}

export function siblingAgentsPath(claudePath: string): string {
  return join(dirname(claudePath), AGENTS_FILE);
}
