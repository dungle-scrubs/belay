import type { InlineAgent } from "@/transcript";

/**
 * The shared inline-agent row fixture: a running `explorer` child by default, overridable per field.
 * Imported by both `inline-agent-row.stories.tsx` and `inline-agent-row.test.tsx` so the visual
 * baseline and the behavioral tests exercise the same shape (the house override-factory idiom).
 */
export function inlineAgent(over: Partial<InlineAgent> = {}): InlineAgent {
  return {
    childSessionId: "s::sub::explorer-1",
    agent: "explorer",
    model: "qwen3-coder-30b",
    reasoningLevel: "thinking",
    startedAt: Date.now() - 12_000,
    tokens: 1240,
    status: "running",
    ...over,
  };
}
