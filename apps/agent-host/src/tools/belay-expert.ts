import { Schema } from "effect";
import { answerExpertQuery, BELAY_EXPERT_DESCRIPTION, BELAY_EXPERT_NAME } from "../manifest/expert";
import { simpleTool } from "./shared";

/**
 * The built-in `belay_expert` model-facing tool (plan 14, M8). Its DEF is the discovery metadata - the
 * model sees the tool exists and when to use it (the description), but the capability manifest is loaded
 * ONLY when the tool is called with a question, never dumped into every prompt. On call it routes the
 * question to the few relevant manifest sections and returns their bounded, redacted export slices
 * (`../manifest/expert`), read through the gate-independent direct export path.
 *
 * READ-ONLY and DIAGNOSTIC: it describes Belay's own capabilities and never inspects the user's code,
 * mutates state, grants a permission, or starts work - so the loop may run it concurrently with other reads.
 *
 * Responsible for: the belay_expert tool - answering capability questions from bounded,
 * redacted manifest export slices.
 */

const Params = Schema.Struct({
  question: Schema.String.annotations({
    description:
      "The question about Belay's own capabilities to answer from its capability manifest.",
  }),
});

export const belayExpertTool = simpleTool({
  name: BELAY_EXPERT_NAME,
  description: BELAY_EXPERT_DESCRIPTION,
  params: Params,
  readOnly: true,
  capped: true,
  execute: ({ question }) => answerExpertQuery(question),
});
