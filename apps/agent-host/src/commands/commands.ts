import {
  buildDoctorCommandResult,
  type DoctorCommandInput,
  type DoctorProbeOptions,
  type DoctorRuntimeFacts,
} from "@host/doctor/build";
import { buildLoopCommands } from "@host/loop/command";
import type { LoopController } from "@host/loop/store";
import { buildTrevorExportCommand } from "@host/manifest/export-command";
import { loadStylePref, saveStylePref } from "@host/prefs/style-store";
import { handleStyleCommand } from "@host/prefs/styles";
import { resolveVimToggle, saveVimPref, vimEnabled } from "@host/prefs/vim-store";
import { supervisor } from "@host/processes/processes";
import { buildInitProposal } from "@host/project-context/init-agents";
import type { ProviderRegistry } from "@host/providers/index";
import { buildSkillCommand } from "@host/skills/skills";
import { runCommand } from "@host/tools/run-shell";
import { msg } from "@host/transport/messages";
import type { CommandMenuPayload, CommandSpec } from "@trevor/session";
import type { LoadedCommandFile } from "./command-loader";

/**
 * Immediate host commands (slash commands): the host runs these directly and
 * publishes a command.result, instead of routing the text to the model. This is
 * the V2 form of the old RPC "immediate host commands" lane (plan H-016) -
 * adapted to the Tether transport, where the browser publishes a user.command and
 * the leader answers with command.result.
 *
 * Each command is a spec (announced in host.online so the browser knows which
 * slashes are commands and can drive a slash menu) plus a run() that returns the
 * text to render. New commands are one entry here - they surface in /help and the
 * announced inventory automatically.
 *
 * Responsible for: the immediate-command registry - specs, narrow context slices, run dispatch.
 * Not for: debug-gated specs (debug-commands.ts) or `!` interpolation gating (interpolation.ts).
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
  /** The opaque /doctor fact bag. A new doctor fact changes host-facts, not CommandContext. */
  readonly doctor: DoctorRuntimeFacts;
  /** Optional bounded-probe wiring for /doctor, such as the host telemetry sink. */
  readonly doctorProbeOptions?: DoctorProbeOptions;
  /** Forces one cross-turn compaction fold now and resolves with a human-readable result line
   *  (D-040), for /compact. Absent when the host cannot compact (e.g. not the live leader). */
  readonly compact?: () => Promise<string>;
  /** The live loop runtime the `/loop` family drives (plan 17). Absent when loops are unavailable (e.g.
   *  not the live leader); the command then answers with a parse preview instead of executing. */
  readonly loops?: LoopController;
}

/** The /doctor slice: the host-health facts plus provider registry it reports. */
export type DoctorInput = DoctorCommandInput;

/** The /compact slice: just the optional compaction hook. */
export interface CompactInput {
  readonly compact?: () => Promise<string>;
}

/** What a command's `run` may return: bare result text, or text plus an optional nested command-menu
 *  payload (plan 03) and/or an explicit ok. A plain string is shorthand for `{ text, ok: true }`. */
export interface CommandRunResult {
  readonly text: string;
  readonly ok?: boolean;
  readonly menu?: CommandMenuPayload;
}

/**
 * One immediate command: its announced spec, a `select` that derives the command's NARROW input
 * (`I`) from the full CommandContext - the only fields its `run` may read - and the `run` that
 * produces the result text (or a {@link CommandRunResult} with a menu). A command that needs no context
 * uses `I = void`. The registry always calls `run(args, select(ctx))`, so each command declares its own
 * input shape instead of every command sharing one wide context.
 */
export interface Command<I = void> {
  readonly spec: CommandSpec;
  readonly select: (ctx: CommandContext) => I;
  run(args: string, input: I): Promise<string | CommandRunResult> | string | CommandRunResult;
}

