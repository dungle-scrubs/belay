import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type CommandSpec,
  type InternetSnapshot,
  RUNTIME_KIND,
  UNKNOWN_INTERNET,
} from "@trevor/session";
import { Effect } from "effect";
import { buildDoctorSnapshot, type DoctorProviderProbe } from "./doctor/snapshot";
import { fmtFields } from "./log";
import { supervisor } from "./processes";
import type { ProviderRegistry } from "./providers";
import { buildSkillCommand } from "./skills";
import { TOOL_DEFS } from "./tools";
import { renderShell, runShell } from "./tools/run-shell";

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

/** One provider's reachability/warmth line for /doctor, defensively probed. */
async function providerStatus(key: string, provider: ProviderRegistry[string]): Promise<string> {
  let status: string;
  try {
    const { ready, warm } = await Effect.runPromise(provider.readiness());
    status = ready ? (warm ? "warm" : "cold") : "unreachable";
  } catch {
    status = "unreachable";
  }
  // Adapters that expose inspectable state (e.g. LM Studio's served context / last load
  // error) get an indented detail line; cloud providers with nothing to add stay terse.
  const info = provider.debugInfo?.();
  const detail = info ? `\n      ${fmtFields(info)}` : "";
  return `  ${key} - ${provider.label} (${provider.model}) - ${status}${detail}`;
}

/** Structured provider reachability for the /doctor snapshot (warm/cold/unreachable + kind). */
async function doctorProviderProbe(
  key: string,
  provider: ProviderRegistry[string],
): Promise<DoctorProviderProbe> {
  let status: DoctorProviderProbe["status"];
  try {
    const { ready, warm } = await Effect.runPromise(provider.readiness());
    status = ready ? (warm ? "warm" : "cold") : "unreachable";
  } catch {
    status = "unreachable";
  }
  return { key, label: provider.label, model: provider.model, kind: provider.kind, status };
}

/** Abbreviates the home dir to `~` for a sanitized /doctor path. */
function abbrevHome(absolute: string): string {
  const home = homedir();
  return absolute === home || absolute.startsWith(`${home}/`)
    ? `~${absolute.slice(home.length)}`
    : absolute;
}

/** The TREVOR_HOME path (env override or `~/.trevorV2`). */
function trevorHome(): string {
  return process.env.TREVOR_HOME ?? join(homedir(), ".trevorV2");
}

