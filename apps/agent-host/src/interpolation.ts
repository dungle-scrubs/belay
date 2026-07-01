import { collapsePaths, redactSecrets } from "@trevor/session/telemetry";

/**
 * The general-interpolation TRUST GATE (plan 14, M7, D-003). "Interpolation" is expanding a `!command`
 * embedded in a skill or command file by RUNNING it and splicing its output in. That can execute
 * arbitrary commands, so it is a SEPARATE, configurable feature that is DISABLED BY DEFAULT and turned on
 * only by an explicit environment opt-in. This plan defines the safe consumer boundary - the gate, the
 * allow-list, and the output/timeout/cwd/redaction policy - but deliberately does NOT ship a general
 * interpolation runtime (escape hatch 2: that stays a later plan).
 *
 * The built-in `trevor-expert` is INDEPENDENT of this gate (D-004): it reads the capability manifest
 * through the direct host seam (`manifest/source.ts` `currentManifest`), so it works whether or not general
 * interpolation is enabled. This module governs ONLY untrusted `!command` expansion inside skill/command
 * files.
 */

/** The env var that gates general interpolation. Only the exact opt-in "1" enables it. */
const INTERPOLATION_ENV = "TREVOR_ENABLE_INTERPOLATION";

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

/**
 * Redacts secrets + absolute paths from interpolated output, then caps it to the byte budget with an
 * explicit truncation marker. Uses {@link redactSecrets} + {@link collapsePaths} directly (not the
 * telemetry attribute redactor, which length-caps to a few hundred chars) so the byte budget - not a
 * telemetry limit - governs how much of a legitimately large export is spliced in.
 */
export function applyInterpolationOutputPolicy(
  config: InterpolationConfig,
  output: string,
): string {
  const redacted = collapsePaths(redactSecrets(output));
  if (redacted.length <= config.maxOutputBytes) {
    return redacted;
  }
  return `${redacted.slice(0, config.maxOutputBytes)}\n… [truncated at ${config.maxOutputBytes} bytes]`;
}
