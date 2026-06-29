import {
  type AnswerIssue,
  normalizeAskUserInput,
  type ProviderQuestionAccept,
  type ProviderQuestionContract,
  type ProviderQuestionItem,
  type QuestionItemAnswer,
  type RawAskUserInput,
  type SelectedChoice,
  validateAnswer,
} from "@trevor/session";

/**
 * The write-side view-model for the ask_user question surface: the editable answer DRAFT the user
 * builds while a group is pending, and the pure transforms between it and the wire answer.
 *
 * The READ side is the contract itself (`ProviderQuestionContract` from @trevor/session) - already
 * render-ready, so the surface renders it directly. This module owns the rest, kept out of the
 * component so it is testable without a DOM (M2.5 "split view-model transforms from presentation"):
 *   - `emptyDraft` seeds a draft from a contract;
 *   - the reducers (`toggleChoice`, `setCustomText`, `setNotes`, `setReason`, `toggleDefer`) update it
 *     immutably with the single/multi-select and custom-vs-choice rules baked in;
 *   - `buildAnswer` folds the draft into a `ProviderQuestionAccept`, and `draftErrors` validates that
 *     answer with the SHARED `validateAnswer`, so the surface disables submit on the same rules the
 *     host enforces.
 *
 * `contractFromRaw` re-exposes the shared legacy/rich coercion so the surface (and fixtures) can take
 * a model-shaped `ask_user` payload and render it without re-implementing normalization.
 */

/** The editable answer state for one question while the user fills it in. */
export interface QuestionDraft {
  /** Chosen choice ids: single-choice holds 0 or 1, multi-select holds 0 or more. */
  readonly selectedIds: readonly string[];
  /** Free-text answer (free_text questions) or the custom row of a choice question. */
  readonly customText: string;
  /** The custom answer row is the chosen answer (single-choice radio) / is included (multi-select). */
  readonly customSelected: boolean;
  readonly notes: string;
  readonly reason: string;
  readonly deferred: boolean;
}

/** The editable answer state for a whole group, keyed by question id. The `activeIndex` cursor (02.18)
 *  is the sequenced-tab position; it lives alongside `byId` (whose shape is unchanged) so the surface
 *  keeps ONE state object and stays presentational. */
export interface GroupDraft {
  readonly byId: Readonly<Record<string, QuestionDraft>>;
  /** The active question/tab index (sequenced multi-question surface); always 0 for a single question. */
  readonly activeIndex: number;
}

const EMPTY_QUESTION: QuestionDraft = {
  selectedIds: [],
  customText: "",
  customSelected: false,
  notes: "",
  reason: "",
  deferred: false,
};

/** Coerce a raw model `ask_user` payload (legacy single or rich grouped) into the canonical contract. */
export const contractFromRaw = (raw: RawAskUserInput): ProviderQuestionContract =>
  normalizeAskUserInput(raw);

/** Seed an empty draft - one blank `QuestionDraft` per question in the contract. */
export function emptyDraft(contract: ProviderQuestionContract): GroupDraft {
  const byId: Record<string, QuestionDraft> = {};
  for (const q of contract.questions) {
    byId[q.id] = EMPTY_QUESTION;
  }
  return { byId, activeIndex: 0 };
}

/**
 * Seed the draft the surface opens with. A single-choice question (exactly one answer required) starts
 * on its recommended option so the common case is one keystroke from done; multi-select and free-text
 * start empty so the user opts in deliberately.
 */
export function initialDraft(contract: ProviderQuestionContract): GroupDraft {
  const byId: Record<string, QuestionDraft> = {};
  for (const q of contract.questions) {
    const recommended = !q.multiSelect ? q.choices.find((c) => c.recommended) : undefined;
    byId[q.id] = recommended
      ? { ...EMPTY_QUESTION, selectedIds: [recommended.id] }
      : EMPTY_QUESTION;
  }
  return { byId, activeIndex: 0 };
}

