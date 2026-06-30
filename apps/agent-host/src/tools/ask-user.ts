import { normalizeAskUserInput, type RawAskUserInput } from "@trevor/session";
import { Schema } from "effect";
import { providerQuestionRuntime } from "../agent/provider-questions";
import type { Tool, ToolContext } from "./types";

/**
 * `ask_user` (V1 parity - the model-facing name MUST stay `ask_user`, never `ask_user_question`): pause
 * the active turn to put a concrete decision to the user, then resume with their answer as the tool
 * result. The tool only shapes + validates the question; the blocking, the request/answer events, and
 * the resolution live in the generic `providerQuestionRuntime` (agent/provider-questions.ts).
 *
 * The schema accepts both the legacy single-question form (`question` + `choices`) and the rich grouped
 * form (`questions[]`); `normalizeAskUserInput` (shared) coerces either into the canonical contract.
 * Choice structs are inlined per use so the derived JSON Schema stays flat (no `$defs`); previews are
 * plain ASCII strings on the model boundary.
 */

const choiceFields = {
  id: Schema.optional(Schema.String),
  label: Schema.String,
  description: Schema.optional(Schema.String),
  preview: Schema.optional(Schema.String),
  recommended: Schema.optional(Schema.Boolean),
  impact: Schema.optional(Schema.String),
  risk: Schema.optional(Schema.String),
  badges: Schema.optional(Schema.Array(Schema.String)),
} as const;

const questionFields = {
  id: Schema.optional(Schema.String),
  question: Schema.String,
  header: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  multiSelect: Schema.optional(Schema.Boolean),
  requiresReason: Schema.optional(Schema.Boolean),
  allowDefer: Schema.optional(Schema.Boolean),
  choices: Schema.optional(Schema.Array(Schema.Struct(choiceFields))),
} as const;

const Params = Schema.Struct({
  // Legacy single-question form.
  question: Schema.optional(Schema.String),
  choices: Schema.optional(Schema.Array(Schema.Struct(choiceFields))),
  multiSelect: Schema.optional(Schema.Boolean),
  requiresReason: Schema.optional(Schema.Boolean),
  allowDefer: Schema.optional(Schema.Boolean),
  // Rich grouped form (1..5 questions); wins over the legacy fields when present.
  questions: Schema.optional(Schema.Array(Schema.Struct(questionFields))),
});

type AskUserParams = typeof Params.Type;

const DESCRIPTION =
  "Ask the user 1 to 5 questions and block until they answer, then continue this same run with their " +
  "answer as the tool result. Call this ONLY when a concrete missing decision blocks useful progress - " +
  "not to gather broad preferences. Prefer concrete choices (each with a short label, optional " +
  "description, and which one you recommend) over free-form questions. Use the grouped `questions` form; " +
  "set `multiSelect` for pick-many, `requiresReason` to force a justification, and `allowDefer` to let " +
  "the user skip one. Choice `preview` is plain ASCII text (e.g. a small layout mock). Your `choices` " +
  "are shown to the user as a NUMBERED list in the order you give them (1, 2, 3…), so the user may " +
  'answer by number (e.g. "choose 1 and 3") - map any such numbers back to your choices by that position.';

export const askUserTool: Tool<AskUserParams> = {
  name: "ask_user",
  description: DESCRIPTION,
  // Not readOnly: it blocks the turn for a user decision, so it runs as a serial barrier (never batched).
  params: Params,
  execute: (args: AskUserParams, ctx?: ToolContext) =>
    providerQuestionRuntime.ask(
      normalizeAskUserInput(args as RawAskUserInput),
      ctx?.runId ?? "",
      ctx?.callId ?? "",
    ),
};
