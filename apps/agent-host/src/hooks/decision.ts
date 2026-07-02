import { asNonEmptyString, asRecord } from "@host/boot/decode";
import { boundedText, clipLine } from "@host/tools/shared";
import { redactHookText } from "./redact";

/**
 * The hook decision contract (plan 25 M3): a hook communicates by printing ONE JSON object on
 * stdout - `{ "decision": "allow" | "deny" | "halt", "reason"?, "context"?, "updatedInput"? }`.
 * Parsing is tolerant in the loadJsonConfig tradition: malformed output is a structured
 * invalid result (never a throw), an unknown decision verb names the supported set, and every
 * carried field is bounded - reason clips to one line, context caps with a truncation marker,
 * and `updatedInput` rides through as `unknown` (M6 validates it per-tool at the boundary;
 * carrying it unvalidated here keeps the parser free of tool knowledge, D-003). Invalid-result
 * details are redacted (D-009) because they quote hook output.
 *
 * Responsible for: parsing one hook's stdout into a bounded decision or a structured invalid result.
 * Not for: process execution (./runner) or blocking/diagnostic semantics (./results, M4).
 */

/** The only decision verbs a hook can return; anything else is invalid data, not a new verb. */
export const HOOK_DECISIONS = ["allow", "deny", "halt"] as const;

export type HookDecisionKind = (typeof HOOK_DECISIONS)[number];

/** A deny/halt reason stays a single displayable line. */
export const MAX_HOOK_REASON_CHARS = 500;

/** Injected context is bounded so a hook cannot flood the model window (D-003). */
export const MAX_HOOK_CONTEXT_CHARS = 4_000;

/** How much (redacted) stdout an invalid result quotes back for diagnosis. */
const MAX_INVALID_PREVIEW_CHARS = 160;

export interface HookDecision {
  readonly decision: HookDecisionKind;
  /** The hook's stated reason, clipped to one bounded line. */
  readonly reason?: string;
  /** Bounded context the hook injects; M5/M7 route it per-event. */
  readonly context?: string;
  /** Carried through UNVALIDATED; M6 validates per-tool for explicitly supported fields only. */
  readonly updatedInput?: unknown;
}

/** Why stdout failed to parse as a decision - data for M4's diagnostic outcome, not a throw. */
export type HookDecisionInvalidReason = "invalid_json" | "invalid_decision";

export type HookDecisionParse =
  | { readonly ok: true; readonly decision: HookDecision }
  | { readonly ok: false; readonly reason: HookDecisionInvalidReason; readonly detail: string };

/** Tolerantly parses a hook's stdout into its structured decision. Pure; never throws. */
export function parseHookDecision(stdout: string): HookDecisionParse {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return invalid("invalid_json", "hook wrote no stdout; expected a JSON decision object");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return invalid("invalid_json", `stdout is not JSON: ${preview(trimmed)}`);
  }

  const record = asRecord(parsed);
  if (!record) {
    return invalid("invalid_json", `decision output must be a JSON object: ${preview(trimmed)}`);
  }

  const decision = HOOK_DECISIONS.find((verb) => verb === record.decision);
  if (!decision) {
    return invalid(
      "invalid_decision",
      `unknown decision ${JSON.stringify(record.decision)}; expected ${HOOK_DECISIONS.map(
        (verb) => `"${verb}"`,
      ).join(" | ")}`,
    );
  }

  const reason = asNonEmptyString(record.reason);
  const context = asNonEmptyString(record.context);

  return {
    ok: true,
    decision: {
      decision,
      ...(reason ? { reason: clipLine(reason, MAX_HOOK_REASON_CHARS) } : {}),
      ...(context ? { context: boundedText(context, MAX_HOOK_CONTEXT_CHARS).text } : {}),
      ...("updatedInput" in record ? { updatedInput: record.updatedInput } : {}),
    },
  };
}

function invalid(reason: HookDecisionInvalidReason, detail: string): HookDecisionParse {
  return { ok: false, reason, detail: redactHookText(detail) };
}

function preview(text: string): string {
  return clipLine(text, MAX_INVALID_PREVIEW_CHARS);
}