function patch(draft: GroupDraft, qid: string, change: Partial<QuestionDraft>): GroupDraft {
  const current = draft.byId[qid] ?? EMPTY_QUESTION;
  // Spread the draft so the active-tab cursor survives every per-question edit.
  return { ...draft, byId: { ...draft.byId, [qid]: { ...current, ...change } } };
}

/**
 * Choose a choice. Multi-select adds/removes the id (deselecting is allowed). Single-choice ("must
 * choose one") only ever SETS the selection - re-selecting the chosen option keeps it, never clears it -
 * and drops any custom-row text. Either way, choosing un-defers the question.
 */
export function toggleChoice(
  draft: GroupDraft,
  q: ProviderQuestionItem,
  choiceId: string,
): GroupDraft {
  const current = draft.byId[q.id] ?? EMPTY_QUESTION;
  if (q.multiSelect) {
    const has = current.selectedIds.includes(choiceId);
    const selectedIds = has
      ? current.selectedIds.filter((id) => id !== choiceId)
      : [...current.selectedIds, choiceId];
    return patch(draft, q.id, { selectedIds, deferred: false });
  }
  return patch(draft, q.id, {
    selectedIds: [choiceId],
    customSelected: false,
    customText: "",
    deferred: false,
  });
}

/**
 * Choose the custom-answer row without typing yet (arrow/click). Single-choice clears any chosen choice
 * so only the custom row is selected; multi-select toggles the custom row's inclusion.
 */
export function selectCustom(draft: GroupDraft, q: ProviderQuestionItem): GroupDraft {
  const current = draft.byId[q.id] ?? EMPTY_QUESTION;
  if (q.multiSelect) {
    return patch(draft, q.id, { customSelected: !current.customSelected, deferred: false });
  }
  return patch(draft, q.id, { selectedIds: [], customSelected: true, deferred: false });
}

/** Set the custom/free-text answer. Typing selects the custom row; single-choice clears the chosen choice. */
export function setCustomText(
  draft: GroupDraft,
  q: ProviderQuestionItem,
  text: string,
): GroupDraft {
  return patch(draft, q.id, {
    customText: text,
    customSelected: true,
    ...(q.multiSelect ? {} : { selectedIds: [] }),
    deferred: false,
  });
}

export const setNotes = (draft: GroupDraft, qid: string, notes: string): GroupDraft =>
  patch(draft, qid, { notes });

export const setReason = (draft: GroupDraft, qid: string, reason: string): GroupDraft =>
  patch(draft, qid, { reason });

/** Toggle the deferred state of a question (only meaningful when the question `allowDefer`). */
export function toggleDefer(draft: GroupDraft, qid: string): GroupDraft {
  const current = draft.byId[qid] ?? EMPTY_QUESTION;
  return patch(draft, qid, { deferred: !current.deferred });
}

function summarize(q: ProviderQuestionItem, d: QuestionDraft): string {
  if (d.deferred) {
    return "Deferred";
  }
  const labels = d.selectedIds
    .map((id) => q.choices.find((c) => c.id === id)?.label)
    .filter((l): l is string => l != null);
  const custom = d.customText.trim();
  if (d.customSelected && custom.length > 0) {
    labels.push(custom);
  }
  return labels.join(", ");
}

/** Fold one question's draft into its wire answer (deferred / chosen choices / custom text / merged content). */
export function buildItemAnswer(q: ProviderQuestionItem, d: QuestionDraft): QuestionItemAnswer {
  if (d.deferred) {
    return { id: q.id, answer: "Deferred", defer: true };
  }
  const chosen = q.choices.filter((c) => d.selectedIds.includes(c.id));
  const selected: SelectedChoice[] = chosen.map((c) => ({ id: c.id, label: c.label }));
  const custom = d.customText.trim();
  if (custom.length > 0 && q.multiSelect && d.customSelected) {
    selected.push({ label: custom, custom: true });
  }
  const mergedContent: Record<string, unknown> = {};
  for (const c of chosen) {
    if (c.content) {
      Object.assign(mergedContent, c.content);
    }
  }
  const wantsText =
    q.answerShape === "free_text" || (q.answerShape === "single_choice" && selected.length === 0);
  return {
    id: q.id,
    answer: summarize(q, d),
    ...(selected.length > 0 ? { selected } : {}),
    ...(wantsText && custom.length > 0 ? { text: custom } : {}),
    ...(d.notes.trim().length > 0 ? { notes: d.notes.trim() } : {}),
    ...(d.reason.trim().length > 0 ? { reason: d.reason.trim() } : {}),
    ...(Object.keys(mergedContent).length > 0 ? { content: mergedContent } : {}),
  };
}

