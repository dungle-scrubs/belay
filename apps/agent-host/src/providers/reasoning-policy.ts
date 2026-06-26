import {
  type Api,
  clampThinkingLevel,
  type Model,
  type ThinkingLevel,
} from "@earendil-works/pi-ai/compat";

/**
 * The ONE place that decides what `reasoningEffort` to hand pi-ai's lower-level `stream()` for a
 * given model + requested level. It compensates for a pi-ai gap we can't fix upstream: `streamSimple`
 * collapses "off" into an OMITTED parameter, which on a graded-effort model (the OpenAI Responses
 * family) means "use the model default" (medium for GPT-5.5), NOT "disable" - so "off" silently runs
 * at medium there. We stream through `stream()` and decide the effort here instead.
 *
 * The decision is keyed on the ADAPTER (`model.api`), not the model: pi-ai exposes hundreds of models
 * but only a handful of api adapters, and "how do I turn reasoning off" is an adapter property. So
 * this scales without per-model curation, and it's the only model-family knowledge Trevor keeps -
 * deliberately isolated here so it never leaks into the streaming path and is trivial to delete if
 * pi-ai ever makes `streamSimple` disable correctly per model.
 *
 *   - GRADED reasoning APIs (OpenAI Responses family): a graded `reasoning_effort` where OMITTING it
 *     defaults the model, so "off" must be sent as an explicit "none" to truly disable.
 *   - everything else (TOGGLE family - openai-completions, anthropic-messages, …): thinking is on/off
 *     from a TRUTHY effort, so "off" must stay undefined ("none" would read as ENABLED there). This is
 *     also the default for an UNKNOWN adapter - the safe choice, since omitting can never break a
 *     request, where a wrong "none" could.
 *
 * Every non-"off" level goes through pi-ai's own per-model `clampThinkingLevel` unchanged, so each of
 * the hundreds of models keeps its native level menu + remapping. The net difference vs `streamSimple`
 * is exactly the graded-family "off" case.
 */

/**
 * OpenAI "Responses"-family adapters: a graded `reasoning_effort` where OMITTING the parameter falls
 * back to the model's default instead of disabling. These are the only adapters where "off" needs an
 * explicit "none". Add a new Responses-style adapter id here if pi-ai introduces one.
 */
const GRADED_REASONING_APIS: ReadonlySet<string> = new Set([
  "openai-codex-responses",
  "openai-responses",
  "azure-openai-responses",
]);

/** True when a model's adapter takes a graded reasoning_effort (omit = default, not disabled). */
export function isGradedReasoningModel<TApi extends Api>(model: Model<TApi>): boolean {
  return GRADED_REASONING_APIS.has(model.api);
}

/**
 * The `reasoningEffort` to send to pi-ai's `stream()` for `level` on `model`, or undefined to omit
 * the parameter. `level` is a plain string (not `ThinkingLevel`) because "off" rides in at runtime
 * even though it isn't in the `ThinkingLevel` union.
 */
export function reasoningEffortFor<TApi extends Api>(
  model: Model<TApi>,
  level: string | undefined,
): string | undefined {
  if (!level) {
    return undefined; // no level chosen -> let the model use its own default
  }
  if (level === "off") {
    // Disable intent: a graded model needs an explicit "none"; a toggle model disables on a falsy
    // effort (and would be wrongly ENABLED by "none").
    return isGradedReasoningModel(model) ? "none" : undefined;
  }
  // Any real level: pi-ai's per-model clamp (stream() then remaps it via the model's thinkingLevelMap).
  return clampThinkingLevel(model, level as ThinkingLevel);
}
