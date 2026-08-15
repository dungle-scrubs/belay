import type { CommandSpec } from "@belay/session";

/**
 * The debug-command surface (D-094 M4): a runtime-gated set of dev-only host slash commands hidden
 * from a normal session and revealed only while debug mode is on (toggled by `/debug`). Pulled out of
 * main.ts so the gating - which commands appear, and the `/stop` confirm step - is pure and
 * unit-testable without booting a host. main.ts owns the HANDLERS (they touch the live scheduler,
 * lease, and transport); this module owns only the vocabulary + the confirm predicate.
 *
 * Lifecycle commands here are STOP/ARCHIVE/UNARCHIVE only. KILL is deliberately absent: a wedged host
 * cannot process its own kill, so force-termination stays external (the CLI's `belay kill`).
 *
 * Responsible for: the debug-gated command vocabulary and the `/stop` confirm predicate.
 * Not for: the command handlers - main.ts wires those to the live scheduler/lease/transport.
 */

/** Always-present toggle; flips debug mode and re-announces the command set. */
export const DEBUG_TOGGLE_SPEC: CommandSpec = {
  name: "/debug",
  summary: "Toggle debug command mode",
};

/** The dev-only commands revealed while debug mode is on. */
export const DEBUG_ONLY_SPECS: readonly CommandSpec[] = [
  { name: "/restart", summary: "Restart the host to pick up code changes (debug)" },
  {
    name: "/archive",
    summary: "Archive this session: hide it from the sidebar and /resume (debug)",
  },
  {
    name: "/unarchive",
    summary: "Unarchive this session: restore it to the sidebar and /resume (debug)",
  },
  {
    name: "/stop",
    summary:
      "Stop this session: cancel active work, clear the queue, and shut the host down (debug)",
  },
];

/** The debug command specs to announce: the always-present toggle plus the gated set when debug is on. */
export function debugCommandSpecs(debugMode: boolean): CommandSpec[] {
  return [DEBUG_TOGGLE_SPEC, ...(debugMode ? DEBUG_ONLY_SPECS : [])];
}

/**
 * Whether a `/stop` invocation is the CONFIRMED execution or the describe-and-prompt step. Stop ends
 * the session, so bare `/stop` only explains the effect; the user re-runs `/stop confirm` to proceed.
 */
export function isStopConfirmed(args: string): boolean {
  return args.trim().toLowerCase() === "confirm";
}
