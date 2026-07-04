/**
 * Responsible for: projecting structured transcript/session state into a short present-progress
 * action label ("thinking", "applying steering", "reading apps/web/src/app.tsx", "running pnpm
 * test", "reconnecting (attempt 2/5)"). The label source is DETERMINISTIC - derived from typed
 * fields the host/web already own (turn phase, tool name + parsed args, reconnect attempt) - never
 * a fuzzy match over free-form prose. When evidence is insufficient it returns the generic
 * FALLBACK_ACTION_LABEL rather than guessing; it never returns blank and never throws.
 *
 * Not for: rendering or animation (that is `components/chat/action-shimmer.tsx`), and not for
 * parsing raw Richter event payloads (the transcript fold already decodes those). This is the one
 * home for the V2 action vocabulary, so tool renderers and the working row can't drift apart.
 */

import type { ToolName } from "@trevor/session";
import { toolSummary, truncateText } from "./tool-args";

/** Shown when no better structured action is available (the honest, non-guessing default). */
export const FALLBACK_ACTION_LABEL = "Working";

/**
 * Squeeze a raw fragment (a path, a shell command, a query, even an unrecognized tool name) into a
 * single short line safe to show as status: newlines/tabs collapse to single spaces, then the
 * result is capped with an ellipsis via the shared `truncateText` (tool-args.ts owns "cap +
 * ellipsis" once; this only owns the whitespace collapse), so a multiline or huge fragment can
 * never leak into - or blow out - the label.
 */
export function redactLabelFragment(text: string, max = 48): string {
  return truncateText(text.replace(/\s+/g, " ").trim(), max);
}

/**
 * The small V2 label map: tool name -> present-progress verb. The single source of the tool
 * vocabulary that the scattered per-renderer `runningLabel` literals used to duplicate. Keyed by
 * the shared `ToolName` contract so a typo'd or renamed key is a compile error, not a silent
 * fallback to "running". Archive tools are handled separately (their verb depends on the
 * direction) and deliberately absent here; any tool with no entry (unmapped or truly unknown) falls
 * back to naming itself in `toolActionLabel`/`toolActionLabelForTarget`.
 */
const TOOL_VERBS: Partial<Record<ToolName, string>> = {
  read: "reading",
  write: "writing",
  edit: "editing",
  multi_edit: "editing",
  bash: "running",
  grep: "searching",
  glob: "finding files",
  web_search: "searching the web",
  web_fetch: "fetching",
  docs: "looking up docs",
  session_recall: "recalling",
  skill: "running skill",
  process: "running process",
};

/**
 * Narrows a raw (possibly wire-supplied, possibly unknown/legacy) tool name to the typed
 * `ToolName` vocabulary. Used as the single gate before `toolVerb` - which is why `toolVerb` itself
 * can stay strictly `ToolName`-typed instead of bare `string`.
 */
function isKnownTool(name: string): name is ToolName {
  return name in TOOL_VERBS || name.startsWith("archive");
}

/** The present-progress verb for a KNOWN tool, without any argument target. */
function toolVerb(name: ToolName): string {
  if (name.startsWith("archive")) {
    return name === "archive_read" ? "reading archive" : "extracting archive";
  }
  return TOOL_VERBS[name] ?? "running";
}

/** Shared "verb (+ redacted target)" composition for both `toolActionLabel` entry points below. An
 *  UNKNOWN tool names itself ("running frobnicate") through the SAME redaction path as every other
 *  fragment, so a malformed/huge/newline-bearing tool name can't leak either. */
function composeToolLabel(name: string, target: string): string {
  if (!isKnownTool(name)) {
    const safeName = redactLabelFragment(name);
    return safeName ? `running ${safeName}` : FALLBACK_ACTION_LABEL;
  }
  const verb = toolVerb(name);
  const summary = target ? redactLabelFragment(target) : "";
  return summary ? `${verb} ${summary}` : verb;
}

/**
 * A tool-call action label from the structured tool name + (optional) raw args JSON. Known tools
 * read as "<verb> <salient target>" (the target is the same salient field the transcript row shows,
 * redacted to a single short line); with no args the verb stands alone. Prefer
 * `toolActionLabelForTarget` when the caller already has its own typed target string (a
 * renderer's `query`/`url`/`path` prop) rather than raw JSON, so it isn't forced into a synthetic
 * JSON round-trip.
 */
export function toolActionLabel(name: string, argsJson?: string): string {
  const target = argsJson ? toolSummary(name, argsJson) : "";
  return composeToolLabel(name, target);
}

/**
 * The lighter-weight sibling of `toolActionLabel`: takes the tool's already-resolved salient
 * target as a plain string (a renderer's own `query`/`url`/`path`/subject prop) instead of raw args
 * JSON. This is what production tool renderers (web_search/web_fetch/docs/session_recall/archive)
 * call - they already extracted their salient value in `tool-message.tsx`'s dispatch, so re-encoding
 * it as JSON just to have `toolActionLabel` decode it back out would be a pointless round-trip.
 */
export function toolActionLabelForTarget(name: string, target?: string): string {
  return composeToolLabel(name, target ?? "");
}

/** Structured evidence for the turn-level status, derived from the active assistant segment. */
export interface TurnActionEvidence {
  /** The model is loaded/warm; a cold start is still bringing weights up. */
  readonly warm: boolean;
  /** The active model ref, used only for the cold-start "loading <model>" label. */
  readonly model: string;
  /** The turn has already emitted assistant text (streaming) vs. silent (thinking). */
  readonly streaming: boolean;
  /** A steering prompt was folded into the active turn (D-001). */
  readonly steering?: boolean;
}

/** The turn-level action label: steering wins, then cold-start load, then streaming vs thinking. */
export function turnActionLabel(evidence: TurnActionEvidence): string {
  if (evidence.steering) {
    return "applying steering";
  }
  if (!evidence.warm) {
    return evidence.model ? `loading ${evidence.model}` : FALLBACK_ACTION_LABEL;
  }
  return evidence.streaming ? "streaming" : "thinking";
}

/** The transport-recovery status while the socket re-attaches to a live turn. */
export function reconnectActionLabel(attempt: number, maxAttempts: number): string {
  return `reconnecting (attempt ${attempt}/${maxAttempts})`;
}

/** The host reclaimed context after an overflow and is retrying the turn. */
export const RECOVERY_ACTION_LABEL = "recovering context";

/** A fold is compacting the transcript to reclaim context. */
export function compactionActionLabel(): string {
  return "compacting context";
}
