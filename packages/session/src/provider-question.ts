/**
 * The `ask_user` provider-question contract: the typed payload describing a model-asked
 * decision (1..5 grouped questions with concrete choices + metadata) and the user's answer.
 *
 * This is the shared DATA layer, owned here once so every participant agrees on the shape:
 *   - the host (apps/agent-host) normalizes the model's raw `ask_user` tool input into a
 *     canonical `ProviderQuestionContract`, validates it, emits it on the session log, and
 *     later validates the user's `ProviderQuestionAnswer` before returning it to the tool call;
 *   - the web surface (apps/web) folds the canonical contract into a render view-model and
 *     builds the answer.
 *
 * It carries NO transport and NO React - just types and pure coercion/validation - so both
 * sides import it without pulling in the other's runtime. The `provider.question.*` protocol
 * EVENTS that move this payload over the wire live in ./protocol.
 */

/** How a single question is answered: pick exactly one, pick any number, or type free text. */
export type ProviderQuestionAnswerShape = "single_choice" | "multi_select" | "free_text";

/** A group carries at least one and at most five questions (V1 parity). */
export const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 5;

/**
 * A structured preview attached to a choice (e.g. an ASCII layout mock). Model-provided content,
 * so it is rendered as INERT TEXT, never interpreted as HTML. `viewport` is an optional visual hint
 * (e.g. "narrow"); `before`/`after` frame the change in context.
 */
export interface QuestionChoicePreview {
  readonly text?: string;
  readonly viewport?: string;
  readonly before?: string;
  readonly after?: string;
}

/**
 * One selectable choice within a question. `id` and `label` are required after normalization; the
 * rest are optional model-provided richness. `content` is an opaque payload the model attached to a
 * choice; when the user picks it, the host returns that payload verbatim in the answer.
 */
export interface ProviderQuestionChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly preview?: QuestionChoicePreview;
  readonly recommended?: boolean;
  readonly impact?: string;
  readonly risk?: string;
  readonly badges?: readonly string[];
  readonly content?: Readonly<Record<string, unknown>>;
}

/**
 * One question in a group. `answerShape` is derived from `multiSelect` + `choices` and stored so
 * consumers never re-derive it. `requiresReason` forces a reason before accept; `allowDefer` lets the
 * user skip this one question.
 */
export interface ProviderQuestionItem {
  readonly id: string;
  readonly question: string;
  readonly answerShape: ProviderQuestionAnswerShape;
  readonly header?: string;
  readonly kind?: string;
  readonly multiSelect: boolean;
  readonly requiresReason: boolean;
  readonly allowDefer: boolean;
  readonly choices: readonly ProviderQuestionChoice[];
}

/** The normalized payload describing a model-asked question group. `schemaVersion` is fixed at 1. */
export interface ProviderQuestionContract {
  readonly schemaVersion: 1;
  readonly questions: readonly ProviderQuestionItem[];
}

// --- answer payload ---

/** The action the user took on a pending question group. */
export type ProviderQuestionAction = "accept" | "decline" | "cancel";

/** A choice the user selected (by `id`), or a custom free-text entry (`custom: true`, no `id`). */
export interface SelectedChoice {
  readonly id?: string;
  readonly label: string;
  readonly custom?: boolean;
}

/**
 * The user's answer to ONE question within an accepted group. `selected` carries the chosen choice(s)
 * for single_choice (one) and multi_select (zero or more); `text` carries the typed answer for
 * free_text (and the custom row of a single_choice). `content` is the merged opaque payload of the
 * chosen choice(s). A deferred question sets `defer` and omits the rest.
 */
export interface QuestionItemAnswer {
  readonly id: string;
  readonly answer: string;
  readonly selected?: readonly SelectedChoice[];
  readonly text?: string;
  readonly notes?: string;
  readonly reason?: string;
  readonly defer?: boolean;
  readonly content?: Readonly<Record<string, unknown>>;
}

/** An accepted group answer: one entry per question plus a combined human-readable summary. */
export interface ProviderQuestionAccept {
  readonly action: "accept";
  readonly answer: string;
  readonly questions: readonly QuestionItemAnswer[];
}

/** A declined or cancelled group: no per-question content. */
export interface ProviderQuestionReject {
  readonly action: "decline" | "cancel";
}

export type ProviderQuestionAnswer = ProviderQuestionAccept | ProviderQuestionReject;

// --- raw model tool input (loose, legacy-tolerant) ---