/** Whether a directory is writable (a bounded fs probe for the /doctor Storage area). */
async function storageWritable(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Reads a string field off the host turn-machine record (the /doctor session facts). */
function hostStr(host: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = host?.[key];
  return typeof value === "string" ? value : undefined;
}

/** The legacy plaintext /doctor dump (`/doctor text`), kept for terminals / no-dashboard clients. */
async function doctorText(input: DoctorInput): Promise<string> {
  const lines: string[] = [`workspace: ${input.workspace}`];
  if (input.cwd !== input.workspace) {
    lines.push(`cwd: ${input.cwd}`);
  }
  lines.push(`host: ${input.instanceId} (${input.role})`);
  if (input.host) {
    lines.push(`turn: ${fmtFields(input.host)}`);
  }
  if (input.lease) {
    lines.push(`lease: ${fmtFields(input.lease)}`);
  }
  lines.push("", "providers:");
  const statuses = await Promise.all(
    Object.entries(input.providers).map(([key, provider]) => providerStatus(key, provider)),
  );
  lines.push(...statuses, "", `tools: ${TOOL_DEFS.map((t) => t.name).join(", ")}`);
  return lines.join("\n");
}

export function buildCommandRegistry(): CommandRegistry {
  const commands: Command<unknown>[] = [];
  /** Registers a command, preserving its narrow input type at the declaration site. */
  const add = <I>(command: Command<I>): void => {
    commands.push(command as Command<unknown>);
  };
  /** The shared selector for commands that read no runtime context. */
  const none = (): void => undefined;

  add({
    spec: { name: "/help", summary: "List available host commands" },
    select: none,
    run: () => commands.map((c) => `${c.spec.usage ?? c.spec.name} - ${c.spec.summary}`).join("\n"),
  });

  add<DoctorInput>({
    spec: {
      name: "/doctor",
      summary: "Host health dashboard (providers, internet, tools, workspace)",
    },
    select: ({ providers, cwd, workspace, instanceId, role, host, internet, branch, lease }) => ({
      providers,
      cwd,
      workspace,
      instanceId,
      role,
      host,
      internet,
      branch,
      lease,
    }),
    run: async (args, input) => {
      // `/doctor text` keeps the legacy plaintext dump (terminals / no-dashboard clients); the
      // default emits the structured doctor.current snapshot the web renders as a dashboard.
      if (args.trim() === "text") {
        return doctorText(input);
      }
      const home = trevorHome();
      const [providers, writable] = await Promise.all([
        Promise.all(
          Object.entries(input.providers).map(([key, provider]) =>
            doctorProviderProbe(key, provider),
          ),
        ),
        storageWritable(home),
      ]);
      const snapshot = buildDoctorSnapshot({
        host: { instanceId: input.instanceId, role: input.role, live: input.role !== "standby" },
        session: {
          activeRun: hostStr(input.host, "activeRun"),
          queued: typeof input.host?.queued === "number" ? input.host.queued : 0,
          lastTurn: hostStr(input.host, "lastTurn"),
          compacting: input.host?.compacting === true,
        },
        providers,
        internet: input.internet ?? UNKNOWN_INTERNET,
        tools: TOOL_DEFS.map((t) => t.name),
        workspace: { cwd: input.cwd, workspace: input.workspace, branch: input.branch },
        storage: { home: abbrevHome(home), writable },
        // Package/build/version facts (D-073): the embedded version when present (else a dev build),
        // plus the always-available Node + runtime kind. Update-availability is not probed here.
        build: {
          version: process.env.npm_package_version ?? null,
          node: process.version,
          runtime: RUNTIME_KIND.host,
        },
        checkedAt: new Date().toISOString(),
      });
      return JSON.stringify(snapshot);
    },
  });

  add({
    spec: {
      name: "/shell",
      summary: "Run a shell command on the host",
      usage: "/shell <command>",
    },
    select: none,
    run: async (args) => {
      const command = args.trim();
      if (!command) {
        return "usage: /shell <command>";
      }
      // Shared runShell carries the safety classifier, timeout, and output cap; render its
      // result inline (byte-identical to the old refusal/failure/output strings).
      return renderShell(await runShell(command));
    },
  });

  add({
    spec: { name: "/clear", summary: "Start a fresh session" },
    select: none,
    // The actual switch is owned by main.ts because it has the session transport and process
    // lifecycle. This fallback only protects direct registry calls.
    run: () => "Clear is handled by the live host.",
  });

  add({
    spec: {
      name: "/cd",
      summary: "Switch directories in a fresh session",
      usage: "/cd <directory>",
    },
    select: none,
    // The actual switch is owned by main.ts because it has filesystem, session transport, and
    // process lifecycle access. This fallback only protects direct registry calls.
    run: () => "Directory switching is handled by the live host.",
  });

  add<CompactInput>({
    spec: { name: "/compact", summary: "Fold older turns into a summary to free context" },
    select: ({ compact }) => ({ compact }),
    // The fold itself (plan + summarize + emit context.compacted) runs in the host, since it
    // needs the live event log + provider; this command just triggers it and reports the result.
    run: async (_args, { compact }) => {
      if (!compact) {
        return "Compaction is unavailable (only the live leader can compact).";
      }
      return compact();
    },
  });

  // /skills is owned by skills.ts (it knows skill discovery); registered here as one line.
  add(buildSkillCommand());

  add({
    spec: { name: "/jobs", summary: "List background processes" },
    select: none,
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
  });

  add({
    spec: {
      name: "/jobs-stop",
      summary: "Stop a background process",
      usage: "/jobs-stop <id>",
    },
    select: none,
    run: (args) => {
      const id = args.trim();
      if (!id) {
        return "usage: /jobs-stop <id>";
      }
      // kill throws ProcessError on an unknown id; the registry's run() try/catch renders it.
      const result = supervisor.kill(id);
      return `${result.id} -> ${result.status}`;
    },
  });

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
