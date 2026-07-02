/**
 * Responsible for: inventorying CLAUDE.md files (pointer vs needs-migration) for AGENTS.md moves.
 * Not for: writing any file - it reports; the /init proposal flow (init-agents.ts) drafts content.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { AGENTS_FILE } from "./agents-md";
import { walkContextTree } from "./walk";

const CLAUDE_FILE = "CLAUDE.md";

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
  const items = walkContextTree(root, (name) => name === CLAUDE_FILE).map(
    (path): ClaudeMigrationItem => {
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
    },
  );
  return {
    items,
    proposalItems: items.filter((item) => item.needsProposal),
  };
}

export function siblingAgentsPath(claudePath: string): string {
  return join(dirname(claudePath), AGENTS_FILE);
}
