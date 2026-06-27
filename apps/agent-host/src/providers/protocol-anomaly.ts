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

interface ProviderRule {
  readonly providers: readonly string[];
  readonly reason: string;
  readonly retryable: boolean;
  readonly patterns: readonly RegExp[];
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

const TOOL_JSON_PATTERN = /["'](?:tool_call|tool_calls|function_call|arguments|name)["']\s*:/i;

const RULES: readonly ProviderRule[] = [
  {
    providers: ["deepseek"],
    reason: "DeepSeek rendered raw tool-call markup instead of emitting a tool call",
    retryable: true,
    patterns: [...TOOL_TAG_PATTERNS, TOOL_JSON_PATTERN],
  },
  {
    providers: ["glm"],
    reason: "GLM rendered tool-call JSON or tags as assistant text",
    retryable: true,
    patterns: [...TOOL_TAG_PATTERNS, TOOL_JSON_PATTERN],
  },
  {
    providers: ["minimax"],
    reason: "MiniMax rendered tool-call JSON or tags as assistant text",
    retryable: true,
    patterns: [...TOOL_TAG_PATTERNS, TOOL_JSON_PATTERN],
  },
  {
    providers: ["qwen", "qwen4bit"],
    reason: "LM Studio rendered tool-call JSON or tags as assistant text",
    retryable: true,
    patterns: [...TOOL_TAG_PATTERNS, TOOL_JSON_PATTERN],
  },
  {
    providers: ["gpt"],
    reason: "Codex rendered tool-call JSON or tags as assistant text",
    retryable: true,
    patterns: [...TOOL_TAG_PATTERNS, TOOL_JSON_PATTERN],
  },
];

function providerRules(providerId: string): readonly ProviderRule[] {
  return RULES.filter((rule) => rule.providers.includes(providerId));
}

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
  for (const rule of providerRules(input.providerId)) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      return {
        phase: "model-step",
        reason: rule.reason,
        retryable: rule.retryable,
      };
    }
  }
  return null;
}
