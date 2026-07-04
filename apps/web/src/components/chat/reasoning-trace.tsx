"use client";

import { ReasoningGroup } from "@/components/assistant-ui/reasoning";
import { MarkdownBody } from "@/components/chat/markdown-body";

/** The visible trigger copy, kept stable as `thinking` across every reasoning surface (plan 35 M5). */
const REASONING_LABEL = "thinking";

/**
 * A pure one-line projection of a reasoning trace for a compact transcript (plan 05 / plan 27): the
 * stable label, the line count, and whether it is actively streaming. Kept presentation-only so plan
 * 27 can build its compact row without re-deriving the shape here. <!-- plan 35 M5 -->
 */
export function reasoningTraceSummary(
  content: string,
  streaming = false,
): { readonly label: string; readonly lines: number; readonly active: boolean } {
  const trimmed = content.trim();
  return {
    label: REASONING_LABEL,
    lines: trimmed ? trimmed.split("\n").length : 0,
    active: streaming,
  };
}

export interface ReasoningTraceProps {
  /** The accumulated thinking/reasoning text (the `assistant.thinking` string). */
  readonly content: string;
  /**
   * Whether the reasoning is actively streaming. Auto-opens the trace with a live bottom-pinned
   * preview and shimmering trigger; auto-collapses when it flips false - unless the user has toggled
   * it manually, in which case their choice wins permanently (behavior owned by `ReasoningGroup`).
   */
  readonly streaming?: boolean;
  /** Initial open state once settled (auto-mode). Defaults to collapsed - reasoning is secondary. */
  readonly defaultOpen?: boolean;
  /** Controlled open state (parent owns the disclosure); pairs with `onOpenChange`. */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /**
   * Compact transcript affordance (plan 27): render the trace as a single collapsed line that carries
   * the label, a line count, and the active indicator. The affordance only; plan 27 owns wiring the
   * global compact toggle. <!-- plan 35 M5 -->
   */
  readonly compact?: boolean;
}

/**
 * The ghosted reasoning trace: the assistant's `assistant.thinking` string rendered through the shared
 * `ReasoningGroup` disclosure - muted, visually secondary to the answer, collapsible, and streaming-
 * aware. It replaces the flat `ThinkingMessage` (plan 35). The transcript gates it behind `showThinking`
 * and derives `streaming` locally; this component owns only presentation + disclosure state.
 *
 * Scroll safety (plan 12.2): auto-open/collapse never writes the transcript viewport. `ReasoningGroup`
 * animates height under the shared `useScrollLock` anchor (net-zero viewport movement, the same
 * mechanism the transcript's tool disclosures already use), and the streaming preview pins only the
 * trace's own internal scroll box - so the no-yank invariant the follow controller owns is untouched.
 */
export function ReasoningTrace({
  content,
  streaming = false,
  defaultOpen = false,
  open,
  onOpenChange,
  compact = false,
}: ReasoningTraceProps) {
  // Nothing to disclose yet and nothing streaming in: render nothing rather than an empty trigger.
  if (!content.trim() && !streaming) {
    return null;
  }

  const label = compact ? compactLabel(content, streaming) : REASONING_LABEL;

  return (
    <ReasoningGroup
      variant="ghost"
      className="mb-0 w-full"
      label={label}
      streaming={streaming}
      defaultOpen={defaultOpen}
      open={open}
      onOpenChange={onOpenChange}
    >
      <MarkdownBody text={content} muted />
    </ReasoningGroup>
  );
}

/** The compact trigger copy: the live label while streaming, else `thinking · N lines`. */
function compactLabel(content: string, streaming: boolean): string {
  const { label, lines } = reasoningTraceSummary(content, streaming);
  if (streaming || lines === 0) {
    return label;
  }
  return `${label} · ${lines} ${lines === 1 ? "line" : "lines"}`;
}
