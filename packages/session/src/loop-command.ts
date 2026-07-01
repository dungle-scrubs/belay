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

/** Lifecycle state of a loop (the client-facing subset the inventory row shows). */
export type LoopStatus = "draft" | "running" | "paused" | "stopped" | "completed" | "failed";

/**
 * The FULL loop lifecycle status, including the host-internal `pending` (awaiting confirmation) and
 * `deleted` (soft-deleted) states the domain state machine drives and the status events ride with. `draft`
 * -> `pending` -> `running` is activation; `running`/`paused` are active; the last four are terminal.
 */
export type LoopLifecycle =
  | "draft"
  | "pending"
  | "running"
  | "paused"
  | "stopped"
  | "completed"
  | "failed"
  | "deleted";

/** Why a loop left `running` (D-009): a hit bound, a satisfied condition, a timeout, an explicit stop, or
 *  an execution error. */
export type LoopStopReason = "max_iterations" | "until_satisfied" | "timeout" | "stopped" | "error";

/**
 * The host->client STATUS SNAPSHOT of one loop (the payload of a `loop.status` event and the atom the
 * inventory renders). A `pending` snapshot IS the confirmation request - the client offers confirm/edit/
 * cancel. UI-neutral: a human `summary`, the counters, and the terminal reason/error, never rendered rows.
 */
export interface LoopSnapshot {
  readonly loopId: string;
  readonly status: LoopLifecycle;
  readonly runner: LoopRunner;
  readonly durability: LoopDurability;
  /** A human, one-line description of the action + its bounds (e.g. `max 5 · do "run tests"`). */
  readonly summary: string;
  /** Iterations completed so far. */
  readonly completed: number;
  /** The `max` bound, when set (for a `completed/N` progress display). */
  readonly max?: number;
  /** Epoch-ms time the next cadence iteration is scheduled to fire, when the loop is running on a timer. */
  readonly nextRun?: number;
  /** Set once terminal: why the loop ended. */
  readonly stopReason?: LoopStopReason;
  /** Set only for `failed`: the execution error. */
  readonly error?: string;
}

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

/** Control verbs that route to a lifecycle action instead of creating a loop. */
export const LOOP_CONTROL_VERBS = ["stop", "pause", "resume", "run-now", "delete"] as const;

/**
 * The lifecycle PROTOCOL ACTIONS the loop family exposes (D-006). A client - the rich web helper OR a
 * headless client that can only send command text - issues one of these; the host is authoritative. The
 * command head yields `create` (a `/loop …` creation) or `list` (`/loop list` / `/loops`); a control verb
 * maps 1:1 to the matching action. UI-neutral: no rendering, just the action vocabulary.
 */
export type LoopProtocolAction =
  | "create"
  | "list"
  | "stop"
  | "pause"
  | "resume"
  | "run-now"
  | "delete";

export const LOOP_PROTOCOL_ACTIONS: readonly LoopProtocolAction[] = [
  "create",
  "list",
  ...LOOP_CONTROL_VERBS,
];

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
 * The loop family descriptor the guide renders. Keyword order here is the order the guide lists them,
 * and it is also the legend order: the builder's legend derives from `keywords` (see `loopGrammar`),
 * so there is no second hand-maintained keyword list to drift.
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
  controlVerbs: [...LOOP_CONTROL_VERBS],
  protocolActions: [...LOOP_PROTOCOL_ACTIONS],
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

/**
 * The derived lookup structures the parser walks, built once from the grammar above (D-016). loop.ts
 * owns the grammar AND its derived forms, so the parser consumes this factory instead of rebinding the
 * LOOP_* constants and re-deriving the legend itself:
 *   - `runnerAliases`: the runner keyword → runner map (widened to allow a miss),
 *   - `legend`: the keyword names in guide order, DERIVED from `keywords` (no second list to drift),
 *   - `controlVerbs`: the control-verb set.
 */
export function loopGrammar(): {
  readonly runnerAliases: Record<string, LoopRunner | undefined>;
  readonly legend: readonly string[];
  readonly controlVerbs: ReadonlySet<string>;
} {
  return {
    runnerAliases: LOOP_RUNNER_ALIASES,
    legend: LOOP_FAMILY.keywords.map((keyword) => keyword.keyword),
    controlVerbs: new Set<string>(LOOP_CONTROL_VERBS),
  };
}

/**
 * The structured, validated definition a READY `/loop` creation compiles to: the work plus its bounds.
 * The host domain builds its loop state around this; durations are normalized to milliseconds and `max` to
 * a number, so a runtime never re-parses text. `runner`/`durability`/`action` are always present; a valid
 * spec carries at least one of `max`, `everyMs`, `until`, `timeoutMs` (the deterministic-bound rule, D-004).
 */
export interface LoopSpec {
  readonly runner: LoopRunner;
  readonly durability: LoopDurability;
  readonly action: string;
  readonly max?: number;
  readonly everyMs?: number;
  readonly until?: string;
  readonly timeoutMs?: number;
}

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
