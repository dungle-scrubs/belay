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

import { toolSummary } from "./tool-args";

/** Shown when no better structured action is available (the honest, non-guessing default). */
export const FALLBACK_ACTION_LABEL = "Working";

/**
 * Squeeze a raw fragment (a path, a shell command, a query) into a single short line safe to show
 * as status: newlines/tabs collapse to single spaces and the result is capped with an ellipsis, so
 * a multiline or huge tool input can never leak into - or blow out - the label.
 */
export function redactLabelFragment(text: string, max = 48): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

/**
 * The small V2 label map: tool name -> present-progress verb. The single source of the tool
 * vocabulary that the scattered per-renderer `runningLabel` literals used to duplicate. Archive
 * tools are handled separately (their verb depends on the direction), and any unmapped tool falls
 * back to naming itself in `toolActionLabel` rather than appearing here.
 */
const TOOL_VERBS: Readonly<Record<string, string>> = {
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

function isKnownTool(name: string): boolean {
  return name in TOOL_VERBS || name.startsWith("archive");
}

/** The present-progress verb for a tool, without any argument target. */
export function toolVerb(name: string): string {
  if (name.startsWith("archive")) {
    return name === "archive_read" ? "reading archive" : "extracting archive";
  }
  return TOOL_VERBS[name] ?? "running";
}

/**
 * A tool-call action label from the structured tool name + (optional) raw args JSON. Known tools
 * read as "<verb> <salient target>" (the target is the same salient field the transcript row shows,
 * redacted to a single short line); with no args the verb stands alone. An UNKNOWN tool names itself
 * ("running frobnicate") and deliberately never runs its args through `toolSummary`, so an unmapped
 * tool can never leak raw JSON arguments into the status line.
 */
export function toolActionLabel(name: string, argsJson?: string): string {
  if (!isKnownTool(name)) {
    return name ? `running ${name}` : FALLBACK_ACTION_LABEL;
  }
  const verb = toolVerb(name);
  const summary = argsJson ? redactLabelFragment(toolSummary(name, argsJson)) : "";
  return summary ? `${verb} ${summary}` : verb;
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
