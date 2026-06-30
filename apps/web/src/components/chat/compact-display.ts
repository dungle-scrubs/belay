import {
  ChevronRight,
  CircleX,
  CornerDownRight,
  LoaderIcon,
  MessageCircleQuestion,
  ShieldAlert,
  Sparkles,
  Terminal,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import type { ElementType } from "react";
import { toolSummary, truncate } from "../../derive";
import type { AssistantMessage, Message } from "../../transcript";
import { toolMessageStatus } from "./tool-status";

/**
 * The compact transcript display contract (plan 05): a pure, presentation-only projection that maps a
 * non-primary transcript message to the one-line row the compact mode renders - a status, an icon, a
 * primary label, an optional secondary summary, and whether a detail/expand affordance applies. It is
 * deliberately separate from the durable transcript semantics (`toTranscript` / event decoding); it
 * only reshapes already-projected `Message`s for display, so toggling compact mode never touches the
 * session log, provider history, or row identity.
 *
 * Primacy rule: user prompts and the final assistant RESPONSE (an assistant segment that produced
 * visible text) stay fully rendered even in compact mode - `compactDisplayFor` returns null for them.
 * Everything else (thinking-only segments, tools, command/shell results, recovery/status markers,
 * delegation, questions) collapses to a `CompactDisplay`.
 */

/** A compact row's lifecycle, reusing the tool `ToolStatus` axis plus a neutral `info` for quiet markers. */
export type CompactStatus = "running" | "done" | "error" | "info";

/** The one status -> icon color map for compact rows (the SMUI palette), so every compact row tints its
 *  leading icon the same way. Extends the tool `running/done/error` colors with a muted `info`. */
const COMPACT_STATUS_COLOR: Record<CompactStatus, string> = {
  running: "text-smui-yellow",
  done: "text-smui-frost-3",
  error: "text-smui-red",
  info: "text-muted-foreground",
};

/** The leading-icon color class for a compact status. */
export function compactStatusColor(status: CompactStatus): string {
  return COMPACT_STATUS_COLOR[status];
}

/** The one-line display descriptor for a compacted transcript row. */
export interface CompactDisplay {
  /** The source message kind (never "user" - those stay full). */
  readonly kind: Message["kind"];
  readonly status: CompactStatus;
  /** The leading icon (a lucide component); a running row always shows the spinner. */
  readonly icon: ElementType;
  /** The primary label (tool/command name, marker title). */
  readonly primary: string;
  /** A muted secondary summary (the tool's target, a result's first line), or null when there is none. */
  readonly secondary: string | null;
  /** Whether the row has expandable detail (a result/output/thinking trace) worth an affordance. */
  readonly hasDetail: boolean;
}

/**
 * Whether a message renders FULL even in compact mode: user prompts always, and an assistant segment
 * that produced visible text (the final response). A text-less assistant segment (thinking-only,
 * error-only, no-reply) is NOT a response and compacts.
 */
export function staysFullInCompact(message: Message): boolean {
  if (message.kind === "user") {
    return true;
  }
  if (message.kind === "assistant") {
    return message.text.trim().length > 0;
  }
  return false;
}

/** Whether a message collapses to a one-line compact row (the inverse of {@link staysFullInCompact}). */
export function isCompactEligible(message: Message): boolean {
  return !staysFullInCompact(message);
}

/** The compact one-line descriptor for a message, or null when it stays fully rendered. */
export function compactDisplayFor(message: Message): CompactDisplay | null {
  switch (message.kind) {
    case "user":
      return null;
    case "assistant":
      return message.text.trim().length > 0 ? null : assistantCompact(message);
    case "tool": {
      const status = toolMessageStatus(message);
      return {
        kind: "tool",
        status,
        icon: status === "running" ? LoaderIcon : Wrench,
        primary: message.name,
        secondary: toolSummary(message.name, message.args) || null,
        hasDetail: Boolean(message.result),
      };
    }
    case "result":
      return {
        kind: "result",
        status: message.ok ? "done" : "error",
        icon: ChevronRight,
        primary: message.command,
        secondary: firstLine(message.text),
        hasDetail: message.text.trim().length > 0,
      };
    case "shell": {
      const status = !message.done ? "running" : message.ok === false ? "error" : "done";
      return {
        kind: "shell",
        status,
        icon: status === "running" ? LoaderIcon : Terminal,
        primary: message.command,
        secondary: firstLine(message.output ?? ""),
        hasDetail: Boolean(message.output),
      };
    }
    case "recovered":
      return marker("recovered", CornerDownRight, message.action, message.detail);
    case "continued":
      return marker("continued", CornerDownRight, "Continued", message.detail);
    case "reconnecting":
      return {
        kind: "reconnecting",
        status: "running",
        icon: LoaderIcon,
        primary: "Reconnecting",
        secondary: `attempt ${message.attempt}${message.maxAttempts ? `/${message.maxAttempts}` : ""}`,
        hasDetail: false,
      };
    case "guardrail":
      return marker("guardrail", ShieldAlert, `Guardrail: ${message.tool}`, message.reason);
    case "compacting":
      return {
        kind: "compacting",
        status: "running",
        icon: LoaderIcon,
        primary: "Compacting",
        secondary: `${message.tokens}/${message.budget} tokens`,
        hasDetail: false,
      };
    case "delegation": {
      const status =
        message.status === "running" ? "running" : message.status === "failed" ? "error" : "done";
      return {
        kind: "delegation",
        status,
        icon: status === "running" ? LoaderIcon : CornerDownRight,
        primary: message.agent,
        secondary: firstLine(message.task),
        hasDetail: Boolean(message.result),
      };
    }
    case "question":
      return {
        kind: "question",
        status: "done",
        icon: MessageCircleQuestion,
        primary: "Asked",
        secondary: firstLine(message.summary),
        hasDetail: message.items.length > 0,
      };
  }
}

/** The compact row for a text-less assistant segment: an error, a terminal non-answer, or thinking. */
function assistantCompact(message: AssistantMessage): CompactDisplay {
  if (message.error || message.diagnostic) {
    return {
      kind: "assistant",
      status: "error",
      icon: TriangleAlert,
      primary: "Error",
      secondary: firstLine(message.error ?? ""),
      hasDetail: Boolean(message.error),
    };
  }
  const terminal = message.cancelled
    ? "Cancelled"
    : message.interrupted
      ? "Interrupted"
      : message.noReply
        ? "No reply"
        : message.stepLimit
          ? "Step limit reached"
          : null;
  if (terminal) {
    return {
      kind: "assistant",
      status: "info",
      icon: CircleX,
      primary: terminal,
      secondary: null,
      hasDetail: false,
    };
  }
  // A thinking-only segment: still streaming (running) or a settled thought before a tool/response.
  return {
    kind: "assistant",
    status: message.done ? "info" : "running",
    icon: message.done ? Sparkles : LoaderIcon,
    primary: message.done ? "Thought" : "Thinking",
    secondary: firstLine(message.thinking),
    hasDetail: message.thinking.trim().length > 0,
  };
}

/** A quiet status marker (recovered / continued / guardrail): info-toned, no expandable detail. */
function marker(
  kind: Message["kind"],
  icon: ElementType,
  primary: string,
  detail: string,
): CompactDisplay {
  return { kind, status: "info", icon, primary, secondary: firstLine(detail), hasDetail: false };
}

/** The first non-empty line of a blob, truncated for a one-line summary; null when empty. */
function firstLine(text: string): string | null {
  const line = text.split("\n", 1)[0]?.trim() ?? "";
  return line ? truncate(line, 80) : null;
}
