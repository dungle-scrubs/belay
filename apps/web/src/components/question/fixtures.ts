import type {
  ProviderQuestionAccept,
  ProviderQuestionChoice,
  ProviderQuestionContract,
  ProviderQuestionItem,
  QuestionItemAnswer,
  RawAskUserInput,
} from "@belay/session";

/**
 * Shared fixtures for the ask_user question surface, imported by BOTH the view-model tests and the
 * Storybook stories (M1.5: one set of payload literals, no duplication). They cover the full V1 case
 * matrix - single-choice, grouped, multi-select, custom answer, defer, notes, required reason, choice
 * metadata (recommended / impact / risk / badges), and ASCII previews - plus a legacy raw input so the
 * coercion path (`contractFromRaw`) is exercised from real model-shaped data.
 */

/** Build a choice with sensible defaults; spread overrides last. */
export const choice = (
  over: Partial<ProviderQuestionChoice> & Pick<ProviderQuestionChoice, "id" | "label">,
): ProviderQuestionChoice => ({ ...over });

/** Build a question with defaults; `answerShape` is supplied explicitly so fixtures stay honest. */
export const question = (
  over: Partial<ProviderQuestionItem> &
    Pick<ProviderQuestionItem, "id" | "question" | "answerShape">,
): ProviderQuestionItem => ({
  multiSelect: over.answerShape === "multi_select",
  requiresReason: false,
  allowDefer: false,
  choices: [],
  ...over,
});

/** Wrap one or more questions into a canonical contract. */
export const contract = (questions: readonly ProviderQuestionItem[]): ProviderQuestionContract => ({
  schemaVersion: 1,
  questions,
});

export const itemAnswer = (
  over: Partial<QuestionItemAnswer> & Pick<QuestionItemAnswer, "id" | "answer">,
): QuestionItemAnswer => ({ ...over });

export const acceptAnswer = (questions: readonly QuestionItemAnswer[]): ProviderQuestionAccept => ({
  action: "accept",
  answer: questions
    .map((a) => a.answer)
    .filter((s) => s.length > 0)
    .join("; "),
  questions,
});

// --- scenario contracts ---

/** A plain single-choice decision with descriptions and a recommended option. */
export const singleChoice = contract([
  question({
    id: "db",
    question: "Which database should the new service use?",
    header: "Storage",
    answerShape: "single_choice",
    choices: [
      choice({
        id: "postgres",
        label: "PostgreSQL",
        description: "Managed Postgres on the existing cluster.",
        recommended: true,
        impact: "Reuses our backup + failover; one more schema to migrate.",
      }),
      choice({
        id: "sqlite",
        label: "SQLite",
        description: "Embedded, file-backed - zero infra.",
        impact: "No network DB to run; single-writer only.",
        risk: "Hard to scale past one node.",
      }),
      choice({
        id: "mysql",
        label: "MySQL",
        description: "Separate MySQL instance.",
        badges: ["needs ops"],
      }),
    ],
  }),
]);

/** A multi-select question: pick any number of targets, plus a free-form custom entry. */
export const multiSelect = contract([
  question({
    id: "targets",
    question: "Which platforms should the first release target?",
    answerShape: "multi_select",
    choices: [
      choice({ id: "macos", label: "macOS", recommended: true }),
      choice({ id: "linux", label: "Linux" }),
      choice({ id: "windows", label: "Windows", risk: "No CI runner yet." }),
      choice({ id: "web", label: "Web", badges: ["experimental"] }),
    ],
  }),
]);

/** A free-text question (no choices) - the model wants prose. */
export const freeText = contract([
  question({
    id: "name",
    question: "What should we name the new package?",
    answerShape: "free_text",
  }),
]);

/** A single-choice question that explicitly invites a custom answer and requires a reason. */
export const requiredReason = contract([
  question({
    id: "approach",
    question: "How should we handle the migration?",
    answerShape: "single_choice",
    requiresReason: true,
    choices: [
      choice({
        id: "big-bang",
        label: "Big-bang cutover",
        risk: "All-or-nothing; high blast radius.",
      }),
      choice({ id: "incremental", label: "Incremental, table by table", recommended: true }),
    ],
  }),
]);

