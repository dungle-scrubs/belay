import { collapsePaths, redactSecrets } from "@trevor/session/telemetry";

/**
 * The general-interpolation TRUST GATE + policy (plan 14 gate, plan 40 runtime). "Interpolation" is
 * expanding a `!command` embedded in a skill or command file by RUNNING it and splicing its output in.
 * That can execute commands, so it is a SEPARATE, configurable feature that is DISABLED BY DEFAULT and
 * turned on only by an explicit environment opt-in. Plan 14 shipped the gate (opt-in + allow-list +
 * output policy); plan 40 adds the policy PRIMITIVES the runtime is built from - provenance, argv
 * splitting, refusal markers, bounded-output metadata, and the diagnostic record - while the shared
 * parser lives in interpolation-engine.ts and the command-file wiring in command-file.ts.
 *
 * The built-in `trevor-expert` is INDEPENDENT of this gate (D-004): it reads the capability manifest
 * through the direct host seam (`manifest/source.ts` `currentManifest`), so it works whether or not general
 * interpolation is enabled. This module governs ONLY untrusted `!command` expansion inside skill/command
 * files.
 *
 * Responsible for: the `!command` interpolation trust gate - opt-in, allow-list, provenance, argv
 * split, output policy, and diagnostic records.
 * Not for: the shared parser (interpolation-engine.ts), the command-file runner/loader
 * (command-file.ts), or skill-load shell interpolation (TREVOR_SKILL_SHELL) - skills/skills.ts.
 */

/** The env var that gates general (command-file) interpolation. Only the exact opt-in "1" enables it. */
export const INTERPOLATION_ENV = "TREVOR_ENABLE_INTERPOLATION";

/**
 * Where an interpolated value originated + which SEPARATE gate authorized it (plan 40, M1). An
 * interpolated value carries its source so an untrusted file expansion can never be silently mistaken for
 * a trusted instruction. The two lanes are deliberately distinct trust surfaces:
 *   - `skill-shell`   : the pre-existing skill-load seam - an ARBITRARY command bounded by the runCommand
 *                       floor, opt-in via `TREVOR_SKILL_SHELL`.
 *   - `command-file`  : the plan-40 runtime - only an ALLOW-LISTED, read-only, in-process command, opt-in
 *                       via `TREVOR_ENABLE_INTERPOLATION`.
 * Because the gates are different env keys, enabling one can never enable the other.
 */
export type InterpolationSource = "skill-shell" | "command-file";

/** The env gate that authorizes each interpolation source. Distinct keys, so the two lanes never co-arm. */
export const INTERPOLATION_GATE_ENV: Record<InterpolationSource, string> = {
  "skill-shell": "TREVOR_SKILL_SHELL",
  "command-file": INTERPOLATION_ENV,
};

/**
 * The commands permitted as interpolation targets when the gate is open. Exactly one: the read-only
 * capability export (D-002). A bounded, side-effect-free command is the only kind that may be spliced -
 * never `/shell`, never a mutating command.
 */
export const DEFAULT_INTERPOLATION_ALLOWLIST: readonly string[] = ["/trevor-export"];

/** Max bytes of interpolated output spliced into a file. */
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024;
/** Per-interpolation timeout. */
const DEFAULT_TIMEOUT_MS = 5_000;

export interface InterpolationConfig {
  /** Whether general `!command` interpolation inside skill/command files is enabled. Default false. */
  readonly enabled: boolean;
  /** Commands permitted as interpolation targets (empty while disabled). */
  readonly allowedCommands: ReadonlySet<string>;
  /** Cap on spliced output bytes. */
  readonly maxOutputBytes: number;
  /** Per-interpolation timeout in ms. */
  readonly timeoutMs: number;
  /** cwd policy: an interpolated command runs at the workspace root only, never an arbitrary directory. */
  readonly cwd: "workspace-root";
}

/**
 * Resolves the interpolation config from the environment. Disabled unless `TREVOR_ENABLE_INTERPOLATION`
 * is exactly "1"; when disabled the allow-list is empty, so no command can ever be an interpolation target.
 */
export function resolveInterpolationConfig(
  env: Record<string, string | undefined>,
): InterpolationConfig {
  const enabled = env[INTERPOLATION_ENV] === "1";
  return {
    enabled,
    allowedCommands: new Set(enabled ? DEFAULT_INTERPOLATION_ALLOWLIST : []),
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    cwd: "workspace-root",
  };
}

/**
 * Whether `command` may be used as an interpolation target: only when the gate is open AND the command is
 * on the allow-list. Both conditions are required, so a disabled gate refuses even an allow-listed command.
 */
