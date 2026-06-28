import type { ProviderQuestionAnswer, ProviderQuestionContract } from "./provider-question";

/**
 * A thin adapter that expresses an APPROVAL as an `ask_user` question, so model-initiated proposals
 * (the continuation-handoff plan, 02) reuse the one user-decision primitive instead of inventing a
 * second approval UI. It is deliberately generic: it knows "approve / edit / reject", not anything
 * about handoff. Handoff-specific copy stays in the caller (it passes `title`/`summary`); this module
 * owns only the approve/edit/reject mapping in both directions.
 */

/** An approval to put to the user. `allowEdit` adds an edit path (the custom-answer row). */
export interface ApprovalRequest {
  /** The decision prompt, e.g. "Approve handing off to a fresh session?". */
  readonly title: string;
  /** The proposal the user is approving, shown as the approve option's description. */
  readonly summary: string;
  /** Add an "edit" path: the user types an amended proposal in the custom-answer row. */
  readonly allowEdit?: boolean;
  /** Override the approve option label (default "Approve"). */
  readonly approveLabel?: string;
  /** Override the reject option label (default "Reject"). */
  readonly rejectLabel?: string;
}

/** The user's decision, decoded from their ask_user answer. */
export type ApprovalDecision =
  | { readonly action: "approve" }
  | { readonly action: "edit"; readonly edited: string }
  | { readonly action: "reject"; readonly reason?: string };

/** The stable ids the adapter uses for the approve / reject choices. */
export const APPROVE_CHOICE_ID = "approve";
export const REJECT_CHOICE_ID = "reject";

/**
 * Build the `ask_user` contract for an approval: one single-choice question with Approve (recommended)
 * and Reject, plus - when `allowEdit` - the custom-answer row as the edit path. The result is a normal
 * `ProviderQuestionContract`, so the existing surface, validation, and host runtime handle it unchanged.
 */
export function approvalQuestion(request: ApprovalRequest): ProviderQuestionContract {
  return {
    schemaVersion: 1,
    questions: [
      {
        id: "approval",
        question: request.title,
        answerShape: "single_choice",
        multiSelect: false,
        requiresReason: false,
        allowDefer: false,
        choices: [
          {
            id: APPROVE_CHOICE_ID,
            label: request.approveLabel ?? "Approve",
            description: request.summary,
            recommended: true,
          },
          {
            id: REJECT_CHOICE_ID,
            label: request.rejectLabel ?? "Reject",
          },
        ],
      },
    ],
  };
}

/**
 * Interpret an ask_user answer to an approval question as an `ApprovalDecision`. A decline/cancel reads
 * as reject; a custom-text answer reads as an edit (the amended proposal); otherwise the chosen option
 * decides approve vs reject. Notes on a reject are carried back as the reason.
 */
export function approvalDecision(answer: ProviderQuestionAnswer): ApprovalDecision {
  if (answer.action !== "accept") {
    return { action: "reject" };
  }
  const item = answer.questions[0];
  if (!item) {
    return { action: "reject" };
  }
  const edited = item.text?.trim();
  if (edited && edited.length > 0) {
    return { action: "edit", edited };
  }
  const chosen = item.selected?.[0]?.id;
  if (chosen === APPROVE_CHOICE_ID) {
    return { action: "approve" };
  }
  const reason = item.notes?.trim();
  return reason && reason.length > 0 ? { action: "reject", reason } : { action: "reject" };
}