/** Fold the whole draft into an `accept` answer: one entry per question plus a combined summary. */
export function buildAnswer(
  contract: ProviderQuestionContract,
  draft: GroupDraft,
): ProviderQuestionAccept {
  const questions = contract.questions.map((q) =>
    buildItemAnswer(q, draft.byId[q.id] ?? EMPTY_QUESTION),
  );
  const answer = questions
    .map((a) => a.answer)
    .filter((s) => s.length > 0)
    .join("; ");
  return { action: "accept", answer, questions };
}

/** The validation issues for the current draft, via the SHARED validator - empty means ready to submit. */
export function draftErrors(
  contract: ProviderQuestionContract,
  draft: GroupDraft,
): readonly AnswerIssue[] {
  return validateAnswer(contract, buildAnswer(contract, draft));
}

/** Whether the draft is a complete, submittable answer (no validation issues). */
export const isComplete = (contract: ProviderQuestionContract, draft: GroupDraft): boolean =>
  draftErrors(contract, draft).length === 0;

// --- sequenced-tab cursor + per-tab validity (02.18) ---
//
// `validateAnswer` validates a WHOLE contract, so per-tab validity is DERIVED here by filtering its
// issues by `questionId` (D-010) - there is no per-question validator to reach for. The active-tab
// cursor reducers keep the surface presentational: it dispatches `goToTab`/`advance` and reads back
// `activeIndex`, never owning the clamp/gating itself.

/** The validation issues for ONE question (filtered from the whole-contract `draftErrors` by id). Empty
 *  means that tab is satisfied - it drives the tab checkmark and the "Next" gate. <!-- D-010 --> */
export function questionErrors(
  contract: ProviderQuestionContract,
  draft: GroupDraft,
  questionId: string,
): readonly AnswerIssue[] {
  return draftErrors(contract, draft).filter((issue) => issue.questionId === questionId);
}

/** The index of the first question that still has validation issues, or -1 when the whole group is
 *  complete. Drives the "go to incomplete (Qk)" jump on the final tab. <!-- D-011 --> */
export function firstInvalidIndex(contract: ProviderQuestionContract, draft: GroupDraft): number {
  const issues = draftErrors(contract, draft);
  return contract.questions.findIndex((q) => issues.some((i) => i.questionId === q.id));
}

/** Move the active tab to `index`, clamped to a valid tab. */
export function goToTab(draft: GroupDraft, index: number): GroupDraft {
  const count = Object.keys(draft.byId).length;
  const clamped = Math.max(0, Math.min(index, Math.max(0, count - 1)));
  return clamped === draft.activeIndex ? draft : { ...draft, activeIndex: clamped };
}

/** Advance to the next tab, but ONLY when the current tab is valid; a no-op past the last tab or while
 *  the current tab has issues (so "Next" can never skip an unanswered question). <!-- D-011 --> */
export function advance(contract: ProviderQuestionContract, draft: GroupDraft): GroupDraft {
  const current = contract.questions[draft.activeIndex];
  if (!current || questionErrors(contract, draft, current.id).length > 0) {
    return draft;
  }
  const next = Math.min(draft.activeIndex + 1, contract.questions.length - 1);
  return next === draft.activeIndex ? draft : { ...draft, activeIndex: next };
}
