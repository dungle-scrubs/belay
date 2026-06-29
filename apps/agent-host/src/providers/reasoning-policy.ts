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
 * The decision is keyed on the MODEL DESCRIPTOR, not a Trevor-maintained adapter-id set:
 * `thinkingLevelMap.off` is the source of truth for adapters that accept an explicit off effort
 * ("none", provider-specific strings, etc.). Toggle-style adapters omit that map entry and disable
 * reasoning on a falsy effort, so "off" stays undefined there. Codex Responses is the compatibility
 * exception: pi-ai's adapter accepts "none", but the 0.80.2 descriptor has not grown `off: "none"`
 * yet, so the fallback is isolated here until the descriptor catches up.
 *
 * Every non-"off" level goes through pi-ai's own per-model `clampThinkingLevel` unchanged, so each of
 * the hundreds of models keeps its native level menu + remapping. The net difference vs `streamSimple`
 * is exactly the graded-family "off" case.
 */

/**
 * The default reasoning level to advertise/stream at for a surface, given its resolved level menu:
 * prefer "medium", then "high", then "off", then the lowest available, else "off" when there are no
 * levels at all. The ONE owner of this preference - the catalog default, the per-turn default, and
 * every pi-ai adapter (codex/anthropic/pi-key) all derive from it, so a model's catalog default can't
 * disagree with the level it actually streams at. An adapter passes its own `pickDefaultReasoning`
 * only when it genuinely wants a different preference.
 */
export function defaultReasoningLevel(levels: readonly string[]): string {
  if (levels.length === 0) {
    return "off";
  }
  return (
    (levels.includes("medium") && "medium") ||
    (levels.includes("high") && "high") ||
    (levels.includes("off") && "off") ||
    levels[0] ||
    "off"
  );
}

/**
 * The explicit effort value that disables reasoning for this model, when its descriptor says one
 * exists. Undefined means omit `reasoningEffort`; that is how toggle-style adapters disable thinking.
 */
export function explicitOffEffortFor<TApi extends Api>(model: Model<TApi>): string | undefined {
  const off = model.thinkingLevelMap?.off;
  if (typeof off === "string") {
    return off;
  }
  if (off === null) {
    return undefined;
  }
  return model.api === "openai-codex-responses" ? "none" : undefined;
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
    return explicitOffEffortFor(model);
  }
  // Any real level: pi-ai's per-model clamp (stream() then remaps it via the model's thinkingLevelMap).
  return clampThinkingLevel(model, level as ThinkingLevel);
}

/**
 * The reasoning fields to SPREAD into pi-ai's `stream()` options for `level` on `model`: either
 * `{ reasoningEffort }` or `{}`. The omit is itself a policy decision, not pi-ai's concern - when
 * `reasoningEffortFor` returns undefined (an absent level, or "off" on a toggle adapter), the
 * parameter must be left OFF the request entirely. Spreading an explicit `reasoningEffort: undefined`
 * instead would, on a toggle adapter, read as a present-but-falsy effort - so keeping it absent is
 * what actually disables reasoning there. pi-ai.ts just spreads the result.
 */
export function reasoningStreamFields<TApi extends Api>(
  model: Model<TApi>,
  level: string | undefined,
): { reasoningEffort?: string } {
  const reasoningEffort = reasoningEffortFor(model, level);
  return reasoningEffort !== undefined ? { reasoningEffort } : {};
}
