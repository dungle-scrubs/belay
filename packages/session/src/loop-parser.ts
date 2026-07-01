/**
 * Deterministic `/loop` parser.
 *
 * Turns typed `/loop …` input into a `CommandParseResult`: token spans for
 * highlighting, the runner/bound/action/durability rows the builder renders,
 * used-vs-available keywords for the legend, the missing parts that block
 * activation, value diagnostics, and a `ready` flag. No model, no execution -
 * the same parse the host would run authoritatively, run here on every keystroke.
 */
import type {
  CommandDiagnostic,
  CommandFieldRow,
  CommandParseMode,
  CommandParseResult,
  CommandToken,
} from "./command-family";
import { commandPresentation } from "./command-family";
import {
  LOOP_COMMAND_NAMES,
  LOOP_FAMILY,
  type LoopDurability,
  type LoopProtocolAction,
  type LoopRunner,
  type LoopSpec,
  loopGrammar,
  loopRunnerLabel,
} from "./loop-command";

interface RawToken {
  readonly value: string;
  /** Inclusive start offset into the raw input. */
  readonly start: number;
  /** Exclusive end offset into the raw input. */
  readonly end: number;
}

/** Split input into tokens with absolute spans, keeping double-quoted spans intact. */
function tokenize(input: string): RawToken[] {
  const tokens: RawToken[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match = pattern.exec(input);
  while (match !== null) {
    const value = match[1] !== undefined ? match[1] : (match[2] ?? "");
    tokens.push({ value, start: match.index, end: match.index + match[0].length });
    match = pattern.exec(input);
  }
  return tokens;
}

/**
 * Parse a duration like `5s`, `0.2s`, `10m`, `5min`, `1h` into milliseconds. The
 * `min`/`sec`/`hr` aliases are accepted because users type them; an unrecognized
 * shape returns `undefined` so the caller can flag it instead of silently
 * carrying a value that never schedules.
 */
export function parseDurationMs(duration: string): number | undefined {
  const match = /^([0-9]*\.?[0-9]+)\s*(ms|sec|s|min|m|hr|h)?$/.exec(duration.trim());
  if (match === null) {
    return undefined;
  }
  const value = Number(match[1]);
  const unitMs: Record<string, number> = {
    h: 3_600_000,
    hr: 3_600_000,
    m: 60_000,
    min: 60_000,
    ms: 1,
    s: 1_000,
    sec: 1_000,
  };
  return value * (unitMs[match[2] ?? "s"] ?? 1_000);
}

// The parser walks the grammar's derived lookup structures (loop.ts owns them); it no longer rebinds
// the LOOP_* constants or re-derives the legend here.
const {
  runnerAliases: RUNNER_ALIASES,
  legend: LEGEND,
  controlVerbs: CONTROL_VERBS,
} = loopGrammar();

/** Accumulated state while walking creation tokens. */
interface CreationFields {
  runner: LoopRunner;
  durability: LoopDurability;
  max?: string;
  every?: string;
  until?: string;
  timeout?: string;
  action?: string;
}

function emptyResult(input: string, mode: CommandParseMode, command: string): CommandParseResult {
  const head = tokenize(input)[0];
  return {
    availableKeywords: mode === "create" ? [...LEGEND] : [],
    command,
    diagnostics:
      mode === "invalid"
        ? [{ code: "not_loop_command", message: "Not a /loop command.", severity: "error" }]
        : [],
    fields: [],
    missing: [],
    mode,
    ready: false,
    tokens: head ? [{ end: head.end, kind: "command", start: head.start }] : [],
    usedKeywords: [],
  };
}

/**
 * Parse a `/loop` line. Classifies the input (create / control / list /
 * invalid), then for creation walks the keyword grammar into builder rows,
 * legend state, diagnostics, and a `ready` flag.
 */
export function parseLoopCommand(input: string): CommandParseResult {
  const raw = tokenize(input);
  const head = raw[0];
  const command = LOOP_FAMILY.id;

  if (head === undefined || !LOOP_COMMAND_NAMES.includes(head.value as "/loop" | "/loops")) {
    return emptyResult(input, "invalid", command);
  }

  const second = raw[1];
  // A bare `/loops` (plural, no subcommand) IS the list command (D-006); `/loop` bare opens the builder.
  if (head.value === "/loops" && second === undefined) {
    return controlResult(raw, "list");
  }
  if (second !== undefined && CONTROL_VERBS.has(second.value)) {
    return controlResult(raw, "control");
  }
  if (second !== undefined && second.value === "list") {
    return controlResult(raw, "list");
  }

  return createResult(raw, command, input);
}

/** Parse and project a `/loop` line into the UI-ready presentation view-model in one call. */
export function loopPresentation(input: string) {
  return commandPresentation(parseLoopCommand(input), LOOP_FAMILY);
}

/** The resolved lifecycle action for a `/loop` line, for routing (D-006). A control verb resolves to its
 *  matching action and carries the target `loopId` when one is typed; a creation line is `create`; a `list`
 *  subcommand is `list`; a non-`/loop` input is `invalid`. This is what the host routes on - the same
 *  classification the parser uses, exposed as an action so a headless client needs no builder UI. */
export function classifyLoopCommand(input: string): {
  readonly action: LoopProtocolAction | "invalid";
  readonly loopId?: string;
} {
  const raw = tokenize(input);
  const head = raw[0];
  if (head === undefined || !LOOP_COMMAND_NAMES.includes(head.value as "/loop" | "/loops")) {
    return { action: "invalid" };
  }
  const second = raw[1];
  // A bare `/loops` (plural, no subcommand) IS the list command (D-006); `/loop` bare opens the builder.
  if (head.value === "/loops" && second === undefined) {
    return { action: "list" };
  }
  if (second !== undefined && CONTROL_VERBS.has(second.value)) {
    const loopId = raw[2]?.value;
    return loopId !== undefined
      ? { action: second.value as LoopProtocolAction, loopId }
      : { action: second.value as LoopProtocolAction };
  }
  if (second !== undefined && second.value === "list") {
    return { action: "list" };
  }
  return { action: "create" };
}

/**
 * The typed {@link LoopSpec} a READY `/loop` creation compiles to, or undefined when the input is not a
 * ready creation (a control/list line, an incomplete draft, or any error-severity diagnostic). Reuses the
 * SAME validated token-walk as the parser - durations normalize to milliseconds, `max` to a number - so the
 * host's authoritative create path never re-derives the grammar. This is the create-side bridge D-002 needs.
 */
export function extractLoopSpec(input: string): LoopSpec | undefined {
  const raw = tokenize(input);
  const head = raw[0];
  if (head === undefined || !LOOP_COMMAND_NAMES.includes(head.value as "/loop" | "/loops")) {
    return undefined;
  }
  const second = raw[1];
  if (second !== undefined && (CONTROL_VERBS.has(second.value) || second.value === "list")) {
    return undefined;
  }
  const { fields, diagnostics } = walkCreation(raw, input);
  const hasBound =
    fields.max !== undefined ||
    fields.every !== undefined ||
    fields.until !== undefined ||
    fields.timeout !== undefined;
  const hasAction = fields.action !== undefined && fields.action.trim().length > 0;
  if (!hasBound || !hasAction || diagnostics.some((d) => d.severity === "error")) {
    return undefined;
  }
  const everyMs = fields.every !== undefined ? parseDurationMs(fields.every) : undefined;
  const timeoutMs = fields.timeout !== undefined ? parseDurationMs(fields.timeout) : undefined;
  return {
    runner: fields.runner,
    durability: fields.durability,
    action: fields.action as string,
    ...(fields.max !== undefined ? { max: Number(fields.max) } : {}),
    ...(everyMs !== undefined ? { everyMs } : {}),
    ...(fields.until !== undefined ? { until: fields.until } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

/** Build the parse result for a control/list command (no builder rows). */
function controlResult(raw: readonly RawToken[], mode: "control" | "list"): CommandParseResult {
  const head = raw[0];
  const verb = raw[1];
  const tokens: CommandToken[] = [];
  if (head) {
    tokens.push({ end: head.end, kind: "command", start: head.start });
  }
  if (verb) {
    tokens.push({ end: verb.end, kind: "subcommand", start: verb.start });
  }
  for (const token of raw.slice(2)) {
    tokens.push({ end: token.end, kind: "value", start: token.start });
  }
  return {
    availableKeywords: [],
    command: LOOP_FAMILY.id,
    diagnostics: [],
    fields: [],
    missing: [],
    mode,
    ready: true,
    tokens,
    usedKeywords: [],
  };
}

interface CreationWalk {
  readonly tokens: CommandToken[];
  readonly fields: CreationFields;
  readonly diagnostics: CommandDiagnostic[];
  readonly sawDo: boolean;
}

/** Walk a `/loop` creation line's tokens into the structured fields, tokens, and diagnostics shared by the
 *  UI parse result ({@link createResult}) and the host's typed spec extraction ({@link extractLoopSpec}). */
function walkCreation(raw: readonly RawToken[], input: string): CreationWalk {
  const head = raw[0];
  const tokens: CommandToken[] = head
    ? [{ end: head.end, kind: "command", start: head.start }]
    : [];
  const diagnostics: CommandDiagnostic[] = [];
  // An odd number of double quotes means a span was opened but never closed - flag it before the value is
  // silently carried with a stray quote (D-007). Escaped quotes are not a supported form, so a bare `"` is
  // always a delimiter here.
  if ((input.match(/"/g)?.length ?? 0) % 2 === 1) {
    diagnostics.push({
      code: "unterminated_quote",
      message: "Unterminated quote - close the opening double quote.",
      severity: "error",
    });
  }
  const fields: CreationFields = { durability: "session", runner: "current_session_prompt" };
  let sawDo = false;

  let index = 1;
  while (index < raw.length) {
    const token = raw[index];
    if (token === undefined) {
      break;
    }
    const word = token.value;
    const runner = RUNNER_ALIASES[word];

    if (word === "new") {
      tokens.push({ end: token.end, keyword: "new", kind: "subcommand", start: token.start });
    } else if (runner !== undefined) {
      fields.runner = runner;
      tokens.push({ end: token.end, keyword: word, kind: "flag", start: token.start });
    } else if (word === "durable") {
      fields.durability = "durable";
      tokens.push({ end: token.end, keyword: "durable", kind: "flag", start: token.start });
    } else if (word === "max") {
      const taken = consumeValue(raw, index, tokens, "maxIterations", "max");
      index = taken.nextIndex;
      const parsed = Number(taken.value);
      if (taken.value === undefined || !Number.isInteger(parsed) || parsed <= 0) {
        diagnostics.push({
          code: "invalid_max",
          message: "max needs a positive whole number of iterations.",
          severity: "error",
        });
      } else {
        fields.max = taken.value;
      }
    } else if (word === "every" || word === "timeout") {
      const taken = consumeValue(raw, index, tokens, word, word);
      index = taken.nextIndex;
      if (taken.value !== undefined && parseDurationMs(taken.value) === undefined) {
        diagnostics.push({
          code: "invalid_duration",
          message: `${word} needs a duration like 30s, 5m, or 1h (got "${taken.value}").`,
          severity: "error",
        });
      } else if (taken.value !== undefined) {
        fields[word] = taken.value;
      }
    } else if (word === "until") {
      const taken = consumeValue(raw, index, tokens, "until", "until");
      index = taken.nextIndex;
      if (taken.value !== undefined && taken.value.trim().length === 0) {
        diagnostics.push({
          code: "empty_until",
          message: "until needs a non-empty condition.",
          severity: "error",
        });
      } else if (taken.value !== undefined) {
        fields.until = taken.value;
      }
    } else if (word === "do") {
      sawDo = true;
      const taken = consumeValue(raw, index, tokens, "action", "do");
      index = taken.nextIndex;
      if (taken.value !== undefined && taken.value.trim().length === 0) {
        // `do ""` (or `do` + empty token): an explicit-but-empty action, distinct from no `do` at all.
        diagnostics.push({
          code: "empty_action",
          message: "do needs a non-empty action.",
          severity: "error",
        });
      } else {
        fields.action = taken.value;
      }
    } else {
      tokens.push({ end: token.end, kind: "unknown", start: token.start });
      diagnostics.push({
        code: "unknown_token",
        message: `Unrecognized token "${word}".`,
        severity: "info",
      });
    }
    index += 1;
  }

  return { tokens, fields, diagnostics, sawDo };
}

/** Walk a `/loop` creation line into the full create-mode parse result. */
function createResult(
  raw: readonly RawToken[],
  command: string,
  input: string,
): CommandParseResult {
  const walk = walkCreation(raw, input);
  return finalizeCreate(command, walk.tokens, walk.fields, walk.diagnostics, walk.sawDo);
}

interface TakenValue {
  /** Index the outer loop should treat as current; the trailing `index += 1` advances past it. */
  readonly nextIndex: number;
  /** The value token's text, or `undefined` when the keyword had no following token. */
  readonly value: string | undefined;
}

/**
 * Push the keyword token, then (if present) the value token tagged with its
 * field, and report the consumed value. When the keyword ends the input there is
 * no value token: `nextIndex` stays on the keyword and `value` is `undefined`.
 */
function consumeValue(
  raw: readonly RawToken[],
  keywordIndex: number,
  tokens: CommandToken[],
  field: string,
  keyword: string,
): TakenValue {
  const keywordToken = raw[keywordIndex];
  if (keywordToken) {
    tokens.push({ end: keywordToken.end, keyword, kind: "keyword", start: keywordToken.start });
  }
  const valueToken = raw[keywordIndex + 1];
  if (valueToken === undefined) {
    return { nextIndex: keywordIndex, value: undefined };
  }
  tokens.push({ end: valueToken.end, field, kind: "value", start: valueToken.start });
  return { nextIndex: keywordIndex + 1, value: valueToken.value };
}

/** Turn accumulated creation fields into builder rows, legend state, and readiness. `sawDo` distinguishes
 *  "no action at all" (a `missing` gap) from "an explicit-but-empty `do`" (an `empty_action` diagnostic). */
function finalizeCreate(
  command: string,
  tokens: readonly CommandToken[],
  fields: CreationFields,
  diagnostics: readonly CommandDiagnostic[],
  sawDo: boolean,
): CommandParseResult {
  const hasBound =
    fields.max !== undefined ||
    fields.every !== undefined ||
    fields.until !== undefined ||
    fields.timeout !== undefined;
  const hasAction = fields.action !== undefined && fields.action.trim().length > 0;

  const rows: CommandFieldRow[] = [
    { field: "runner", label: "Runner", missing: false, value: loopRunnerLabel(fields.runner) },
  ];
  if (fields.max !== undefined) {
    rows.push({ field: "max", label: "Max", missing: false, value: fields.max });
  }
  if (fields.every !== undefined) {
    rows.push({ field: "every", label: "Every", missing: false, value: fields.every });
  }
  if (fields.until !== undefined) {
    rows.push({ field: "until", label: "Until", missing: false, value: fields.until });
  }
  if (fields.timeout !== undefined) {
    rows.push({ field: "timeout", label: "Timeout", missing: false, value: fields.timeout });
  }
  if (!hasBound) {
    rows.push({
      field: "bound",
      hint: "add max, until, every, or timeout",
      label: "Stop",
      missing: true,
      value: undefined,
    });
  }
  rows.push(
    hasAction
      ? { field: "action", label: "Action", missing: false, value: fields.action }
      : { field: "action", hint: 'add do "…"', label: "Action", missing: true, value: undefined },
  );
  rows.push({ field: "durability", label: "Durability", missing: false, value: fields.durability });

  const usedKeywords = LEGEND.filter((keyword) => isKeywordUsed(keyword, fields, hasAction));
  const missing: string[] = [];
  // No `do` at all is a missing gap; an explicit-but-empty `do` is reported by the empty_action diagnostic
  // instead, so it is not double-counted as a missing part.
  if (!hasAction && !sawDo) {
    missing.push("action");
  }
  if (!hasBound) {
    missing.push("bound");
  }
  const ready =
    hasAction && hasBound && !diagnostics.some((diagnostic) => diagnostic.severity === "error");

  return {
    availableKeywords: LEGEND.filter((keyword) => !usedKeywords.includes(keyword)),
    command,
    diagnostics,
    fields: rows,
    missing,
    mode: "create",
    ready,
    tokens,
    usedKeywords,
  };
}

function isKeywordUsed(keyword: string, fields: CreationFields, hasAction: boolean): boolean {
  switch (keyword) {
    case "background":
      return fields.runner === "background_agent";
    case "process":
      return fields.runner === "process";
    case "do":
      return hasAction;
    case "durable":
      return fields.durability === "durable";
    case "max":
      return fields.max !== undefined;
    case "every":
      return fields.every !== undefined;
    case "until":
      return fields.until !== undefined;
    case "timeout":
      return fields.timeout !== undefined;
    default:
      return false;
  }
}
