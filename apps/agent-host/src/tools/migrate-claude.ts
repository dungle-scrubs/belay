import {
  applyMigrationAnswer,
  collectPendingMigrations,
} from "@host/project-context/claude-migration-flow";
import { buildMigrationProposalContract } from "@host/project-context/claude-migration-proposal";
import { Effect, Schema } from "effect";
import { providerQuestionRuntime } from "../agent/provider-questions";
import type { Tool, ToolContext } from "./types";

/**
 * `migrate_claude_md`: the required-response CLAUDE.md -> AGENTS.md migration (plan 26, D-005/D-010).
 * It discovers root + nested CLAUDE.md files that still need a decision, raises ONE grouped proposal
 * through the shared provider-question runtime (the same block/answer path `ask_user` uses, so the
 * turn suspends until the user answers and interruption cleans the pending question up), and only THEN
 * applies each file's explicit action - create, merge, leave, or ignore. Nothing is written before the
 * answer; proposal shaping and file mutation stay in project-context, this tool is only the wiring.
 *
 * Responsible for: exposing the migration flow as a model-callable tool over the real runtime + cwd.
 * Not for: the proposal/decision/mutation logic - project-context/claude-migration-*.ts own those.
 */

// A no-arg tool: an EMPTY object params schema. The explicit `jsonSchema` annotation is load-bearing -
// a bare `Schema.Struct({})` emits an `anyOf` carrying a relative `$id` URL that OpenAI-compatible
// providers reject (see tools/doctor.ts for the same guard).
const Params = Schema.Struct({}).annotations({
  jsonSchema: { type: "object", properties: {}, additionalProperties: false },
});

type MigrateParams = typeof Params.Type;

const DESCRIPTION =
  "Detect legacy CLAUDE.md files in this workspace and propose migrating each to a sibling AGENTS.md. " +
  "Call this when the project context reports CLAUDE.md files that need migration, BEFORE doing other " +
  "work. It blocks on an explicit user decision per file (create AGENTS.md, merge into an existing " +
  "AGENTS.md, leave unchanged, or ignore) and never edits a file without that response.";

export const migrateClaudeTool: Tool<MigrateParams> = {
  name: "migrate_claude_md",
  description: DESCRIPTION,
  // Not readOnly: it blocks the turn for a user decision and then mutates files (a serial barrier).
  params: Params,
  execute: (_args: MigrateParams, ctx?: ToolContext) => {
    const { root, pending } = collectPendingMigrations(process.cwd());
    if (pending.length === 0) {
      return Effect.succeed("No CLAUDE.md files need migration.");
    }
    return providerQuestionRuntime
      .askForAnswer(
        buildMigrationProposalContract(pending),
        ctx?.runId ?? "",
        ctx?.callId ?? "",
        "migrate_claude_md",
        "claude_migration",
      )
      .pipe(Effect.map((answer) => applyMigrationAnswer(root, pending, answer).summary));
  },
};
