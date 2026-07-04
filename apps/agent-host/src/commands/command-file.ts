import type { Command } from "@host/commands/commands";
import {
  boundInterpolationOutput,
  DEFAULT_INTERPOLATION_ALLOWLIST,
  type InterpolationConfig,
  type InterpolationDiagnostic,
  interpolationRefusal,
  isInterpolationTargetAllowed,
  redactDiagnosticTarget,
  splitInterpolationArgv,
} from "@host/commands/interpolation";
import {
  interpolate,
  parseInterpolation,
  type RunnableSegment,
} from "@host/commands/interpolation-engine";
import { buildTrevorExportCommand } from "@host/manifest/export-command";

/**
 * The V2 COMMAND-FILE concept + interpolation loader (plan 40, M2 + M5). A command file is a trusted,
 * file-loaded command DEFINITION (its body may embed `!command` interpolation), as opposed to an
 * immediate TypeScript slash command (commands.ts) or a user's leading-`!` prompt-shell command - neither
 * of which is a file and neither of which interpolates. Interpolation applies to a command file ONLY when
 * (a) the file is TRUSTED (a configured/built-in root, never arbitrary or downloaded content) AND (b) the
 * command-file gate `TREVOR_ENABLE_INTERPOLATION` is open. On any other combination the body loads
 * literally, so the feature is impossible to trigger accidentally.
 *
 * The runtime NEVER spawns a shell for command-file content. The only interpolation targets are
 * allow-listed, read-only, context-free Trevor slash commands (currently `/trevor-export`), dispatched
 * IN-PROCESS through {@link InterpolationCommandRunner}. Combined with the argv split (a pattern's shell
 * metacharacters stay inside the inert arg blob, see interpolation.ts), this makes shell-metacharacter
 * injection from a command file structurally impossible.
 *
 * Responsible for: the command-file trust contract, the in-process allow-listed command runner, and the
 * gated expand-on-load boundary (with redacted output + structured diagnostics).
 * Not for: the gate/allow-list/output policy primitives (interpolation.ts) or the parser
 * (interpolation-engine.ts); registering command HANDLERS (commands.ts) is kept separate from expanding
 * a file BODY (D-008).
 */

/**
 * Where a command file was loaded from, and thus whether it is trusted. Trust is a property of the ROOT,
 * not the file content: `builtin` (shipped host templates) and `project`/`user` (configured roots the
 * operator controls) are trusted; anything else is untrusted and never interpolates. New roots are added
 * here, so the trust decision lives in exactly one place.
 */
export type CommandFileRootKind = "builtin" | "project" | "user" | "untrusted";

/** The trusted root kinds - the single source of truth {@link isTrustedRoot} consults. */
const TRUSTED_ROOTS: ReadonlySet<CommandFileRootKind> = new Set(["builtin", "project", "user"]);

/** Whether a command file's root is trusted enough for its body to be eligible for interpolation. */
export function isTrustedRoot(root: CommandFileRootKind): boolean {
  return TRUSTED_ROOTS.has(root);
}

/** One loaded command file: its id, its root provenance (trust), and its raw body (frontmatter stripped). */
export interface CommandFile {
  readonly id: string;
  readonly rootKind: CommandFileRootKind;
  readonly body: string;
}

/** The result of expanding a command file: the (possibly interpolated) body plus its diagnostics. */
export interface CommandFileExpansion {
  readonly text: string;
  readonly diagnostics: readonly InterpolationDiagnostic[];
}

/**
 * A bounded command the interpolation runtime may run IN-PROCESS. It never spawns a shell for file-derived
 * content: `name` is an allow-listed slash command and `args` is the inert argument blob the command's own
 * parser validates. Returns bounded output + an ok flag and never rejects.
 */
export interface InterpolationCommandRunner {
  run(name: string, args: string): Promise<{ readonly output: string; readonly ok: boolean }>;
}

/**
 * The context-free, allow-listed commands the interpolation runtime may execute in-process. Every entry
 * builds a `Command<void>` that reads NO CommandContext, so the runtime never fabricates a wide host
 * context to run one. The keys MUST equal {@link DEFAULT_INTERPOLATION_ALLOWLIST}; the runner asserts this
 * on construction so the executable map and the string allow-list can never drift apart.
 */
const INTERPOLATION_COMMAND_BUILDERS: Readonly<Record<string, () => Command<void>>> = {
  "/trevor-export": buildTrevorExportCommand,
};

/**
 * The default in-process runner: it maps an allow-listed command name to its context-free builder, runs
 * it with the inert arg blob, and normalizes the result. A name that is not in the executable map is
 * refused here too (defense in depth), so even a drifted allow-list can never dispatch an unknown command.
 */
