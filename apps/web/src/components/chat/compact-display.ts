import {
  BookOpenText,
  Brain,
  ChevronRight,
  CircleX,
  CornerDownRight,
  FilePlus,
  FolderSearch,
  LoaderIcon,
  MessageCircleQuestion,
  Package,
  PencilLine,
  SearchCode,
  Stethoscope,
  Terminal,
  TriangleAlert,
  Workflow,
  Wrench,
} from "lucide-react";
import type { ElementType } from "react";
import { reconnectActionLabel } from "@/action-label";
import { truncate } from "../../derive";
import { parseToolArgs, salientToolArg } from "../../tool-args";
import {
  type AssistantMessage,
  LEGACY_RECONNECT_ATTEMPTS,
  type Message,
  reconnectDisplayDetail,
} from "../../transcript";
import { messageKindDescriptor } from "./message-kind-descriptor";
import {
  shellMessageStatus,
  type ToolStatus,
  toolMessageStatus,
  toolStatusColor,
} from "./tool-status";

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

/** A compact row's lifecycle: the tool `ToolStatus` axis plus a neutral `info` for quiet markers. */
export type CompactStatus = ToolStatus | "info";

/** The leading-icon color class for a compact status: the shared tool palette (running/done/error),
 *  plus a muted tone for the neutral `info` markers - so the compact and tool rows can't drift. */
export function compactStatusColor(status: CompactStatus): string {
  return status === "info" ? "text-muted-foreground" : toolStatusColor(status);
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
  if (message.kind === "inlineAgent") {
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
  if (staysFullInCompact(message)) {
    return null;
  }
  switch (message.kind) {
    case "user":
      return null;
    case "lucid":
      return {
        kind: "lucid",
        status: "info",
        icon: Package,
        primary: message.title,
        secondary: `Lucid artifact · v${message.version} · review in the panel`,
        hasDetail: true,
      };
    case "assistant":
      return message.text.trim().length > 0 ? null : assistantCompact(message);
    case "tool": {
      const status = toolMessageStatus(message);
      return {
        kind: "tool",
        status,
        icon: runningIcon(status, compactToolIcon(message.name)),
        primary: message.name,
        secondary: compactToolSummary(message.name, message.args),
        hasDetail: Boolean(message.result),
      };
    }
    case "result":
      return {
        kind: "result",
        status: message.ok ? "done" : "error",
        icon:
          message.command === "doctor" || message.command === "/doctor"
            ? Stethoscope
            : ChevronRight,
        primary: message.command,
        secondary: firstLine(message.text),
        hasDetail: message.text.trim().length > 0,
      };
    case "shell": {
      const status = shellMessageStatus(message);
      return {
        kind: "shell",
        status,
        icon: runningIcon(status, Terminal),
        primary: message.command,
        secondary: firstLine(message.output ?? ""),
        hasDetail: Boolean(message.output),
      };
    }
    case "recovered":
      return marker("recovered", CornerDownRight, message.action, message.detail);
    case "continued":
      return compactFromDescriptor(messageKindDescriptor(message));
    case "reconnecting":
      return {
        kind: "reconnecting",
        status: "running",
        icon: LoaderIcon,
        primary: "Reconnecting",
        secondary: `${reconnectActionLabel(
          message.attempt,
          message.maxAttempts ?? LEGACY_RECONNECT_ATTEMPTS,
        )} · ${reconnectDisplayDetail(message.detail)}`,
        hasDetail: false,
      };
    case "guardrail":
      return compactFromDescriptor(messageKindDescriptor(message));
    case "hookDecision":
      return {
        ...compactFromDescriptor(messageKindDescriptor(message)),
        icon: Workflow,
      };
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
        icon: runningIcon(status, CornerDownRight),
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
    case "modelSwitch":
      return compactFromDescriptor(messageKindDescriptor(message));
    case "limit":
      return compactFromDescriptor(messageKindDescriptor(message));
  }
  return null;
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
    icon: Brain,
    primary: message.done ? "Thought" : "Thinking",
    secondary: firstLine(message.thinking),
    hasDetail: message.thinking.trim().length > 0,
  };
}

function compactToolIcon(name: string): ElementType {
  switch (name) {
    case "read":
      return BookOpenText;
    case "glob":
      return FolderSearch;
    case "grep":
      return SearchCode;
    case "bash":
      return Terminal;
    case "edit":
    case "multi_edit":
      return PencilLine;
    case "write":
      return FilePlus;
    default:
      return Wrench;
  }
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

function compactFromDescriptor(
  descriptor: ReturnType<typeof messageKindDescriptor>,
): CompactDisplay {
  return {
    kind: descriptor.kind,
    status: descriptor.status,
    icon: descriptor.icon,
    primary: descriptor.primary,
    secondary: descriptor.secondary ? firstLine(descriptor.secondary) : null,
    hasDetail: false,
  };
}

/**
 * A tool's compact one-line summary: `multi_edit`'s file + edit count, else the tool's salient arg via
 * the shared `salientToolArg` (bash command / grep pattern / search query / fetch url / path, ...). Null
 * when there's nothing useful (a no-arg tool). Keys off the ONE `tool-args` salient registry rather than
 * a second per-tool map, so a tool's one-line summary can't read differently in a compact row than in a
 * full tool row.
 */
function compactToolSummary(name: string, args: string): string | null {
  const parsed = parseToolArgs(args);
  if (name === "multi_edit") {
    // Append the edit count onto the shared file label (the docstring above covers why the label
    // routes through the one salient registry): the compact row reads "<file(s)> · N edits".
    const label = salientToolArg(name, parsed);
    const edits = Array.isArray(parsed.edits) ? parsed.edits.length : 0;
    const parts = [
      typeof label === "string" && label ? label : null,
      edits > 0 ? `${edits} edit${edits === 1 ? "" : "s"}` : null,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : null;
  }
  const salient = salientToolArg(name, parsed);
  return typeof salient === "string" && salient ? truncate(salient, 80) : null;
}

/** The running spinner while in flight, else the row's settled icon - so a running row always reads as
 *  the spinner regardless of kind. */
function runningIcon(status: CompactStatus, settled: ElementType): ElementType {
  return status === "running" ? LoaderIcon : settled;
}

/** The first non-empty line of a blob, truncated for a one-line summary; null when empty. */
function firstLine(text: string): string | null {
  const line = text.split("\n", 1)[0]?.trim() ?? "";
  return line ? truncate(line, 80) : null;
}
