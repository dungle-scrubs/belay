import type { ArtifactRef } from "@trevor/session";
import { isErrorResult, type ToolStatus, toolMessageStatus } from "@/components/chat/tool-status";
import type { Message, ShellMessage, ToolMessage } from "@/transcript";

/**
 * The data contract for the tool detail takeover (plan 08): a normalized, render-ready view of one
 * transcript tool (or bang-shell-lane) row, projected from the transcript fold. It is a SUPERSET of what
 * a row carries today (name / args / status / output) plus reserved fields for the richer detail the
 * tool boundary will carry later - per-call timing, streaming/progress, artifacts, and redaction - all
 * optional, so the model stays stable while later milestones populate them. Pure data; the detail
 * surface renders it, and the live model is re-derived from session events (never a stale snapshot).
 */
export interface ToolDetailModel {
  /** Stable identity = the source transcript row's id (the host callId / shell requestId), so the
   *  takeover can reopen + restore focus/scroll to the originating row on close. */
  readonly id: string;
  /** The kind of the source row, so the surface frames a shell run differently from a tool call. */
  readonly source: "tool" | "shell";
  /** The tool name (or "shell" for the bang lane); an unknown / MCP name passes through verbatim. */
  readonly toolName: string;
  readonly status: ToolStatus;
  /** True when the run aborted before the tool finished (cancel / interrupt) - shown as aborted, not done. */
  readonly aborted: boolean;
  /** The raw argument JSON for a tool row, or the command line for a shell row. */
  readonly args: string;
  /** The tool's rendered output / the shell output, once it has landed. */
  readonly output?: string;
  /** The failure text when the row is in the error state (the `error:` convention, or an aborted run). */
  readonly error?: string;
  /** Per-call timing, when the tool boundary carries it (absent today). */
  readonly timing?: { readonly startedAt?: number; readonly endedAt?: number };
  /** Incremental stream / progress chunks, when available (no streaming today; reserved for M6). */
  readonly stream?: readonly string[];
  /** Related artifacts / blobs, when relevant (none on tool rows today; reserved). */
  readonly artifacts?: readonly ArtifactRef[];
  /** Whether any field was redacted by the guardrail layer (reserved). */
  readonly redacted?: boolean;
}

/**
 * Transcript rows that can open a detail takeover: tool calls (any name, including unknown / MCP) and
 * the bang-shell lane. User prompts, ordinary assistant responses, command results, and status markers
 * are NOT first-cut detail targets - they carry no deeper inspection surface than the row already shows.
 */
export function isDetailEligible(message: Message): boolean {
  return message.kind === "tool" || message.kind === "shell";
}

/**
 * Projects an eligible transcript row to its detail model, or null for a non-eligible row. Pure - it
 * reads only the row (no coupling to the compact-row summaries), so the detail surface and the compact
 * transcript stay independent.
 */
export function toToolDetailModel(message: Message): ToolDetailModel | null {
  if (message.kind === "tool") {
    return fromTool(message);
  }
  if (message.kind === "shell") {
    return fromShell(message);
  }
  return null;
}

function fromTool(t: ToolMessage): ToolDetailModel {
  const status = toolMessageStatus(t);
  return {
    id: t.id,
    source: "tool",
    toolName: t.name,
    status,
    aborted: t.aborted === true,
    args: t.args,
    output: t.result,
    error: status === "error" ? toolErrorText(t.aborted, t.result) : undefined,
  };
}

function fromShell(s: ShellMessage): ToolDetailModel {
  const status: ToolStatus = !s.done ? "running" : s.ok === false ? "error" : "done";
  return {
    id: s.id,
    source: "shell",
    toolName: "shell",
    status,
    aborted: false,
    args: s.command,
    output: s.output,
    error: status === "error" ? (s.output ?? "command failed") : undefined,
  };
}

/** The failure text for a tool in the error state: an aborted run, or the `error:` result unwrapped. */
function toolErrorText(aborted: boolean | undefined, result: string | undefined): string {
  if (aborted) {
    return "aborted before completion";
  }
  if (isErrorResult(result)) {
    return result?.replace(/^error:\s*/u, "") ?? "error";
  }
  return "error";
}
