/**
 * Responsible for: the CLAUDE.md -> AGENTS.md file mutations - create, merge, and the pointer rewrite
 * (M6 / D-011). Every operation is explicit, atomic (the shared temp-write + rename), and idempotent,
 * and NONE of them runs unless the caller passes a decision that already carries the user's recorded
 * response.
 * Not for: deciding WHAT to do (claude-migration-proposal.ts) or WHEN (claude-migration-flow.ts).
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "@host/io/atomic-write";
import { CLAUDE_POINTER_SENTINEL, isClaudePointer } from "./claude-migration";
import type { MigrationActionKind, MigrationDecision } from "./claude-migration-proposal";

/** How an applied decision resolved on disk. `failed` is produced by the flow's per-file containment
 *  (claude-migration-flow.ts) when applying one decision threw; the writer itself only throws. */
export type MigrationOutcomeKind =
  | "created"
  | "merged"
  | "left"
  | "ignored-once"
  | "ignored-permanent"
  | "skipped"
  | "failed";

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

/** The pointer body left in place of a converted CLAUDE.md. Carries the sentinel `isClaudePointer`
 *  matches exactly, so detection never relies on fuzzy prose matching (idempotent re-discovery). */
function pointerBody(agentsPath: string): string {
  return (
    `# CLAUDE.md\n\n${CLAUDE_POINTER_SENTINEL}\n\n` +
    `This file has moved. Trevor uses \`${agentsPath}\` as the source of truth for agent ` +
    `instructions; see that file. This pointer is safe to leave in place.\n`
  );
}

/**
 * The migrated content, framed by stable markers (D-011). BOTH create and merge stamp these same
 * markers, so a rerun after a partially-applied conversion (AGENTS.md written, pointer write failed)
 * uniformly recognizes already-migrated content and skips instead of appending the body twice.
 */
function migratedSection(claudePath: string, body: string): string {
  return `${MERGE_BEGIN}\n## Migrated from ${claudePath}\n\n${body.trim()}\n${MERGE_END}`;
}

function readText(absPath: string): string {
  return readFileSync(absPath, "utf8");
}

/**
 * Apply one recorded decision. `create`/`merge` write the sibling AGENTS.md and then rewrite the
 * CLAUDE.md into a pointer; the AGENTS.md write happens first and is ROLLED BACK if the pointer write
 * throws (create removes the new file, merge restores the previous content), so a failure never leaves
 * a half-converted pair behind. `leave`/`ignore-*` never touch the filesystem. Re-running a conversion
 * whose CLAUDE.md is already a pointer, or whose AGENTS.md already carries the migrated-section
 * markers, is a no-op (`skipped`).
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
        // A sibling appeared since discovery (or a prior run wrote it before its pointer write
        // failed); do not clobber it. Fall through to a merge, whose marker check keeps this
        // idempotent.
        return applyMigrationDecision(root, { ...decision, action: "merge" });
      }
      const content = `${provenanceHeader(decision.claudePath)}\n\n${migratedSection(decision.claudePath, body)}\n`;
      const bytes = writeFileAtomic(agentsAbs, content);
      try {
        writeFileAtomic(claudeAbs, pointerBody(decision.agentsPath));
      } catch (error) {
        // Roll the create back so a rerun starts from the original state (no half-converted pair).
        rmSync(agentsAbs, { force: true });
        throw error;
      }
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
        // The content already landed (an earlier conversion whose pointer write failed, or a plain
        // re-run). Never append the body twice; instead COMPLETE the interrupted conversion by
        // finishing the pointer rewrite - the user explicitly chose this file's migration, and
        // without the pointer the file would be re-proposed forever.
        writeFileAtomic(claudeAbs, pointerBody(decision.agentsPath));
        return {
          ...inert("skipped"),
          pointerWritten: true,
          note: "AGENTS.md already contains a migrated section; completed the pointer rewrite.",
        };
      }
      const content = `${existing.trimEnd()}\n\n${migratedSection(decision.claudePath, body)}\n`;
      const bytes = writeFileAtomic(agentsAbs, content);
      try {
        writeFileAtomic(claudeAbs, pointerBody(decision.agentsPath));
      } catch (error) {
        // Restore the pre-merge AGENTS.md so a rerun starts from the original state.
        writeFileAtomic(agentsAbs, existing);
        throw error;
      }
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
