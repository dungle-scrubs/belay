import type { CommandSpec, InternetSnapshot, SourceSummary } from "@trevor/session";
import { buildInitProposal } from "./context/init-agents";
import { buildDoctorCommandResult } from "./doctor/build";
import { supervisor } from "./processes";
import type { ProviderRegistry } from "./providers";
import { buildSkillCommand } from "./skills";
import { runCommand } from "./tools/run-shell";

/**
 * Immediate host commands (slash commands): the host runs these directly and
 * publishes a command.result, instead of routing the text to the model. This is
 * the V2 form of the old RPC "immediate host commands" lane (plan H-016) -
 * adapted to the Richter transport, where the browser publishes a user.command and
 * the leader answers with command.result.
 *
 * Each command is a spec (announced in host.online so the browser knows which
 * slashes are commands and can drive a slash menu) plus a run() that returns the
 * text to render. New commands are one entry here - they surface in /help and the
 * announced inventory automatically.
 */

/**
 * The full set of runtime facts main.ts can supply to a command. It is assembled ONCE per
 * invocation in main.ts; an individual command never receives it whole - each command's `select`
 * picks the narrow slice it actually reads (see Command), so adding a context field doesn't widen
 * every command's input and a command can't reach a fact it has no business reading.
 */
export interface CommandContext {
  readonly providers: ProviderRegistry;
  readonly cwd: string;
  readonly workspace: string;
  readonly instanceId: string;
  readonly role: string;
  /** Live turn-machine snapshot (host orchestrator state), for /doctor. */
  readonly host?: Record<string, unknown>;
  /** The host's public-internet snapshot (D-060), for the /doctor Internet area. */
  readonly internet?: InternetSnapshot;
  /** The current branch (or `detached <sha>`), for the /doctor Workspace area. */
  readonly branch?: string;
  /** Election internals (lease.debugInfo), for /doctor. */
  readonly lease?: Record<string, unknown>;
  /** Redacted provider catalog source summaries, for /doctor. */
  readonly catalog?: readonly SourceSummary[];
  /** Forces one cross-turn compaction fold now and resolves with a human-readable result line
   *  (D-040), for /compact. Absent when the host cannot compact (e.g. not the live leader). */
  readonly compact?: () => Promise<string>;
}

/** The /doctor slice: the host-health facts it reports (no compaction hook). */
export type DoctorInput = Omit<CommandContext, "compact">;

/** The /compact slice: just the optional compaction hook. */
export interface CompactInput {
  readonly compact?: () => Promise<string>;
}

/**
 * One immediate command: its announced spec, a `select` that derives the command's NARROW input
 * (`I`) from the full CommandContext - the only fields its `run` may read - and the `run` that
 * produces the result text. A command that needs no context uses `I = void`. The registry always
 * calls `run(args, select(ctx))`, so each command declares its own input shape instead of every
 * command sharing one wide context.
 */
export interface Command<I = void> {
  readonly spec: CommandSpec;
  readonly select: (ctx: CommandContext) => I;
  run(args: string, input: I): Promise<string> | string;
}

/** The command registry: the announced specs plus a name -> result runner. */
export interface CommandRegistry {
  readonly specs: readonly CommandSpec[];
  run(name: string, args: string, ctx: CommandContext): Promise<{ text: string; ok: boolean }>;
}

const noContext = (): void => undefined;

function buildHelpCommand(commands: readonly Command<unknown>[]): Command {
  return {
    spec: { name: "/help", summary: "List available host commands" },
    select: noContext,
    run: () => commands.map((c) => `${c.spec.usage ?? c.spec.name} - ${c.spec.summary}`).join("\n"),
  };
}

function buildInitCommand(): Command<Pick<CommandContext, "cwd">> {
  return {
    spec: {
      name: "/init",
      summary: "Draft or refresh AGENTS.md from repository evidence",
    },
    select: ({ cwd }) => ({ cwd }),
    run: (_args, input) => buildInitProposal(input.cwd).preview,
  };
}

function buildDoctorCommand(): Command<DoctorInput> {
  return {
    spec: {
      name: "/doctor",
      summary: "Host health dashboard (providers, internet, tools, workspace)",
    },
    select: ({
      providers,
      cwd,
      workspace,
      instanceId,
      role,
      host,
      internet,
      branch,
      lease,
      catalog,
    }) => ({
      providers,
      cwd,
      workspace,
      instanceId,
      role,
      host,
      internet,
      branch,
      lease,
      catalog,
    }),
    run: (args, input) => buildDoctorCommandResult(args, input),
  };
}

