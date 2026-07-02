import { asPositiveInt } from "@host/boot/coerce";
import { loadJsonConfig } from "@host/boot/config";
import { asNonEmptyString, asRecord, asStringArray } from "@host/boot/decode";
import type { HookDecisionEventName } from "@trevor/session";

/**
 * The normalized hook config model (plan 25 M1). Hooks are a NARROW host-owned command-hook
 * runtime (D-001), not a plugin system: a hook is an explicit executable plus an args array
 * (no shell splitting, D-005) bound to exactly one of the two first-cut lifecycle events,
 * `PreToolUse` or `Stop` (D-002). A hooks file is `{ "hooks": { "<id>": { ... } } }` - the
 * same named-entry shape as mcp-servers.json - and normalization is a tolerant pure decoder
 * in the loadJsonConfig tradition: a malformed entry is dropped with a STRUCTURED issue
 * (never a crash, never a bare string), an unknown event is rejected with a diagnostic that
 * names the supported set, and a disabled entry stays in the model with a diagnostic so
 * Doctor can report it.
 *
 * Responsible for: the normalized HookDefinition model - parsing, validation issues, and
 * loading one hooks.json file.
 * Not for: multi-root discovery order (./discovery) or trust hashing (./trust).
 */

/** The only lifecycle events in the first cut (D-002); everything else is rejected as data.
 *  Type-tied to the session wire's hook event names, so the config vocabulary and the
 *  hook.decision event vocabulary cannot drift apart. */
export const HOOK_EVENTS = [
  "PreToolUse",
  "Stop",
] as const satisfies readonly HookDecisionEventName[];

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Where a hook definition came from; both scopes require explicit approval (D-006). */
export type HookSource = "project" | "user";

export interface HookDefinition {
  readonly id: string;
  readonly event: HookEvent;
  /** The executable, run as-is with {@link args} - never through a shell (D-005). */
  readonly command: string;
  readonly args: readonly string[];
  /** Per-hook budget, low by default and capped at {@link MAX_HOOK_TIMEOUT_MS}. */
  readonly timeoutMs: number;
  readonly enabled: boolean;
  readonly source: HookSource;
}

export type HookConfigIssueKind =
  | "invalid_shape"
  | "invalid_id"
  | "duplicate_id"
  | "unknown_event"
  | "missing_command"
  | "disabled_hook";

/** A structured validation finding: which entry, from which root, and why - as data, not a throw. */
export interface HookConfigIssue {
  readonly kind: HookConfigIssueKind;
  readonly hook: string;
  readonly source: HookSource;
  readonly detail: string;
}

export interface HooksConfig {
  readonly hooks: readonly HookDefinition[];
  readonly issues: readonly HookConfigIssue[];
}

/** Low default per D-005: a hook is a quick gate, not a build step. */
export const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

/** Hard cap on a per-hook override, so a config typo cannot stall a turn for minutes. */
export const MAX_HOOK_TIMEOUT_MS = 30_000;

const EMPTY_HOOKS_CONFIG: HooksConfig = { hooks: [], issues: [] };

/** No `:` (reserved as the approval-key separator), no whitespace, no empties. */
const VALID_HOOK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Tolerantly decodes one raw hooks-file value into the normalized model, stamping every
 * definition and issue with the root it came from. Well-formed siblings survive a bad entry. Pure.
 */
export function normalizeHooksConfig(raw: unknown, source: HookSource): HooksConfig {
  const root = asRecord(raw);
  if (!root || root.hooks === undefined) {
    return EMPTY_HOOKS_CONFIG;
  }
  const entries = asRecord(root.hooks);
  if (!entries) {
    return {
      hooks: [],
      issues: [{ kind: "invalid_shape", hook: "", source, detail: "hooks must be an object" }],
    };
  }

  const hooks: HookDefinition[] = [];
  const issues: HookConfigIssue[] = [];
  const seen = new Set<string>();

  for (const [rawId, rawEntry] of Object.entries(entries)) {
    const id = rawId.trim();
    if (!VALID_HOOK_ID.test(id)) {
      issues.push({
        kind: "invalid_id",
        hook: id,
        source,
        detail: `hook id "${rawId}" must match ${String(VALID_HOOK_ID)} (":" is reserved as the approval-key separator)`,
      });
      continue;
    }
    if (seen.has(id)) {
      issues.push({
        kind: "duplicate_id",
        hook: id,
        source,
        detail: `duplicate hook id "${id}"; first entry wins`,
      });
      continue;
    }
    const outcome = normalizeHook(id, rawEntry, source);
    if ("issue" in outcome) {
      issues.push(outcome.issue);
      continue;
    }
    seen.add(id);
    hooks.push(outcome.hook);
    if (!outcome.hook.enabled) {
      issues.push({
        kind: "disabled_hook",
        hook: id,
        source,
        detail: `hook "${id}" is disabled and will not execute`,
      });
    }
  }

  return { hooks, issues };
}

/** Loads + normalizes one hooks.json; an absent or malformed file means no hooks from that root. */
export function loadHooksFile(
  path: string,
  source: HookSource,
  read?: (path: string) => string,
): HooksConfig {
  return loadJsonConfig(path, (raw) => normalizeHooksConfig(raw, source), EMPTY_HOOKS_CONFIG, read);
}

function normalizeHook(
  id: string,
  rawEntry: unknown,
  source: HookSource,
): { hook: HookDefinition } | { issue: HookConfigIssue } {
  const entry = asRecord(rawEntry);
  if (!entry) {
    return {
      issue: { kind: "invalid_shape", hook: id, source, detail: "hook entry must be an object" },
    };
  }

  const event = asHookEvent(entry.event);
  if (!event) {
    return {
      issue: {
        kind: "unknown_event",
        hook: id,
        source,
        detail: `unknown hook event ${JSON.stringify(entry.event)}; the first cut supports exactly ${HOOK_EVENTS.map((name) => `"${name}"`).join(" and ")} (D-002)`,
      },
    };
  }

  const command = asNonEmptyString(entry.command);
  if (!command) {
    return {
      issue: { kind: "missing_command", hook: id, source, detail: "a hook requires a command" },
    };
  }

  return {
    hook: {
      id,
      event,
      command,
      args: asStringArray(entry.args),
      timeoutMs: Math.min(
        asPositiveInt(entry.timeoutMs) ?? DEFAULT_HOOK_TIMEOUT_MS,
        MAX_HOOK_TIMEOUT_MS,
      ),
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
      source,
    },
  };
}

function asHookEvent(raw: unknown): HookEvent | undefined {
  return HOOK_EVENTS.find((event) => event === raw);
}