/** A choice as the MODEL provides it: ids optional, preview a string OR structured object. */
export interface RawQuestionChoice {
  readonly id?: string;
  readonly label?: string;
  readonly description?: string;
  readonly preview?: string | QuestionChoicePreview;
  readonly recommended?: boolean;
  readonly impact?: string;
  readonly risk?: string;
  readonly badges?: readonly string[];
  readonly content?: Readonly<Record<string, unknown>>;
}

/** A question as the MODEL provides it (rich grouped form). */
export interface RawQuestion {
  readonly id?: string;
  readonly question?: string;
  readonly header?: string;
  readonly kind?: string;
  readonly multiSelect?: boolean;
  readonly requiresReason?: boolean;
  readonly allowDefer?: boolean;
  readonly choices?: readonly RawQuestionChoice[];
}

/**
 * The model-facing `ask_user` tool input. Two shapes, both accepted: the legacy single-question form
 * (`question` + `choices`) and the rich grouped form (`questions[]`). The grouped form wins when
 * present and non-empty.
 */
export interface RawAskUserInput {
  readonly question?: string;
  readonly choices?: readonly RawQuestionChoice[];
  readonly multiSelect?: boolean;
  readonly requiresReason?: boolean;
  readonly allowDefer?: boolean;
  readonly questions?: readonly RawQuestion[];
}

/** Derive how a question is answered from its multi-select flag and whether it has choices. */
export function deriveAnswerShape(q: {
  readonly multiSelect?: boolean;
  readonly choices?: readonly unknown[];
}): ProviderQuestionAnswerShape {
  if (q.multiSelect) {
    return "multi_select";
  }
  if ((q.choices?.length ?? 0) > 0) {
    return "single_choice";
  }
  return "free_text";
}

/**
 * Coerce the model's raw `ask_user` input into the canonical contract: fill missing ids, derive each
 * answer shape, structure string previews, and default the boolean flags. The grouped `questions[]`
 * form is used when present and non-empty; otherwise the legacy `question` + `choices` form becomes a
 * one-question group. Always returns a contract (possibly empty); structural validity is a separate
 * `validateContract` concern, so the host can report precise issues and the UI can still render.
 *
 * The per-field coercion (id fallbacks, preview shaping, flag defaults, answer-shape derivation) IS
 * the permissive wire decoder ({@link decodeQuestion}); a typed `RawQuestion` is just a well-formed
 * `unknown`, so this entry only selects the grouped-vs-legacy source and funnels it through the one
 * core - the host normalize path and the wire decode can't disagree on defaults.
 */
export function normalizeAskUserInput(raw: RawAskUserInput): ProviderQuestionContract {
  const source: readonly RawQuestion[] =
    raw.questions && raw.questions.length > 0
      ? raw.questions
      : raw.question != null
        ? [
            {
              question: raw.question,
              choices: raw.choices,
              multiSelect: raw.multiSelect,
              requiresReason: raw.requiresReason,
              allowDefer: raw.allowDefer,
            },
          ]
        : [];
  return { schemaVersion: 1, questions: source.map((q, index) => decodeQuestion(q, index)) };
}

// --- validation ---

export type ContractIssueCode =
  | "no_questions"
  | "too_many_questions"
  | "empty_question"
  | "missing_choices"
  | "empty_choice_label"
  | "duplicate_choice_id";

export interface ContractIssue {
  readonly code: ContractIssueCode;
  readonly message: string;
  readonly questionId?: string;
}

/**
 * Structural validation of a canonical contract: 1..5 questions, non-empty question text, choice-backed
 * single/multi-select questions, non-empty unique choice ids/labels. The host runs this before emitting
 * a request (rejecting a malformed model call); the UI can run it to refuse to render a broken group.
 */
export function validateContract(contract: ProviderQuestionContract): readonly ContractIssue[] {
  const issues: ContractIssue[] = [];
  const count = contract.questions.length;
  if (count < MIN_QUESTIONS) {
    issues.push({ code: "no_questions", message: "A question group needs at least one question." });
  }
  if (count > MAX_QUESTIONS) {
    issues.push({
      code: "too_many_questions",
      message: `A question group allows at most ${MAX_QUESTIONS} questions, got ${count}.`,
    });
  }
  for (const q of contract.questions) {
    if (q.question.trim().length === 0) {
      issues.push({ code: "empty_question", message: "Question text is empty.", questionId: q.id });
    }
    if (q.answerShape !== "free_text" && q.choices.length === 0) {
      issues.push({
        code: "missing_choices",
        message: `A ${q.answerShape} question needs at least one choice.`,
        questionId: q.id,
      });
    }
    const seen = new Set<string>();
    for (const c of q.choices) {
      if (c.label.trim().length === 0) {
        issues.push({
          code: "empty_choice_label",
          message: "Choice label is empty.",
          questionId: q.id,
        });
      }
      if (seen.has(c.id)) {
        issues.push({
          code: "duplicate_choice_id",
          message: `Duplicate choice id "${c.id}".`,
          questionId: q.id,
        });
      }
      seen.add(c.id);
    }
  }
  return issues;
}

