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

/**
 * The sentinel line every Trevor-written pointer CLAUDE.md carries. Detection matches EXACTLY this
 * marker - a fuzzy phrase match ("see AGENTS.md", "reuse the AGENTS.md patterns") false-positives on
 * real instruction bodies and would silently exclude them from migration.
 */
export const CLAUDE_POINTER_SENTINEL = "<!-- trevor:claude-md-pointer -->";

/**
 * Whether a CLAUDE.md body is an already-converted pointer to its sibling AGENTS.md (D-011): it
 * carries the {@link CLAUDE_POINTER_SENTINEL} the pointer rewrite stamps, so re-discovery recognizes
 * it and does not re-propose the file. Exported so the writer can short-circuit a redundant
 * conversion idempotently.
 */
export function isClaudePointer(body: string): boolean {
  return body.includes(CLAUDE_POINTER_SENTINEL);
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
      const pointer = isClaudePointer(body);
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
