import type { ProviderModel } from "./protocol";

/**
 * The canonical provider roster: each selectable provider's key, display label, and
 * thinking options. This is the single source the host's provider registry takes its
 * labels from and the web renders before the host announces itself (host.online), so the
 * pre-announce UI and the host cannot disagree on which providers exist or what they are
 * called. The `model` field is a display placeholder; the host substitutes the real,
 * env-overridable model id when it announces.
 */
export const DEFAULT_PROVIDER_MODELS = {
  qwen: {
    label: "Qwen 27B 8-bit (local)",
    model: "qwen",
    reasoningLevels: ["off", "on"],
    defaultReasoning: "off",
  },
  gpt: {
    label: "GPT-5.5",
    model: "GPT-5.5",
    reasoningLevels: ["minimal", "low", "medium", "high", "xhigh"],
    defaultReasoning: "medium",
  },
  qwen4bit: {
    label: "Qwen 27B 4-bit (local)",
    model: "qwen",
    reasoningLevels: ["off", "on"],
    defaultReasoning: "off",
  },
} satisfies Record<string, ProviderModel>;
