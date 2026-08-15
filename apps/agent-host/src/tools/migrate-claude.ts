import { PROVIDER_QUESTION_ADAPTERS } from "@belay/session";
import { runClaudeMigrationFlow } from "@host/project-context/claude-migration-flow";
import { Effect, Schema } from "effect";
import { providerQuestionRuntime } from "../agent/provider-questions";
import type { Tool, ToolContext } from "./types";

/**
 * `migrate_claude_md`: the required-response CLAUDE.md -> AGENTS.md migration (plan 26, D-005/D-010).
 * A thin wiring layer: it hands `runClaudeMigrationFlow` (the ONE orchestration, shared with its
 * tests) the real cwd and the provider-question runtime as the blocking asker - the same block/answer
 * path `ask_user` uses, so the turn suspends until the user answers and interruption cleans the
 * pending question up. Everything is built lazily (Effect.suspend + the flow's own Effect.sync
 * frames), so constructing the tool call never walks the workspace or blocks dispatch.
 *
 * Responsible for: exposing the migration flow as a model-callable tool over the real runtime + cwd.
 * Not for: orchestration or the proposal/decision/mutation logic - project-context owns those.
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
  execute: (_args: MigrateParams, ctx?: ToolContext) =>
    Effect.suspend(() =>
      runClaudeMigrationFlow(process.cwd(), (contract) =>
        providerQuestionRuntime.askForAnswer(contract, ctx?.runId ?? "", ctx?.callId ?? "", {
          toolName: "migrate_claude_md",
          adapter: PROVIDER_QUESTION_ADAPTERS.claudeMigration,
        }),
      ),
    ).pipe(Effect.map((result) => result.summary)),
};
