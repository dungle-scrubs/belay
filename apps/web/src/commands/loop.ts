/**
 * `/loop` command-family vocabulary, lifecycle types, and descriptor.
 *
 * The single source of the loop grammar the web UI renders: runner aliases,
 * creation keywords, control verbs, durability, the guide descriptor, and the
 * inventory read-model shape. The parser (`loop-parser.ts`) and the helper
 * components consume these; nothing here renders or executes.
 */
import type { CommandFamilyDescriptor } from "./command-family";

/** Where one loop iteration runs. */
export type LoopRunner = "current_session_prompt" | "background_agent" | "process";

/** Whether a loop survives only the current session or persists across sessions. */
export type LoopDurability = "session" | "durable";

/** Lifecycle state of a loop. */
export type LoopStatus = "draft" | "running" | "paused" | "stopped" | "completed" | "failed";

/** A manual control a client may offer for a loop in its current state. */
export type LoopControl = "pause" | "resume" | "stop" | "run-now" | "delete";

/** The names that open the loop family. */
export const LOOP_COMMAND_NAMES = ["/loop", "/loops"] as const;

/** Runner keyword -> runner, including the `current`/`session` aliases users type. */
export const LOOP_RUNNER_ALIASES = {
  background: "background_agent",
  current: "current_session_prompt",
  process: "process",
  session: "current_session_prompt",
} as const satisfies Record<string, LoopRunner>;

/** Creation keywords that consume the following token as their value. */
export const LOOP_VALUE_KEYWORDS = ["max", "every", "until", "timeout", "do"] as const;

/** Control verbs that route to a lifecycle action instead of creating a loop. */
export const LOOP_CONTROL_VERBS = ["stop", "pause", "resume", "run-now", "delete"] as const;

/** Human label for a runner, used in builder rows and inventory. */
export function loopRunnerLabel(runner: LoopRunner): string {
  switch (runner) {
    case "background_agent":
      return "background agent";
    case "process":
      return "process";
    case "current_session_prompt":
      return "current session";
  }
}

/**
 * The loop family descriptor the guide renders. Keyword order here is the order
 * the guide lists them; `legendKeywords` is what the builder lights up as used.
 */
export const LOOP_FAMILY: CommandFamilyDescriptor = {
  id: "loop",
  names: [...LOOP_COMMAND_NAMES],
  summary: "repeat an action until a bound",
  description:
    "Run an action over and over until a deterministic bound is reached. Every loop needs an action (do) and at least one bound (max, every, until, or timeout).",
  keywords: [
    { keyword: "do", arg: '"…"' },
    { keyword: "max", arg: "<n>" },
    { keyword: "every", arg: "<interval>" },
    { keyword: "until", arg: '"…"' },
    { keyword: "timeout", arg: "<interval>" },
    { keyword: "background", arg: null },
    { keyword: "process", arg: null },
    { keyword: "durable", arg: null },
  ],
  legendKeywords: ["do", "max", "every", "until", "timeout", "background", "process", "durable"],
  controlVerbs: [...LOOP_CONTROL_VERBS],
  examples: [
    { text: '/loop max 5 do "run the test suite"', note: "Five iterations, then stop." },
    { text: '/loop every 5m do "check CI status"', note: "On a cadence until you stop it." },
    { text: '/loop until "tests pass" do "fix the failing test"', note: "Stop on a condition." },
    {
      text: '/loop process every 30s do "curl -sf localhost:8080/health"',
      note: "A shell command on a cadence.",
    },
  ],
};

/** A client-facing inventory row (mirrors the host read model). */
export interface LoopInventoryRow {
  readonly loopId: string;
  readonly runner: LoopRunner;
  readonly status: LoopStatus;
  readonly durability: LoopDurability;
  readonly summary: string;
  readonly progress: { readonly completed: number; readonly max?: number };
  readonly nextRun?: string;
  /** False for process loops (no agent); true for prompt/background-agent loops. */
  readonly agentBacked: boolean;
  readonly controls: readonly LoopControl[];
}
