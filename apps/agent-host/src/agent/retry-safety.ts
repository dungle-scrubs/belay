import type { ProviderPartialCounts } from "@trevor/session";
import type { ProviderEvent } from "../providers";

export interface RetrySafetyState {
  readonly partials: ProviderPartialCounts;
}

export function initialRetrySafetyState(): RetrySafetyState {
  return {
    partials: {
      textChars: 0,
      thinkingChars: 0,
      toolCalls: 0,
      toolResults: 0,
    },
  };
}

export function noteProviderEvent(state: RetrySafetyState, event: ProviderEvent): RetrySafetyState {
  if (event.type === "text") {
    return {
      partials: { ...state.partials, textChars: state.partials.textChars + event.text.length },
    };
  }
  if (event.type === "thinking") {
    return {
      partials: {
        ...state.partials,
        thinkingChars: state.partials.thinkingChars + event.text.length,
      },
    };
  }
  if (event.type === "tool_call") {
    return {
      partials: { ...state.partials, toolCalls: state.partials.toolCalls + 1 },
    };
  }
  return state;
}

export function noteToolResult(state: RetrySafetyState): RetrySafetyState {
  return {
    partials: { ...state.partials, toolResults: state.partials.toolResults + 1 },
  };
}

export function isSafeToRetry(state: RetrySafetyState): boolean {
  return (
    state.partials.textChars === 0 &&
    state.partials.toolCalls === 0 &&
    state.partials.toolResults === 0
  );
}

export function outputStarted(state: RetrySafetyState): boolean {
  return state.partials.textChars > 0;
}
