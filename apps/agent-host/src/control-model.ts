import type { ModelRef } from "@trevor/session";

/**
 * The model a host-issued control prompt (auto-continue after a step-cap pause, retry, compact-then-
 * continue) should run on: the most recent turn that carried an explicit catalog {@link ModelRef},
 * scanned newest-first.
 *
 * Without this, a control prompt only forwarded a bare legacy `provider` STRING set to the paused
 * turn's source id (e.g. `"zai"`). A catalog source id is NOT a registered legacy provider key
 * (those are `qwen`/`glm`/`deepseek`/…), so `pickProvider` did not recognize it and fell back to the
 * DEFAULT provider - which is how a paused `glm-5.2` turn silently resumed on the local default model
 * (`unsloth/qwen3.6-27b-mlx`) and then stalled. Carrying the ModelRef makes the host resolve the SAME
 * model the user selected (its `sourceId`/`modelId` round-trip through `buildSourceProvider`).
 *
 * Returns undefined for a legacy, provider-string-only session (no turn ever carried a ModelRef); the
 * caller then keeps the existing provider-string path, which resolves a real provider key correctly.
 */
export function controlPromptModel(
  turns: readonly { readonly model?: ModelRef }[],
): ModelRef | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const model = turns[index]?.model;
    if (model) {
      return model;
    }
  }
  return undefined;
}
