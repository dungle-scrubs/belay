/**
 * Responsible for: detecting tool-call markup leaked into assistant text and classifying it as a
 * retryable protocol anomaly for the providers known to exhibit it.
 */
import type { ToolCall } from "./types";

export interface ProviderProtocolDiagnostic {
  readonly phase: "model-step";
  readonly reason: string;
  readonly retryable: boolean;
}

export interface ProtocolAnomalyInput {
  readonly providerId: string;
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
}

const TOOL_TAG_PATTERNS = [
  /<\s*tool[_-]?call\b/i,
  /<\s*\/\s*tool[_-]?call\s*>/i,
  /<\|tool[_-]?calls?\|>/i,
  /<\|\/tool[_-]?calls?\|>/i,
  /<｜tool[＿_▁]?calls?｜>/i,
  /<｜\/tool[＿_▁]?calls?｜>/i,
  /DSML\s*\|\s*\|\s*tool[_-]?calls?/i,
  /DSML\s*\|\s*\|\s*invoke\s+name\s*=/i,
  /DSML\s*\|\s*\|\s*parameter\s+name\s*=/i,
] as const;

// Only the UNAMBIGUOUS tool-call envelope keys. `name`/`arguments` are left out on purpose: they
// appear in ordinary JSON the model legitimately quotes (a package manifest, a config snippet), so
// matching them would flag prose as a protocol leak. A real bare-JSON leak still carries one of these
// envelope keys; a tagged leak is caught by TOOL_TAG_PATTERNS regardless.
const TOOL_JSON_PATTERN = /["'](?:tool_call|tool_calls|function_call)["']\s*:/i;

/** Every pattern that means "tool-call markup leaked into assistant text"; one set for all providers. */
const ANOMALY_PATTERNS = [...TOOL_TAG_PATTERNS, TOOL_JSON_PATTERN] as const;

/**
 * The providers that exhibit this anomaly, mapped to the display name templated into the (otherwise
 * identical) diagnostic reason. The detection is the same retryable rule for every provider - only
 * the name in the message differs - so adding a provider is one entry here, not a new rule that could
 * drift in its pattern set. A provider absent from this map never produces an anomaly diagnostic.
 */
const ANOMALY_PROVIDER_NAMES: Record<string, string> = {
  deepseek: "DeepSeek",
  glm: "GLM",
  minimax: "MiniMax",
  qwen: "LM Studio",
  qwen4bit: "LM Studio",
  gpt: "Codex",
};

export function classifyProviderProtocolAnomaly(
  input: ProtocolAnomalyInput,
): ProviderProtocolDiagnostic | null {
  if (input.toolCalls.length > 0) {
    return null;
  }
  const text = input.text.trim();
  if (!text) {
    return null;
  }
  const name = ANOMALY_PROVIDER_NAMES[input.providerId];
  if (!name || !ANOMALY_PATTERNS.some((pattern) => pattern.test(text))) {
    return null;
  }
  return {
    phase: "model-step",
    reason: `${name} rendered tool-call JSON or tags as assistant text`,
    retryable: true,
  };
}
