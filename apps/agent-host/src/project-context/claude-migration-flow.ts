/**
 * Responsible for: orchestrating one CLAUDE.md migration round - discover, filter permanently-ignored
 * files, raise a required-response proposal, and only then apply the recorded per-file decisions
 * (M5 / D-005 / D-010). The blocking `ask` is injected, so the flow never writes a file before the
 * user's answer resolves, and the tool wiring (tools/migrate-claude.ts) supplies the real
 * provider-question runtime.
 * Not for: proposal shaping (claude-migration-proposal.ts), file mutation (claude-migration-writer.ts),
 * or discovery (claude-migration.ts) - this module composes those pure pieces and owns nothing else.
 */
import { resolve } from "node:path";
import type { ProviderQuestionAnswer, ProviderQuestionContract } from "@trevor/session";
import { type ClaudeMigrationItem, discoverClaudeMigrations } from "./claude-migration";
import { addPermanentlyIgnored, loadPermanentlyIgnored } from "./claude-migration-ignores";
import {
  buildMigrationProposalContract,
  type MigrationDecision,
  resolveMigrationDecisions,
} from "./claude-migration-proposal";
import { applyMigrationDecision, type MigrationOutcome } from "./claude-migration-writer";

/** The blocking proposal presenter: raises the contract and resolves with the user's answer. */
export type MigrationAsker = (
  contract: ProviderQuestionContract,
) => Promise<ProviderQuestionAnswer>;

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

/** The pending migration items for `cwd` after dropping permanently-ignored files. */
export interface PendingMigrations {
  /** The resolved absolute project root the decisions apply against. */
  readonly root: string;
  /** The non-pointer, non-ignored files that still warrant a proposal. */
  readonly pending: readonly ClaudeMigrationItem[];
}

/**
 * The pure pre-step: discover root + nested CLAUDE.md files needing a proposal (non-pointer) and drop
 * any recorded as permanently ignored. No filesystem mutation - callers raise the proposal only when
 * `pending` is non-empty. Shared by the tool (which wraps the blocking ask as an Effect) and
 * {@link runClaudeMigrationFlow} so both paths filter identically.
 */
export function collectPendingMigrations(cwd: string, ignoresFile?: string): PendingMigrations {
  const root = resolve(cwd);
  const ignored = loadPermanentlyIgnored(root, ignoresFile);
  const pending = discoverClaudeMigrations(root).proposalItems.filter(
    (item) => !ignored.has(item.claudePath),
  );
  return { root, pending };
}

/**
 * The pure post-step: map the user's answer to explicit per-file decisions, apply them (the ONLY place
 * a file is written, always after the answer), and record any newly permanently-ignored files. Callers
 * pass the same `pending` set they proposed.
 */
export function applyMigrationAnswer(
  root: string,
  pending: readonly ClaudeMigrationItem[],
  answer: ProviderQuestionAnswer,
  ignoresFile?: string,
): ClaudeMigrationFlowResult {
  const decisions = resolveMigrationDecisions(pending, answer);
  const outcomes = decisions.map((decision) => applyMigrationDecision(root, decision));

  const newlyIgnored = decisions
    .filter((decision) => decision.action === "ignore-permanent")
    .map((decision) => decision.claudePath);
  if (newlyIgnored.length > 0) {
    addPermanentlyIgnored(root, newlyIgnored, ignoresFile);
  }

  const status = answer.action === "accept" ? "answered" : "declined";
  const summary =
    status === "declined"
      ? "Migration declined; no CLAUDE.md files were changed."
      : `CLAUDE.md migration: ${outcomes.map(outcomeLine).join("; ")}.`;
  return { status, decisions, outcomes, summary };
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
    default:
      return `left ${outcome.claudePath} unchanged`;
  }
}

/**
 * Run one migration round for `cwd`. Discovers root + nested CLAUDE.md files needing a proposal
 * (non-pointer), drops any recorded as permanently ignored, and returns early - WITHOUT asking - when
 * none remain. Otherwise it raises the proposal (blocking on `ask`), maps the answer to explicit
 * per-file decisions, applies them (writes happen only here, after the answer), and records any
 * newly permanently-ignored files so a later run does not re-propose them.
 */
export async function runClaudeMigrationFlow(
  cwd: string,
  ask: MigrationAsker,
  opts: ClaudeMigrationFlowOptions = {},
): Promise<ClaudeMigrationFlowResult> {
  const { root, pending } = collectPendingMigrations(cwd, opts.ignoresFile);
  if (pending.length === 0) {
    return {
      status: "no-migrations",
      decisions: [],
      outcomes: [],
      summary: "No CLAUDE.md files need migration.",
    };
  }
  const answer = await ask(buildMigrationProposalContract(pending));
  return applyMigrationAnswer(root, pending, answer, opts.ignoresFile);
}
