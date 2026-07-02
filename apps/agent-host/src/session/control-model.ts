import { decodeTrevorEvent, type ModelRef, type SessionEvent } from "@trevor/session";

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

/**
 * The legacy provider STRING a host-issued control prompt should resume on: the most recent REAL user
 * turn's `provider`, scanned newest-first, SKIPPING the host's own control prompts (`control: true`). The
 * skip is load-bearing - a prior control prompt is itself stamped with the compaction provider, so
 * without it the scan would re-inherit that and defeat the fix.
 *
 * This is the fallback BELOW {@link controlPromptModel}: a turn that carried an explicit catalog ModelRef
 * resumes on that; a legacy provider-string-only turn resumes on this provider; only a session with no
 * real user turn at all falls through (undefined) to the caller's compaction/default. Without it, a
 * paused turn whose only record was a bare `provider` string (e.g. `"gpt"`, no ModelRef) resumed on the
 * host's LOCAL default model - the 02.13 downgrade-to-qwen bug. <!-- D-001 D-002 -->
 */
export function controlPromptProvider(
  turns: readonly { readonly provider?: string; readonly control?: boolean }[],
): string | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.control) {
      continue;
    }
    const provider = turn?.provider?.trim();
    if (provider) {
      return provider;
    }
  }
  return undefined;
}

/** One `user.message` turn projected for control-prompt model/provider recovery. */
export interface ControlTurn {
  readonly provider?: string;
  readonly model?: ModelRef;
  /** True when this is one of the host's OWN control prompts (producer === `controlProducerId`). */
  readonly control: boolean;
}

/**
 * Projects the `user.message` turns from a session log (oldest→newest) into the shape the control-prompt
 * resolvers scan, tagging each with whether it is one of the host's own control prompts. Pulling this off
 * the raw log here (rather than in main.ts) keeps the whole resume-model resolution - including the
 * control-producer skip the provider fallback depends on - unit-testable from real events. <!-- D-002 -->
 */
export function buildControlTurns(
  events: readonly SessionEvent[],
  controlProducerId: string,
): ControlTurn[] {
  const turns: ControlTurn[] = [];
  for (const event of events) {
    const decoded = decodeTrevorEvent(event);
    if (decoded?.type === "user.message") {
      turns.push({
        provider: decoded.provider,
        model: decoded.model,
        control: event.producerId === controlProducerId,
      });
    }
  }
  return turns;
}