/** The command registry: the announced specs plus a name -> result runner. */
export interface CommandRegistry {
  readonly specs: readonly CommandSpec[];
  run(
    name: string,
    args: string,
    ctx: CommandContext,
  ): Promise<{ text: string; ok: boolean; menu?: CommandMenuPayload }>;
  /**
   * The loaded command FILE for `name`, when the name resolves to a `.trevor/commands/*.md` command
   * (plan 44.5) - the signal to the dispatch that this name takes the SUBMIT branch (expand its body
   * into a user.message prompt) rather than `run()` (which produces a command.result). `undefined` for
   * a built-in command or an unknown name, so those keep their existing lane.
   */
  commandFile(name: string): LoadedCommandFile | undefined;
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
    select: ({ providers, doctor, doctorProbeOptions }) => ({
      ...doctor,
      ...(doctorProbeOptions ? { probeOptions: doctorProbeOptions } : {}),
      providers,
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

/**
 * `/style [id|reset]` (plan 03): bare renders the output-style chooser as a nested command-menu payload
 * (the web's generic renderer draws it); `/style <id>` (or a menu-row dispatch) selects + persists a
 * style under the config home; `/style reset` returns to default. Presentation-only - it changes nothing
 * but the active style preference, read at turn start for response shaping + run attribution.
 */
function buildStyleCommand(): Command {
  return {
    spec: { name: "/style", summary: "Choose the output style", usage: "/style [id|reset]" },
    select: noContext,
    run: (args): CommandRunResult => {
      const result = handleStyleCommand(args, loadStylePref().activeStyle);
      if (result.kind === "menu") {
        return { text: result.menu.title, menu: result.menu };
      }
      if (result.kind === "selected") {
        saveStylePref(result.styleId);
        return { text: result.text };
      }
      return { text: result.text, ok: false };
    },
  };
}

/**
 * `/vim [on|off]` (plan 07): toggles (bare) or sets the Vim prompt-motions preference, persisting it
 * under the config home via the shared {@link saveVimPref} (same store plan 06 reads at startup).
 * `main.ts` re-announces `host.online` after a `/vim`, so the web's `vimEnabled` flips without a restart.
 * The palette's `Toggle Vim mode` action dispatches the bare form.
 */
function buildVimCommand(): Command {
  return {
    spec: { name: "/vim", summary: "Toggle Vim prompt motions", usage: "/vim [on|off]" },
    select: noContext,
    run: (args): CommandRunResult => {
      const result = resolveVimToggle(args, vimEnabled());
      if (!result.ok) {
        return { text: "usage: /vim [on|off]", ok: false };
      }
      saveVimPref(result.enabled);
      return { text: `Vim mode ${result.enabled ? "enabled" : "disabled"}` };
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

export function buildCommandRegistry(
  commandFiles: readonly LoadedCommandFile[] = [],
  /** Command names owned by handlers OUTSIDE this registry - the programmatic dispatcher (`/clear`,
   *  `/worktree-*`, ...) and the debug specs (`/restart`, `/stop`, ...). A `.trevor/commands/<name>.md`
   *  matching one of these is dropped from file registration: those names dispatch to their real handler,
   *  so announcing a file spec (with a substitution preview) for them would both double-list the name and
   *  advertise behavior the file never runs. The registry's own built-ins are excluded separately (`byName`). */
  reservedNames: ReadonlySet<string> = new Set(),
): CommandRegistry {
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
        name: "/clip",
        summary: "Copy the last reply, or run a clipboard-only request",
        usage: "/clip [request]",
      },
      "Clip is handled by the live host.",
    ),
  );
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
  add(buildStyleCommand());
  // /trevor-export owns the capability manifest export (plan 14); it reads the live manifest through a
  // source seam registered by main.ts, so it needs no CommandContext.
  add(buildTrevorExportCommand());
  add(buildVimCommand());
  add(buildJobsCommand());
  add(buildJobsStopCommand());
  // `/loop` + `/loops`: the host-owned recurring-work command family (plan 17). Both parse authoritatively
  // through the shared parser and return a structured, UI-neutral result.
  for (const loopCommand of buildLoopCommands()) {
    add(loopCommand);
  }

  const byName = new Map(commands.map((c) => [c.spec.name, c]));

  // File-loaded commands (plan 44.5): register each `.trevor/commands/*.md` command's SPEC so it is
  // announced on host.online (the web menu lists it + `parseCommand` routes it), and hold a name->file
  // map so the dispatch can take the SUBMIT branch. A built-in command of the same name always wins - a
  // dropped-in file can never shadow a real host command handler.
  const commandFilesByName = new Map<string, LoadedCommandFile>();
  const fileSpecs: CommandSpec[] = [];
  for (const file of commandFiles) {
    if (byName.has(file.id) || reservedNames.has(file.id) || commandFilesByName.has(file.id)) {
      continue;
    }
    commandFilesByName.set(file.id, file);
    fileSpecs.push({
      name: file.id,
      summary: file.summary,
      // The body rides the spec so the web renders a live substitution preview (plan 44.5 M5/M6).
      body: file.body,
      ...(file.argumentHint !== undefined
        ? { usage: `${file.id} ${file.argumentHint}`, argumentHint: file.argumentHint }
        : {}),
    });
  }

  return {
    specs: [...commands.map((c) => c.spec), ...fileSpecs],
    commandFile: (name) => commandFilesByName.get(name),
    async run(name, args, ctx) {
      const command = byName.get(name);
      if (!command) {
        return { text: `unknown command ${name} - try /help`, ok: false };
      }
      try {
        // Hand the command only its own slice of the context (select), never the whole thing.
        const result = await command.run(args, command.select(ctx));
        return typeof result === "string"
          ? { text: result, ok: true }
          : {
              text: result.text,
              ok: result.ok ?? true,
              ...(result.menu ? { menu: result.menu } : {}),
            };
      } catch (error) {
        return {
          text: `error: ${msg(error)}`,
          ok: false,
        };
      }
    },
  };
}