/** A question the user may defer (skip) for now. */
export const deferrable = contract([
  question({
    id: "telemetry",
    question: "Enable anonymous telemetry in this build?",
    answerShape: "single_choice",
    allowDefer: true,
    choices: [
      choice({ id: "yes", label: "Yes, enable it" }),
      choice({ id: "no", label: "No, keep it off", recommended: true }),
    ],
  }),
]);

/** A choice carrying rich ASCII previews, both string-derived and structured. */
export const withPreviews = contract([
  question({
    id: "layout",
    question: "Which side-panel layout do you prefer?",
    kind: "preview",
    answerShape: "single_choice",
    choices: [
      choice({
        id: "stacked",
        label: "Stacked",
        recommended: true,
        preview: {
          text: "+----------------+\n| header         |\n+----------------+\n| body           |\n|                |\n+----------------+",
          viewport: "narrow",
        },
      }),
      choice({
        id: "split",
        label: "Split",
        preview: {
          text: "+--------+-------+\n| nav    | body  |\n|        |       |\n+--------+-------+",
          viewport: "wide",
        },
      }),
    ],
  }),
]);

/** A grouped ask: several questions of mixed shapes in one pending surface (1..5). */
export const grouped = contract([
  question({
    id: "scope",
    question: "What scope should this change cover?",
    header: "Planning",
    answerShape: "single_choice",
    choices: [
      choice({ id: "minimal", label: "Minimal slice", recommended: true }),
      choice({ id: "full", label: "Full feature", impact: "More surface area to review." }),
    ],
  }),
  question({
    id: "checks",
    question: "Which checks must pass before merge?",
    answerShape: "multi_select",
    choices: [
      choice({ id: "unit", label: "Unit tests", recommended: true }),
      choice({ id: "e2e", label: "E2E tests" }),
      choice({ id: "lint", label: "Lint", recommended: true }),
    ],
  }),
  question({
    id: "notes",
    question: "Anything else the reviewer should know?",
    answerShape: "free_text",
  }),
]);

/**
 * A CLAUDE.md migration proposal (plan 26): the host raises this as a provider-question so it renders
 * through the same surface. One question per detected file, the paths + sibling state + a bounded
 * preview in the question text, and the explicit per-file actions as choices - the choice `id` IS the
 * action (no content payload; the host resolves from `selected[0].id`). This mirrors
 * `buildMigrationProposalContract`'s output shape; the host owns the authoritative builder.
 */
export const claudeMigration = contract([
  question({
    id: "CLAUDE.md",
    question:
      "Migrate CLAUDE.md to AGENTS.md? No sibling AGENTS.md exists yet. Preview: # House rules - always run the linter before committing.",
    header: "CLAUDE.md migration",
    answerShape: "single_choice",
    choices: [
      choice({
        id: "create",
        label: "Create AGENTS.md",
        description: "Convert this CLAUDE.md into a sibling AGENTS.md and leave a pointer behind.",
        recommended: true,
      }),
      choice({ id: "leave", label: "Leave unchanged" }),
      choice({ id: "ignore-once", label: "Ignore once" }),
      choice({ id: "ignore-permanent", label: "Ignore permanently" }),
    ],
  }),
]);

/** A migration proposal for a file whose sibling AGENTS.md already exists: merge is offered, not create. */
export const claudeMigrationWithSibling = contract([
  question({
    id: "apps/web/CLAUDE.md",
    question:
      "Migrate apps/web/CLAUDE.md to apps/web/AGENTS.md? A sibling apps/web/AGENTS.md already exists. Preview: nested web rules.",
    header: "CLAUDE.md migration",
    answerShape: "single_choice",
    choices: [
      choice({ id: "merge", label: "Merge into existing AGENTS.md", recommended: true }),
      choice({ id: "leave", label: "Leave unchanged" }),
      choice({ id: "ignore-once", label: "Ignore once" }),
      choice({ id: "ignore-permanent", label: "Ignore permanently" }),
    ],
  }),
]);

/** A legacy single-question raw input, to exercise the coercion path end to end. */
export const legacyRaw: RawAskUserInput = {
  question: "Proceed with the destructive reset?",
  choices: [{ label: "Yes, reset" }, { label: "No, abort" }],
};
