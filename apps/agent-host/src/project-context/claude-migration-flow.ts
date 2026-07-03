/**
 * Responsible for: orchestrating one CLAUDE.md migration round - discover, filter permanently-ignored
 * files, raise a required-response proposal, and only then apply the recorded per-file decisions
 * (M5 / D-005 / D-010). The blocking `ask` is injected as an Effect, so the flow never writes a file
 * before the user's answer resolves, interruption propagates into the pending question's cleanup, and
 * the discovery walk + apply step run inside Effect frames (never at Effect construction time). The
 * `migrate_claude_md` tool (tools/migrate-claude.ts) is the one production caller and supplies the real
 * provider-question runtime as the asker.
 * Not for: proposal shaping (claude-migration-proposal.ts), file mutation (claude-migration-writer.ts),
 * or discovery (claude-migration.ts) - this module composes those pure pieces and owns nothing else.
 */
import { resolve } from "node:path";
import { msg } from "@host/transport/messages";
import type { ProviderQuestionAnswer, ProviderQuestionContract } from "@trevor/session";
import { Effect } from "effect";
import { type ClaudeMigrationItem, discoverClaudeMigrations } from "./claude-migration";
import { addPermanentlyIgnored, loadPermanentlyIgnored } from "./claude-migration-ignores";
import {
  buildMigrationProposalContract,
  type MigrationDecision,
  resolveMigrationDecisions,
} from "./claude-migration-proposal";
import { applyMigrationDecision, type MigrationOutcome } from "./claude-migration-writer";

/** The blocking proposal presenter: raises the contract and resolves with the user's answer. */
export type MigrationAsker<E = never> = (
  contract: ProviderQuestionContract,
) => Effect.Effect<ProviderQuestionAnswer, E>;

export interface ClaudeMigrationFlowOptions {
  /** Override the durable ignore-store path (tests); defaults to the storage-inventory location. */
  readonly ignoresFile?: string;
}

export interface ClaudeMigrationFlowResult {
  /** `no-migrations` when nothing was proposed; `answered`/`declined` per the user's response. */
  readonly status: "no-migrations" | "answered" | "declined";
  readonly decisions: readonly MigrationDecision[];
  readonly outcomes: readonly MigrationOutcome[];
  /** A bounded human-readable recap for the tool result / command output. */
  readonly summary: string;
}

/** A recap line per outcome, e.g. "created AGENTS.md from CLAUDE.md". */
function outcomeLine(outcome: MigrationOutcome): string {
  switch (outcome.kind) {
    case "created":
      return `created ${outcome.agentsPath} from ${outcome.claudePath} (CLAUDE.md rewritten to a pointer)`;
    case "merged":
      return `merged ${outcome.claudePath} into ${outcome.agentsPath} (CLAUDE.md rewritten to a pointer)`;
    case "ignored-permanent":
      return `permanently ignoring ${outcome.claudePath}`;
    case "ignored-once":
      return `skipped ${outcome.claudePath} for now`;
    case "skipped":
      return `skipped ${outcome.claudePath} - ${outcome.note ?? "already migrated"}`;
    case "failed":
      return `FAILED ${outcome.claudePath} - ${outcome.note ?? "unknown error"} (file left as-is)`;
    default:
      return `left ${outcome.claudePath} unchanged`;
  }
}

/** The pending migration items for `cwd` after dropping permanently-ignored files. */
interface PendingMigrations {
  /** The resolved absolute project root the decisions apply against. */
  readonly root: string;
  /** The non-pointer, non-ignored files that still warrant a proposal. */
  readonly pending: readonly ClaudeMigrationItem[];
}

/** The pure pre-step: discover root + nested CLAUDE.md files needing a proposal (non-pointer) and
 *  drop any recorded as permanently ignored. Read-only. */
function collectPendingMigrations(cwd: string, ignoresFile?: string): PendingMigrations {
  const root = resolve(cwd);
  const ignored = loadPermanentlyIgnored(root, ignoresFile);
  const pending = discoverClaudeMigrations(root).proposalItems.filter(
    (item) => !ignored.has(item.claudePath),
  );
  return { root, pending };
}

/**
 * The post-step: map the user's answer to explicit per-file decisions and apply them - the ONLY place
 * a file is written, always after the answer. Failures are contained PER FILE: a decision whose apply
 * throws becomes a `failed` outcome (path + reason) and the remaining files still get their explicit
 * action, so one bad file never aborts or hides the rest. Ignore-permanent decisions persist
 * incrementally as each is applied, so an earlier ignore survives a later file's failure.
 */
function applyMigrationAnswer(
  root: string,
  pending: readonly ClaudeMigrationItem[],
  answer: ProviderQuestionAnswer,
  ignoresFile?: string,
): ClaudeMigrationFlowResult {
  const decisions = resolveMigrationDecisions(pending, answer);
  const outcomes = decisions.map((decision): MigrationOutcome => {
    try {
      const outcome = applyMigrationDecision(root, decision);
      if (outcome.kind === "ignored-permanent") {
        addPermanentlyIgnored(root, [decision.claudePath], ignoresFile);
      }
      return outcome;
    } catch (error) {
      return {
        claudePath: decision.claudePath,
        agentsPath: decision.agentsPath,
        action: decision.action,
        kind: "failed",
        pointerWritten: false,
        bytesWritten: 0,
        note: msg(error),
      };
    }
  });

  const status = answer.action === "accept" ? "answered" : "declined";
  const summary =
    status === "declined"
      ? "Migration declined; no CLAUDE.md files were changed."
      : `CLAUDE.md migration: ${outcomes.map(outcomeLine).join("; ")}.`;
  return { status, decisions, outcomes, summary };
}

/**
 * Run one migration round for `cwd`. Discovers root + nested CLAUDE.md files needing a proposal
 * (non-pointer), drops any recorded as permanently ignored, and returns early - WITHOUT asking - when
 * none remain. Otherwise it raises the proposal (suspending on `ask`), maps the answer to explicit
 * per-file decisions, applies them with per-file failure containment (writes happen only here, after
 * the answer), and records newly permanently-ignored files so a later run does not re-propose them.
 */
export function runClaudeMigrationFlow<E = never>(
  cwd: string,
  ask: MigrationAsker<E>,
  opts: ClaudeMigrationFlowOptions = {},
): Effect.Effect<ClaudeMigrationFlowResult, E> {
  return Effect.sync(() => collectPendingMigrations(cwd, opts.ignoresFile)).pipe(
    Effect.flatMap(({ root, pending }) =>
      pending.length === 0
        ? Effect.succeed<ClaudeMigrationFlowResult>({
            status: "no-migrations",
            decisions: [],
            outcomes: [],
            summary: "No CLAUDE.md files need migration.",
          })
        : ask(buildMigrationProposalContract(pending)).pipe(
            Effect.flatMap((answer) =>
              Effect.sync(() => applyMigrationAnswer(root, pending, answer, opts.ignoresFile)),
            ),
          ),
    ),
  );
}