function buildShellCommand(): Command {
  return {
    spec: {
      name: "/shell",
      summary: "Run a shell command on the host",
      usage: "/shell <command>",
    },
    select: noContext,
    run: async (args) => {
      const command = args.trim();
      if (!command) {
        return "usage: /shell <command>";
      }
      return (await runCommand(command)).output;
    },
  };
}

function buildHostOwnedCommand(spec: CommandSpec, message: string): Command {
  return {
    spec,
    select: noContext,
    run: () => message,
  };
}

function buildCompactCommand(): Command<CompactInput> {
  return {
    spec: { name: "/compact", summary: "Fold older turns into a summary to free context" },
    select: ({ compact }) => ({ compact }),
    run: async (_args, { compact }) => {
      if (!compact) {
        return "Compaction is unavailable (only the live leader can compact).";
      }
      return compact();
    },
  };
}

function buildJobsCommand(): Command {
  return {
    spec: { name: "/jobs", summary: "List background processes" },
    select: noContext,
    run: () => {
      const jobs = supervisor.list();
      if (!jobs.length) {
        return "No background processes.";
      }
      return jobs
        .map((j) => {
          const exit = j.exitCode != null ? ` (exit ${j.exitCode})` : "";
          return `${j.id}  ${j.status}${exit}  ${Math.round(j.ageMs / 1000)}s  ${j.command}`;
        })
        .join("\n");
    },
  };
}

function buildJobsStopCommand(): Command {
  return {
    spec: {
      name: "/jobs-stop",
      summary: "Stop a background process",
      usage: "/jobs-stop <id>",
    },
    select: noContext,
    run: (args) => {
      const id = args.trim();
      if (!id) {
        return "usage: /jobs-stop <id>";
      }
      const result = supervisor.kill(id);
      return `${result.id} -> ${result.status}`;
    },
  };
}

export function buildCommandRegistry(): CommandRegistry {
  const commands: Command<unknown>[] = [];
  /** Registers a command, preserving its narrow input type at the declaration site. */
  const add = <I>(command: Command<I>): void => {
    commands.push(command as Command<unknown>);
  };
  add(buildHelpCommand(commands));
  add(buildInitCommand());
  add(buildDoctorCommand());
  add(buildShellCommand());
  add(
    buildHostOwnedCommand(
      { name: "/clear", summary: "Start a fresh session" },
      "Clear is handled by the live host.",
    ),
  );
  add(
    buildHostOwnedCommand(
      {
        name: "/cd",
        summary: "Switch directories in a fresh session",
        usage: "/cd <directory>",
      },
      "Directory switching is handled by the live host.",
    ),
  );
  add(buildCompactCommand());
  add(
    buildHostOwnedCommand(
      {
        name: "/handoff",
        summary: "Hand off to a fresh session with a continuation prompt",
        usage: "/handoff [--generate | --direct] <prompt>",
      },
      "Handoff is handled by the live host.",
    ),
  );

  for (const spec of [
    {
      name: "/continue",
      summary: "Continue after a paused turn",
    },
    {
      name: "/compress",
      summary: "Compact context, then continue",
    },
    {
      name: "/retry",
      summary: "Retry the last user prompt",
    },
  ] as const) {
    add(buildHostOwnedCommand(spec, `${spec.name} is handled by the live host.`));
  }

  // /skills is owned by skills.ts (it knows skill discovery); registered here as one line.
  add(buildSkillCommand());
  add(buildJobsCommand());
  add(buildJobsStopCommand());

  const byName = new Map(commands.map((c) => [c.spec.name, c]));

  return {
    specs: commands.map((c) => c.spec),
    async run(name, args, ctx) {
      const command = byName.get(name);
      if (!command) {
        return { text: `unknown command ${name} - try /help`, ok: false };
      }
      try {
        // Hand the command only its own slice of the context (select), never the whole thing.
        return { text: await command.run(args, command.select(ctx)), ok: true };
      } catch (error) {
        return {
          text: `error: ${error instanceof Error ? error.message : String(error)}`,
          ok: false,
        };
      }
    },
  };
}