export type AnswerIssueCode =
  | "unknown_question"
  | "unanswered_question"
  | "missing_reason"
  | "missing_selection"
  | "too_many_selected"
  | "unknown_choice"
  | "missing_text"
  | "unexpected_selection";

export interface AnswerIssue {
  readonly code: AnswerIssueCode;
  readonly message: string;
  readonly questionId?: string;
}

/**
 * Validate a user's answer against the contract it answers. Decline/cancel are always valid. An accept
 * must answer every question with a payload that matches that question's answer shape: single_choice
 * needs exactly one selection or a custom text; multi_select needs choice-backed selections; free_text
 * needs non-empty text; a deferred (allowDefer) question skips its own shape and reason checks. Every
 * non-custom selection must reference a real choice id, and a `requiresReason` question needs a reason.
 */
export function validateAnswer(
  contract: ProviderQuestionContract,
  answer: ProviderQuestionAnswer,
): readonly AnswerIssue[] {
  if (answer.action !== "accept") {
    return [];
  }
  const issues: AnswerIssue[] = [];
  const byId = new Map(answer.questions.map((a) => [a.id, a] as const));
  const known = new Set(contract.questions.map((q) => q.id));
  for (const a of answer.questions) {
    if (!known.has(a.id)) {
      issues.push({
        code: "unknown_question",
        message: `Answer for unknown question "${a.id}".`,
        questionId: a.id,
      });
    }
  }
  for (const q of contract.questions) {
    const a = byId.get(q.id);
    if (!a) {
      issues.push({
        code: "unanswered_question",
        message: "Question was not answered.",
        questionId: q.id,
      });
      continue;
    }
    if (a.defer) {
      if (!q.allowDefer) {
        issues.push({
          code: "missing_selection",
          message: "Question cannot be deferred.",
          questionId: q.id,
        });
      }
      continue;
    }
    if (q.requiresReason && (a.reason == null || a.reason.trim().length === 0)) {
      issues.push({
        code: "missing_reason",
        message: "A reason is required for this question.",
        questionId: q.id,
      });
    }
    const selected = a.selected ?? [];
    const validIds = new Set(q.choices.map((c) => c.id));
    for (const sel of selected) {
      if (!sel.custom && (sel.id == null || !validIds.has(sel.id))) {
        issues.push({
          code: "unknown_choice",
          message: `Selected choice "${sel.id ?? sel.label}" is not in this question.`,
          questionId: q.id,
        });
      }
    }
    const hasText = a.text != null && a.text.trim().length > 0;
    if (q.answerShape === "single_choice") {
      if (selected.length === 0 && !hasText) {
        issues.push({
          code: "missing_selection",
          message: "Pick one choice or enter a custom answer.",
          questionId: q.id,
        });
      }
      if (selected.length > 1) {
        issues.push({
          code: "too_many_selected",
          message: "Only one choice may be selected.",
          questionId: q.id,
        });
      }
    } else if (q.answerShape === "multi_select") {
      if (selected.length === 0 && !hasText) {
        issues.push({
          code: "missing_selection",
          message: "Select at least one choice.",
          questionId: q.id,
        });
      }
    } else {
      // free_text
      if (!hasText) {
        issues.push({ code: "missing_text", message: "Enter an answer.", questionId: q.id });
      }
      if (selected.length > 0) {
        issues.push({
          code: "unexpected_selection",
          message: "A free-text question takes no choices.",
          questionId: q.id,
        });
      }
    }
  }
  return issues;
}

// --- permissive wire decoders ---
//
// The contract + answer ride the session event log; these read them back from untrusted / forward-compat
// payloads. They never throw: unknown or missing fields become safe defaults and unknown extra metadata is
// dropped. Used by `decodeTrevorEvent` and the host runtime.

const asStr = (v: unknown): string => (typeof v === "string" ? v : "");
const asOptStr = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

