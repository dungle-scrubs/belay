import type { CommandSpec } from "@trevor/richter";
import type { ProviderRegistry } from "./providers";
import { executeTool, TOOL_DEFS } from "./tools";

/**
 * Immediate host commands (slash commands): the host runs these directly and
 * publishes a command.result, instead of routing the text to the model. This is
 * the V2 form of the old RPC "immediate host commands" lane (FEATURES.md H-016) -
 * adapted to the Richter transport, where the browser publishes a user.command and
 * the leader answers with command.result.
 *
 * Each command is a spec (announced in host.online so the browser knows which
 * slashes are commands and can drive a slash menu) plus a run() that returns the
 * text to render. New commands are one entry here - they surface in /help and the
 * announced inventory automatically.
 */

/** Runtime facts a command may report on; supplied fresh per invocation. */
export interface CommandContext {
  readonly providers: ProviderRegistry;
  readonly cwd: string;
  readonly workspace: string;
  readonly instanceId: string;
  readonly role: string;
}

interface Command {
  readonly spec: CommandSpec;
  run(args: string, ctx: CommandContext): Promise<string> | string;
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
    const { ready, warm } = await provider.readiness();
    status = ready ? (warm ? "warm" : "cold") : "unreachable";
  } catch {
    status = "unreachable";
  }
  return `  ${key} - ${provider.label} (${provider.model}) - ${status}`;
}

export function buildCommandRegistry(): CommandRegistry {
  const commands: Command[] = [];

  commands.push({
    spec: { name: "/help", summary: "List available host commands" },
    run: () => commands.map((c) => `${c.spec.usage ?? c.spec.name} - ${c.spec.summary}`).join("\n"),
  });

  commands.push({
    spec: { name: "/doctor", summary: "Host health: workspace, providers, tools" },
    run: async (_args, ctx) => {
      const lines: string[] = [`workspace: ${ctx.workspace}`];
      if (ctx.cwd !== ctx.workspace) {
        lines.push(`cwd: ${ctx.cwd}`);
      }
      lines.push(`host: ${ctx.instanceId} (${ctx.role})`, "", "providers:");
      for (const [key, provider] of Object.entries(ctx.providers)) {
        lines.push(await providerStatus(key, provider));
      }
      lines.push("", `tools: ${TOOL_DEFS.map((t) => t.name).join(", ")}`);
      return lines.join("\n");
    },
  });

  commands.push({
    spec: { name: "/shell", summary: "Run a shell command on the host", usage: "/shell <command>" },
    run: (args) => {
      const command = args.trim();
      if (!command) {
        return "usage: /shell <command>";
      }
      // Reuse the bash tool so /shell inherits its safety classifier, timeout, and
      // output cap rather than spawning a second, unguarded execution path.
      return executeTool("bash", JSON.stringify({ command }));
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
        return { text: await command.run(args, ctx), ok: true };
      } catch (error) {
        return {
          text: `error: ${error instanceof Error ? error.message : String(error)}`,
          ok: false,
        };
      }
    },
  };
}
