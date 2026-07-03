/**
 * Responsible for: the CLAUDE.md -> AGENTS.md file mutations - create, merge, and the pointer rewrite
 * (M6 / D-011). Every operation is explicit, atomic (temp-write + rename), and idempotent, and NONE of
 * them runs unless the caller passes a decision that already carries the user's recorded response.
 * Not for: deciding WHAT to do (claude-migration-proposal.ts) or WHEN (claude-migration-flow.ts).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isClaudePointer } from "./claude-migration";
import type { MigrationActionKind, MigrationDecision } from "./claude-migration-proposal";

/** How an applied decision resolved on disk. */
export type MigrationOutcomeKind =
  | "created"
  | "merged"
  | "left"
  | "ignored-once"
  | "ignored-permanent"
  | "skipped";

/** The result of applying one decision: what happened, whether a pointer was written, and byte cost. */
export interface MigrationOutcome {
  readonly claudePath: string;
  readonly agentsPath: string;
  readonly action: MigrationActionKind;
  readonly kind: MigrationOutcomeKind;
  readonly pointerWritten: boolean;
  readonly bytesWritten: number;
  readonly note?: string;
}

const MERGE_BEGIN = "<!-- BEGIN migrated from CLAUDE.md (Trevor) -->";
const MERGE_END = "<!-- END migrated from CLAUDE.md (Trevor) -->";

/** The provenance header stamped atop a created AGENTS.md so the origin is auditable (D-011). */
function provenanceHeader(claudePath: string): string {
  return `<!-- Migrated from ${claudePath} by Trevor. Original content preserved in git history. -->`;
}

/** The pointer body left in place of a converted CLAUDE.md. Recognized by `isPointer` (idempotent). */
function pointerBody(agentsPath: string): string {
  return (
    `# CLAUDE.md\n\n` +
    `This file has moved. Trevor uses \`${agentsPath}\` as the source of truth for agent ` +
    `instructions; see that file. This pointer is safe to leave in place.\n`
  );
}

/** The migrated section appended into an existing AGENTS.md, framed by stable markers (D-011). */
function migratedSection(claudePath: string, body: string): string {
  return `${MERGE_BEGIN}\n## Migrated from ${claudePath}\n\n${body.trim()}\n${MERGE_END}`;
}

/** Atomic write: stage to a sibling temp file, then rename over the target. Returns bytes written. */
function atomicWrite(absPath: string, content: string): number {
  const tmp = `${absPath}.trevor-tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, absPath);
  return Buffer.byteLength(content);
}

function readText(absPath: string): string {
  return readFileSync(absPath, "utf8");
}

/**
 * Apply one recorded decision. `create`/`merge` write the sibling AGENTS.md and then rewrite the
 * CLAUDE.md into a pointer; the AGENTS.md write happens first, so a failure there leaves the CLAUDE.md
 * untouched (rollback-safe ordering). `leave`/`ignore-*` never touch the filesystem. Re-running a
 * conversion whose AGENTS.md already carries the migrated section is a no-op (`skipped`).
 */
export function applyMigrationDecision(
  root: string,
  decision: MigrationDecision,
): MigrationOutcome {
  const base = resolve(root);
  const claudeAbs = join(base, decision.claudePath);
  const agentsAbs = join(base, decision.agentsPath);
  const inert = (kind: MigrationOutcomeKind): MigrationOutcome => ({
    claudePath: decision.claudePath,
    agentsPath: decision.agentsPath,
    action: decision.action,
    kind,
    pointerWritten: false,
    bytesWritten: 0,
  });

  switch (decision.action) {
    case "leave":
      return inert("left");
    case "ignore-once":
      return inert("ignored-once");
    case "ignore-permanent":
      return inert("ignored-permanent");
    case "create": {
      const body = readText(claudeAbs);
      if (isClaudePointer(body)) {
        // Already converted (a re-run over a pointer); do nothing rather than re-ingest the pointer.
        return { ...inert("skipped"), note: "CLAUDE.md is already a pointer to AGENTS.md." };
      }
      if (existsSync(agentsAbs)) {
        // A sibling appeared since discovery; do not clobber it. Fall through to a merge instead.
        return applyMigrationDecision(root, { ...decision, action: "merge" });
      }
      const content = `${provenanceHeader(decision.claudePath)}\n\n${body.trim()}\n`;
      const bytes = atomicWrite(agentsAbs, content);
      atomicWrite(claudeAbs, pointerBody(decision.agentsPath));
      return {
        ...inert("created"),
        kind: "created",
        pointerWritten: true,
        bytesWritten: bytes,
      };
    }
    case "merge": {
      const body = readText(claudeAbs);
      if (isClaudePointer(body)) {
        return { ...inert("skipped"), note: "CLAUDE.md is already a pointer to AGENTS.md." };
      }
      if (!existsSync(agentsAbs)) {
        // Nothing to merge into; create it instead so no content is lost.
        return applyMigrationDecision(root, { ...decision, action: "create" });
      }
      const existing = readText(agentsAbs);
      if (existing.includes(MERGE_BEGIN)) {
        return {
          ...inert("skipped"),
          note: "AGENTS.md already contains a migrated section for this file.",
        };
      }
      const content = `${existing.trimEnd()}\n\n${migratedSection(decision.claudePath, body)}\n`;
      const bytes = atomicWrite(agentsAbs, content);
      atomicWrite(claudeAbs, pointerBody(decision.agentsPath));
      return {
        ...inert("merged"),
        kind: "merged",
        pointerWritten: true,
        bytesWritten: bytes,
      };
    }
    default: {
      // Exhaustiveness guard: an unknown action is treated as leave-unchanged (never writes).
      return inert("left");
    }
  }
}