function decodePreview(value: unknown): QuestionChoicePreview | undefined {
  if (typeof value === "string") {
    return value.length > 0 ? { text: value } : undefined;
  }
  const o = asRecord(value);
  if (!o) {
    return undefined;
  }
  const preview: QuestionChoicePreview = {
    ...(asOptStr(o.text) ? { text: asStr(o.text) } : {}),
    ...(asOptStr(o.viewport) ? { viewport: asStr(o.viewport) } : {}),
    ...(asOptStr(o.before) ? { before: asStr(o.before) } : {}),
    ...(asOptStr(o.after) ? { after: asStr(o.after) } : {}),
  };
  return Object.keys(preview).length > 0 ? preview : undefined;
}

function decodeChoice(value: unknown, index: number): ProviderQuestionChoice {
  const c = asRecord(value) ?? {};
  const preview = decodePreview(c.preview);
  const badges = Array.isArray(c.badges)
    ? c.badges.filter((b): b is string => typeof b === "string")
    : undefined;
  const content = asRecord(c.content);
  return {
    id: asStr(c.id) || `choice_${index + 1}`,
    label: asStr(c.label),
    ...(asOptStr(c.description) ? { description: asStr(c.description) } : {}),
    ...(preview ? { preview } : {}),
    ...(c.recommended === true ? { recommended: true } : {}),
    ...(asOptStr(c.impact) ? { impact: asStr(c.impact) } : {}),
    ...(asOptStr(c.risk) ? { risk: asStr(c.risk) } : {}),
    ...(badges && badges.length > 0 ? { badges } : {}),
    ...(content ? { content } : {}),
  };
}

function decodeQuestion(value: unknown, index: number): ProviderQuestionItem {
  const q = asRecord(value) ?? {};
  const choices = Array.isArray(q.choices) ? q.choices.map(decodeChoice) : [];
  const multiSelect = q.multiSelect === true;
  const shape = q.answerShape;
  const answerShape: ProviderQuestionAnswerShape =
    shape === "single_choice" || shape === "multi_select" || shape === "free_text"
      ? shape
      : deriveAnswerShape({ multiSelect, choices });
  return {
    id: asStr(q.id) || `question_${index + 1}`,
    question: asStr(q.question),
    answerShape,
    ...(asOptStr(q.header) ? { header: asStr(q.header) } : {}),
    ...(asOptStr(q.kind) ? { kind: asStr(q.kind) } : {}),
    multiSelect,
    requiresReason: q.requiresReason === true,
    allowDefer: q.allowDefer === true,
    choices,
  };
}

/** Decode a canonical contract off the wire, tolerating missing/garbled fields (schemaVersion fixed at 1). */
export function decodeProviderQuestionContract(value: unknown): ProviderQuestionContract {
  const v = asRecord(value) ?? {};
  const questions = Array.isArray(v.questions) ? v.questions.map(decodeQuestion) : [];
  return { schemaVersion: 1, questions };
}

function decodeSelected(value: unknown): readonly SelectedChoice[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: SelectedChoice[] = [];
  for (const raw of value) {
    const s = asRecord(raw);
    if (s) {
      out.push({
        ...(asOptStr(s.id) ? { id: asStr(s.id) } : {}),
        label: asStr(s.label),
        ...(s.custom === true ? { custom: true } : {}),
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

function decodeItemAnswer(value: unknown, index: number): QuestionItemAnswer {
  const a = asRecord(value) ?? {};
  const selected = decodeSelected(a.selected);
  const content = asRecord(a.content);
  return {
    id: asStr(a.id) || `question_${index + 1}`,
    answer: asStr(a.answer),
    ...(selected ? { selected } : {}),
    ...(asOptStr(a.text) ? { text: asStr(a.text) } : {}),
    ...(asOptStr(a.notes) ? { notes: asStr(a.notes) } : {}),
    ...(asOptStr(a.reason) ? { reason: asStr(a.reason) } : {}),
    ...(a.defer === true ? { defer: true } : {}),
    ...(content ? { content } : {}),
  };
}

/** Decode a user answer off the wire. Anything other than an explicit decline/cancel reads as an accept. */
export function decodeProviderQuestionAnswer(value: unknown): ProviderQuestionAnswer {
  const v = asRecord(value) ?? {};
  if (v.action === "decline") {
    return { action: "decline" };
  }
  if (v.action === "cancel") {
    return { action: "cancel" };
  }
  const questions = Array.isArray(v.questions) ? v.questions.map(decodeItemAnswer) : [];
  return { action: "accept", answer: asStr(v.answer), questions };
}
