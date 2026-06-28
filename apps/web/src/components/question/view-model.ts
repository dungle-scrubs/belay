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

/** The editable answer state for a whole group, keyed by question id. */
export interface GroupDraft {
  readonly byId: Readonly<Record<string, QuestionDraft>>;
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
  return { byId };
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
  return { byId };
}

function patch(draft: GroupDraft, qid: string, change: Partial<QuestionDraft>): GroupDraft {
  const current = draft.byId[qid] ?? EMPTY_QUESTION;
  return { byId: { ...draft.byId, [qid]: { ...current, ...change } } };
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