export function defaultInterpolationCommandRunner(): InterpolationCommandRunner {
  const builderNames = Object.keys(INTERPOLATION_COMMAND_BUILDERS).sort();
  const allowlist = [...DEFAULT_INTERPOLATION_ALLOWLIST].sort();
  if (JSON.stringify(builderNames) !== JSON.stringify(allowlist)) {
    // A broken self-imposed rule: the executable map must mirror the allow-list exactly (plan 40, D-009).
    throw new Error(
      `interpolation runner drift: builders [${builderNames.join(", ")}] != allow-list [${allowlist.join(", ")}]`,
    );
  }
  return {
    async run(name, args) {
      const build = INTERPOLATION_COMMAND_BUILDERS[name];
      if (!build) {
        return {
          output: interpolationRefusal(`"${name}" is not an allowed interpolation target`),
          ok: false,
        };
      }
      const command = build();
      // A Command<void> reads no context, so no CommandContext is fabricated; the args are opaque.
      const result = await command.run(args, undefined);
      return typeof result === "string"
        ? { output: result, ok: true }
        : { output: result.text, ok: result.ok ?? true };
    },
  };
}

/**
 * The command-file SegmentExecutor + diagnostics collector. For each runnable segment it splits the argv,
 * gates the command NAME against the allow-list, and - only when allowed - dispatches it in-process,
 * redacting + capping the output before it is spliced. A denied or failed site becomes a bounded marker,
 * never a crash and never a shell. Every site records one {@link InterpolationDiagnostic} (name redacted,
 * counts only) into `diagnostics`.
 */
function makeCommandFileExecutor(
  config: InterpolationConfig,
  runner: InterpolationCommandRunner,
  diagnostics: InterpolationDiagnostic[],
  now: () => number,
): (segment: RunnableSegment) => Promise<string> {
  const gate = config.enabled;
  return async (segment) => {
    const startedAt = now();
    // A fenced block has no single command name unless its trimmed content is one line; otherwise it is
    // treated as un-named and refused (fail closed). This keeps command-file blocks from smuggling a
    // multi-line script past the single-command allow-list.
    const line = segment.kind === "command" ? segment.command : segment.script.trim();
    const multiLine = line.includes("\n");
    const { name, args } = splitInterpolationArgv(multiLine ? "" : line);
    const target = redactDiagnosticTarget(name || "(block)");
    const allowed = !multiLine && isInterpolationTargetAllowed(config, name);

    const record = (
      status: InterpolationDiagnostic["status"],
      spliced: string,
      truncated: boolean,
    ): string => {
      diagnostics.push({
        source: "command-file",
        gate: "TREVOR_ENABLE_INTERPOLATION",
        gateOpen: gate,
        target,
        allowed,
        status,
        outputBytes: spliced.length,
        truncated,
        durationMs: Math.max(0, now() - startedAt),
      });
      return spliced;
    };

    if (!allowed) {
      const reason = multiLine
        ? "a fenced command block is not a single allow-listed command"
        : `"${name || "(empty)"}" is not an allowed interpolation target`;
      return record("refused", interpolationRefusal(reason), false);
    }

    const result = await runner.run(name, args);
    const bounded = boundInterpolationOutput(config, result.output);
    return record(result.ok ? "expanded" : "failed", bounded.text, bounded.truncated);
  };
}

/**
 * Expands a command file's body at load time (plan 40, M5). When the file is trusted AND the gate is open,
 * `!command` sites and ```` ```! ```` blocks are interpolated through the allow-listed in-process runner;
 * otherwise the body is returned LITERALLY (fail closed) with a single diagnostic recording why. The
 * interpolation happens here, before the body is ever used as a command definition or fed to a prompt, so
 * the caps + redaction are applied at this boundary and not later in provider code.
 *
 * `now` is injectable for deterministic duration assertions; `runner` defaults to the in-process runner.
 */
export async function expandCommandFile(
  file: CommandFile,
  config: InterpolationConfig,
  options: {
    readonly runner?: InterpolationCommandRunner;
    readonly now?: () => number;
  } = {},
): Promise<CommandFileExpansion> {
  const now = options.now ?? Date.now;
  const trusted = isTrustedRoot(file.rootKind);

  // Fail closed: an untrusted file or a closed gate never runs anything - the body stays literal. One
  // diagnostic records the reason so a "why didn't my command file interpolate?" question is answerable.
  if (!trusted || !config.enabled) {
    const commandSites = parseInterpolation(file.body).filter((s) => s.kind !== "literal").length;
    return {
      text: file.body,
      diagnostics:
        commandSites === 0
          ? []
          : [
              {
                source: "command-file",
                gate: "TREVOR_ENABLE_INTERPOLATION",
                gateOpen: config.enabled,
                target: "(literal)",
                allowed: false,
                status: "refused",
                outputBytes: 0,
                truncated: false,
                durationMs: 0,
              },
            ],
    };
  }

  const runner = options.runner ?? defaultInterpolationCommandRunner();
  const diagnostics: InterpolationDiagnostic[] = [];
  const text = await interpolate(
    file.body,
    makeCommandFileExecutor(config, runner, diagnostics, now),
  );
  return { text, diagnostics };
}