export function isInterpolationTargetAllowed(
  config: InterpolationConfig,
  command: string,
): boolean {
  return config.enabled && config.allowedCommands.has(command);
}

/** A redacted, byte-capped interpolation output plus the metadata a diagnostic needs (M6). */
export interface BoundedInterpolationOutput {
  /** The redacted + capped text safe to splice into a body, a prompt, or an export. */
  readonly text: string;
  /** Byte length of {@link text} AFTER redaction + cap (never the raw output length). */
  readonly bytes: number;
  /** Whether the raw output exceeded the byte budget and was truncated. */
  readonly truncated: boolean;
}

/**
 * Redacts secrets + absolute paths from interpolated output, then caps it to the byte budget with an
 * explicit truncation marker, returning the capped text plus its size + truncation flag. Uses
 * {@link redactSecrets} + {@link collapsePaths} directly (not the telemetry attribute redactor, which
 * length-caps to a few hundred chars) so the byte budget - not a telemetry limit - governs how much of a
 * legitimately large export is spliced in. Redaction runs BEFORE the cap, so a secret near the boundary is
 * still masked before anything is truncated.
 */
export function boundInterpolationOutput(
  config: InterpolationConfig,
  output: string,
): BoundedInterpolationOutput {
  const redacted = collapsePaths(redactSecrets(output));
  if (redacted.length <= config.maxOutputBytes) {
    return { text: redacted, bytes: redacted.length, truncated: false };
  }
  const text = `${redacted.slice(0, config.maxOutputBytes)}\n… [truncated at ${config.maxOutputBytes} bytes]`;
  return { text, bytes: text.length, truncated: true };
}

/**
 * Redacts secrets + absolute paths from interpolated output and caps it to the byte budget. The original
 * plan-14 consumer signature (string in, string out); {@link boundInterpolationOutput} is the metadata
 * variant the diagnostics path uses.
 */
export function applyInterpolationOutputPolicy(
  config: InterpolationConfig,
  output: string,
): string {
  return boundInterpolationOutput(config, output).text;
}

/**
 * Splits a whole-line `!command` into its command NAME (argv[0]) and the remaining ARG string. The name is
 * what the allow-list gates; the args are handed to the target command's OWN validated parser as inert
 * data. This is the shell-injection defense (plan 40, D-007): a pattern's metacharacters (`;`, `|`, `$(…)`,
 * backticks) live entirely inside `args` and are never interpolated into a shell string, so the gated
 * command-file lane runs an in-process command with an opaque argument blob rather than spawning a shell.
 */
export function splitInterpolationArgv(line: string): {
  readonly name: string;
  readonly args: string;
} {
  const match = line.trim().match(/^(\S+)\s*([\s\S]*)$/);
  return { name: match?.[1] ?? "", args: (match?.[2] ?? "").trim() };
}

/** Wraps a bounded, human-visible reason in the interpolation refusal marker spliced at a denied site. */
export function interpolationRefusal(reason: string): string {
  return `[interpolation refused: ${reason}]`;
}

/** How one interpolation site resolved (M6 diagnostics). */
export type InterpolationStatus =
  /** Ran and its bounded output was spliced. */
  | "expanded"
  /** Gate closed or command not on the allow-list - nothing ran; a marker (or the literal) was kept. */
  | "refused"
  /** The allow-listed command ran but returned a non-zero result; its bounded error was spliced. */
  | "failed";

/**
 * One structured, redaction-safe diagnostic for an interpolation site (M6). It carries only bounded,
 * low-cardinality fields - the target NAME (redacted), the gate state, and byte/timing COUNTS - and never
 * the raw command output, so emitting it can't leak a large or secret-bearing expansion.
 */
export interface InterpolationDiagnostic {
  readonly source: InterpolationSource;
  /** The env gate for this source (e.g. `TREVOR_ENABLE_INTERPOLATION`). */
  readonly gate: string;
  readonly gateOpen: boolean;
  /** The attempted command name (argv[0]), redacted; `(block)` for a fenced script with no single name. */
  readonly target: string;
  /** Whether {@link target} was on the allow-list at the time. */
  readonly allowed: boolean;
  readonly status: InterpolationStatus;
  /** Byte length of the spliced text AFTER redaction + cap (the marker length for a refusal). Never the
   *  raw command output - only a count crosses this boundary. */
  readonly outputBytes: number;
  readonly truncated: boolean;
  readonly durationMs: number;
}

/** Redacts a diagnostic's free-text `target` (a command name) so even a diagnostic can't carry a secret. */
export function redactDiagnosticTarget(target: string): string {
  return collapsePaths(redactSecrets(target));
}
