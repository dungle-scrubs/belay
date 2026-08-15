/**
 * Responsible for: shaping a CLAUDE.md migration inventory into a required-response proposal
 * (a shared `ProviderQuestionContract`) and mapping the user's answer back to per-file actions.
 * Not for: filesystem mutation (claude-migration-writer.ts) or discovery (claude-migration.ts).
 *
 * The proposal reuses the plan-01 `ask_user` / provider-question DATA layer so it rides the same
 * `provider.question.*` events and renders through the same web card. Each detected file becomes one
 * independently-answerable question (D-006 nested coverage); the per-choice `id` IS the action and is
 * echoed back in the user's `selected[]`, so the resolved decisions are read structurally rather than
 * parsed from prose. Generation stays pure and side-effect free (D-005 / M5.7): nothing here writes.
 */
import type {
  ProviderQuestionAnswer,
  ProviderQuestionChoice,
  ProviderQuestionContract,
  ProviderQuestionItem,
} from "@belay/session";
import { MAX_QUESTIONS } from "@belay/session";
import type { ClaudeMigrationItem } from "./claude-migration";

/** The explicit per-file actions a user may pick for a detected CLAUDE.md (D-010). */
export type MigrationActionKind = "create" | "merge" | "leave" | "ignore-once" | "ignore-permanent";

/** Human-readable labels for each action, shared so the proposal and diagnostics agree. */
export const MIGRATION_ACTION_LABELS: Record<MigrationActionKind, string> = {
  create: "Create AGENTS.md",
  merge: "Merge into existing AGENTS.md",
  leave: "Leave unchanged",
  "ignore-once": "Ignore once",
  "ignore-permanent": "Ignore permanently",
};

/** Short descriptions, surfaced under each choice so the user sees the effect before choosing. */
const MIGRATION_ACTION_DESCRIPTIONS: Record<MigrationActionKind, string> = {
  create: "Convert this CLAUDE.md into a sibling AGENTS.md and leave a pointer behind.",
  merge:
    "Append the CLAUDE.md body as a marked section in the existing AGENTS.md, then leave a pointer.",
  leave: "Do nothing now; you may be asked again on a later run.",
  "ignore-once": "Skip this file for now without recording a permanent decision.",
  "ignore-permanent": "Never propose migrating this file again.",
};

/** One resolved per-file decision: what the user chose for a specific CLAUDE.md. */
export interface MigrationDecision {
  readonly claudePath: string;
  readonly agentsPath: string;
  readonly action: MigrationActionKind;
}

/** The write action offered as the recommended default: merge when a sibling exists, else create. */
function primaryAction(item: ClaudeMigrationItem): "create" | "merge" {
  return item.siblingAgentsExists ? "merge" : "create";
}

/** The ordered choices for one file: its primary write action, then leave/ignore escape hatches. */
function choicesFor(item: ClaudeMigrationItem): readonly ProviderQuestionChoice[] {
  const actions: readonly MigrationActionKind[] = [
    primaryAction(item),
    "leave",
    "ignore-once",
    "ignore-permanent",
  ];
  const recommended = primaryAction(item);
  // No `content` payload: the choice `id` IS the action (one source of truth); the host resolves the
  // decision from `selected[0].id`, so a parallel content blob could only drift from it.
  return actions.map((action) => ({
    id: action,
    label: MIGRATION_ACTION_LABELS[action],
    description: MIGRATION_ACTION_DESCRIPTIONS[action],
    ...(action === recommended ? { recommended: true } : {}),
  }));
}

/** The question prompt for one file: the paths, sibling state, and a bounded preview. */
function questionText(item: ClaudeMigrationItem): string {
  const sibling = item.siblingAgentsExists
    ? `A sibling ${item.agentsPath} already exists.`
    : `No sibling ${item.agentsPath} exists yet.`;
  return (
    `Migrate ${item.claudePath} to ${item.agentsPath}? ${sibling} ` + `Preview: ${item.preview}`
  );
}

/**
 * Build the required-response proposal contract from a migration inventory's proposal items. One
 * question per file (capped at {@link MAX_QUESTIONS}; the rest surface on a later run once converted
 * files drop out as pointers). Callers pass only files that still need a proposal (non-pointer,
 * non-permanently-ignored).
 */
export function buildMigrationProposalContract(
  items: readonly ClaudeMigrationItem[],
): ProviderQuestionContract {
  const questions: ProviderQuestionItem[] = items.slice(0, MAX_QUESTIONS).map((item) => ({
    id: item.claudePath,
    question: questionText(item),
    answerShape: "single_choice",
    header: "CLAUDE.md migration",
    multiSelect: false,
    requiresReason: false,
    allowDefer: false,
    choices: choicesFor(item),
  }));
  return { schemaVersion: 1, questions };
}

/** Every action id, derived from the label map's keys so a new MigrationActionKind cannot be added
 *  without a label - and is then accepted here automatically instead of falling through to "leave". */
const MIGRATION_ACTION_IDS = Object.keys(MIGRATION_ACTION_LABELS) as readonly MigrationActionKind[];

/** The action a single accepted answer selected, read from its `selected[]` id (else `leave`). */
function actionFromAnswer(
  selected: readonly { readonly id?: string }[] | undefined,
): MigrationActionKind {
  const id = selected?.[0]?.id;
  return id !== undefined && (MIGRATION_ACTION_IDS as readonly string[]).includes(id)
    ? (id as MigrationActionKind)
    : "leave";
}

/**
 * Map the user's answer back to one explicit decision per proposed file. A decline/cancel leaves every
 * file unchanged; an accept reads each file's chosen action from its matching answer, defaulting any
 * unanswered file to leave-unchanged so no file is ever mutated without an explicit selection (D-005).
 */
export function resolveMigrationDecisions(
  items: readonly ClaudeMigrationItem[],
  answer: ProviderQuestionAnswer,
): readonly MigrationDecision[] {
  const byId =
    answer.action === "accept"
      ? new Map(answer.questions.map((q) => [q.id, q] as const))
      : new Map<string, never>();
  return items.map((item) => ({
    claudePath: item.claudePath,
    agentsPath: item.agentsPath,
    action:
      answer.action === "accept" ? actionFromAnswer(byId.get(item.claudePath)?.selected) : "leave",
  }));
}
