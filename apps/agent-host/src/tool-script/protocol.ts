import type { ToolScriptFailureClass } from "@belay/session";

// The failure classes are inlined (not imported as a value) + `satisfies`-checked against the session
// contract, so this module - and the child runner that imports it - has ZERO runtime dependency on
// @belay/session. That is load-bearing: the child runs in an OS sandbox with a foreign cwd where the
// monorepo's workspace packages do not resolve. The `satisfies` catches any drift (a new class) at compile.
const TOOL_SCRIPT_FAILURE_CLASSES = [
  "timeout",
  "cancelled",
  "syntax_error",
  "runtime_error",
  "validation",
  "sandbox_launch",
  "bridge_denied",
  "bridge_failed",
  "output_too_large",
  "budget_exhausted",
] as const satisfies readonly ToolScriptFailureClass[];

// Local coercion helpers (kept inline so the child runner imports only this protocol + the session
// contract types - never the heavier coerce/registry modules).
const asOptRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const asMaybeString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const oneOf = <T extends string>(opts: readonly T[], v: unknown, fallback: T): T =>
  typeof v === "string" && (opts as readonly string[]).includes(v) ? (v as T) : fallback;

/**
 * The `tool_script` child-runner IPC protocol (plan 16, M3). A newline-delimited JSON message stream over
 * the child's stdio: the HOST (parent) drives one `execute`, answers each `bridge_request` with a
 * `bridge_response`, and may `cancel`; the CHILD RUNNER announces `start`, emits `bridge_request`s while the
 * script runs, and ends with `complete` or `fail`. Timeout is a HOST action (kill + synthesize a timeout
 * result), not a wire message.
 *
 * This module is DELIBERATELY isolated (M3 REFACTOR): the child runner entry point imports ONLY this
 * protocol (plus the session contract) - never the agent-host tool registry - so user script code runs in a
 * process with no ambient Belay authority. The codec is permissive (malformed lines decode to null, not a
 * throw) and the line reader caps buffered bytes, so a crashing or spam-happy child is contained.
 *
 * Responsible for: the host<->runner NDJSON message types, the permissive line codecs, and the
 * byte-capped line reader.
 * Not for: spawning or driving the exchange - see spawn.ts / host-manager.ts.
 */

export const RUNNER_PROTOCOL_VERSION = 1;

/** The bounded context handed to a script (never secrets/env). */
export interface RunnerContext {
  readonly cwd: string;
  readonly runId?: string;
  readonly toolCallId?: string;
}

/** Host -> child runner messages. */
export type HostToRunner =
  | { readonly type: "execute"; readonly script: string; readonly context: RunnerContext }
  | {
      readonly type: "bridge_response";
      readonly callId: number;
      readonly status: "ok" | "denied" | "failed";
      readonly output?: string;
      readonly error?: string;
    }
  | { readonly type: "cancel" };

/** Child runner -> host messages. */
export type RunnerToHost =
  | { readonly type: "start"; readonly protocol: number }
  | {
      readonly type: "bridge_request";
      readonly callId: number;
      readonly tool: string;
      readonly input: unknown;
    }
  | { readonly type: "complete"; readonly result: unknown }
  | {
      readonly type: "fail";
      readonly failureClass: ToolScriptFailureClass;
      readonly error: string;
    };

/** Encodes a message as one newline-delimited JSON line. */
export function encodeMessage(message: HostToRunner | RunnerToHost): string {
  return `${JSON.stringify(message)}\n`;
}

/** Permissively decodes one child->host line, or null when it is malformed / an unknown type. */
export function decodeRunnerToHost(line: string): RunnerToHost | null {
  const o = parseLine(line);
  if (!o) {
    return null;
  }
  switch (o.type) {
    case "start":
      return { type: "start", protocol: typeof o.protocol === "number" ? o.protocol : 0 };
    case "bridge_request":
      return typeof o.callId === "number" && typeof o.tool === "string"
        ? { type: "bridge_request", callId: o.callId, tool: o.tool, input: o.input }
        : null;
    case "complete":
      return { type: "complete", result: o.result };
    case "fail":
      return {
        type: "fail",
        failureClass: oneOf(TOOL_SCRIPT_FAILURE_CLASSES, o.failureClass, "runtime_error"),
        error: asMaybeString(o.error) ?? "",
      };
    default:
      return null;
  }
}

/** Permissively decodes one host->child line, or null when it is malformed / an unknown type. */
export function decodeHostToRunner(line: string): HostToRunner | null {
  const o = parseLine(line);
  if (!o) {
    return null;
  }
  switch (o.type) {
    case "execute": {
      const context = asOptRecord(o.context);
      return typeof o.script === "string" && context && typeof context.cwd === "string"
        ? {
            type: "execute",
            script: o.script,
            context: {
              cwd: context.cwd,
              ...(asMaybeString(context.runId) !== undefined
                ? { runId: asMaybeString(context.runId) }
                : {}),
              ...(asMaybeString(context.toolCallId) !== undefined
                ? { toolCallId: asMaybeString(context.toolCallId) }
                : {}),
            },
          }
        : null;
    }
    case "bridge_response":
      return typeof o.callId === "number"
        ? {
            type: "bridge_response",
            callId: o.callId,
            status: oneOf(["ok", "denied", "failed"] as const, o.status, "failed"),
            ...(asMaybeString(o.output) !== undefined ? { output: asMaybeString(o.output) } : {}),
            ...(asMaybeString(o.error) !== undefined ? { error: asMaybeString(o.error) } : {}),
          }
        : null;
    case "cancel":
      return { type: "cancel" };
    default:
      return null;
  }
}

function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return asOptRecord(parsed) ?? null;
  } catch {
    return null;
  }
}

export interface LineReaderOptions {
  /** Bytes past which a single un-terminated line is dropped (a runaway child never balloons host memory). */
  readonly maxLineBytes: number;
}

export interface LineReader {
  /** Feeds a stdout chunk; returns any COMPLETE lines it closed (partial trailing data is buffered). */
  push(chunk: string): string[];
  /** Bytes currently buffered (for a stderr/stdout cap check). */
  buffered(): number;
}

/**
 * A newline-splitting reader that tolerates chunk boundaries and CAPS the pending buffer: if an
 * un-terminated line grows past `maxLineBytes` the buffer is discarded (the line is lost, but the host is
 * not flooded). Contains a child that spews output without newlines.
 */
export function createLineReader(options: LineReaderOptions): LineReader {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      const lines: string[] = [];
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        lines.push(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > options.maxLineBytes) {
        buffer = "";
      }
      return lines;
    },
    buffered() {
      return buffer.length;
    },
  };
}
