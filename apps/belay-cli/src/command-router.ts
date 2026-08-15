import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { TrevorClient } from "@belay/sdk";
import { resolveModelConfig } from "./config";
import {
  runArtifactGet,
  runArtifactPut,
  runCancel,
  runCapabilities,
  runDoctor,
  runPrompt,
  runTranscript,
} from "./headless";
import { type HostControlIo, type LifecycleIo, runArchive, runList, runStop } from "./lifecycle";
import { formatCatalog, resolveModelRef } from "./model-flags";
import { withCliStage } from "./stage-error";

/**
 * Table-driven CLI command router.
 *
 * Responsible for: command metadata, usage generation, flag/positional parsing, artifact MIME
 * inference, and dispatch to lifecycle/headless command implementations.
 * Not for: process startup, SDK construction, host launch/open flows, or top-level error handling.
 */

export interface CommandSpec {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
}

export const COMMAND_SPECS: readonly CommandSpec[] = [
  {
    name: "list",
    usage: "belay list [--archived]",
    summary: "List this project's sessions (active by default; --archived for filed).",
  },
  { name: "archive", usage: "belay archive <session>", summary: "Archive a session." },
  { name: "unarchive", usage: "belay unarchive <session>", summary: "Unarchive a session." },
  {
    name: "stop",
    usage: "belay stop <session>",
    summary: "Gracefully shut down the session's host (SIGTERM).",
  },
  {
    name: "kill",
    usage: "belay kill <session>",
    summary: "Force-terminate a wedged session host (SIGKILL).",
  },
  {
    name: "prompt",
    usage: "belay prompt <session> <text>",
    summary: "Submit a prompt and stream the turn (--json, --model, --reasoning, --timeout).",
  },
  {
    name: "models",
    usage: "belay models",
    summary: "List host-announced model ids and reasoning levels (--json).",
  },
  {
    name: "cancel",
    usage: "belay cancel <session> <runId>",
    summary: "Cancel the active run (publishes user.cancel; not stop/kill).",
  },
  {
    name: "transcript",
    usage: "belay transcript <session>",
    summary: "Print the session transcript (--json for machine output).",
  },
  { name: "doctor", usage: "belay doctor <session>", summary: "Print the host /doctor snapshot." },
  {
    name: "capabilities",
    usage: "belay capabilities <session>",
    summary: "Print the host capability manifest export (--json, --section).",
  },
  {
    name: "artifact",
    usage: "belay artifact put <file> | belay artifact get <hash> [outfile]",
    summary: "Upload or download a content-addressed artifact.",
  },
];

export function commandUsageText(): string {
  const commandLines = COMMAND_SPECS.map((spec) => `  ${spec.usage.padEnd(36)} ${spec.summary}`);
  return `belay - open this project in Belay

Usage:
  belay                               Resolve the project, ready services, spawn or reuse host, and open.
  belay -p "prompt"                   Run one prompt headlessly; add --json, --model, --reasoning, --ephemeral.
  belay open <session>                Open/resume a session by id in the browser.
${commandLines.join("\n")}
  belay --debug                       Start the host in debug mode (extra commands like /restart).
  belay --help                        Show this help.
  belay --version                     Show the launcher version.
`;
}

/** A flag's value from `--flag value`, or undefined when the flag is absent. */
export function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/** Positional args (everything that is not a `--flag` or a value consumed by one). */
export function positionals(args: readonly string[], valueFlags: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg.startsWith("--")) {
      if (valueFlags.includes(arg)) {
        i += 1;
      }
      continue;
    }
    out.push(arg);
  }
  return out;
}

const MIME_BY_EXT: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
};

export function inferMime(path: string, explicit?: string): string {
  return explicit ?? MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export interface CommandRouterDeps {
  readonly client: TrevorClient;
  readonly lifecycleIo: LifecycleIo;
  readonly hostControlIo: HostControlIo;
  readonly projectName: () => string;
  readonly readFile?: (path: string) => Uint8Array;
  readonly writeFile?: (path: string, bytes: Uint8Array) => void;
  readonly writeStdoutBytes?: (bytes: Uint8Array) => void;
  readonly writeStderrText?: (text: string) => void;
  readonly ensureHostOnline?: () => Promise<{ readonly sessionId: string }>;
}

export interface CommandRouter {
  runSubcommand(args: readonly string[]): Promise<string | null>;
}

export function createCommandRouter(deps: CommandRouterDeps): CommandRouter {
  const readFile = deps.readFile ?? ((path) => new Uint8Array(readFileSync(path)));
  const writeFile = deps.writeFile ?? ((path, bytes) => writeFileSync(path, bytes));
  const writeStdoutBytes = deps.writeStdoutBytes ?? ((bytes) => process.stdout.write(bytes));
  const writeStderrText = deps.writeStderrText ?? ((text) => process.stderr.write(text));

  const runHeadless = async (cmd: string, rest: readonly string[]): Promise<string | null> => {
    const json = rest.includes("--json");
    const timeout = flagValue(rest, "--timeout");
    const timeoutMs = timeout ? Number(timeout) : undefined;
    const pos = positionals(rest, [
      "--provider",
      "--timeout",
      "--section",
      "--name",
      "--mime",
      "--model",
      "--reasoning",
    ]);

    if (cmd === "prompt") {
      const [sessionId, ...textParts] = pos;
      const text = textParts.join(" ");
      if (!sessionId || !text) {
        return "usage: belay prompt <session> <text> [--model source/model] [--reasoning level] [--json] [--timeout ms]";
      }
      const modelConfig = resolveModelConfig({
        flagModel: flagValue(rest, "--model"),
        flagReasoning: flagValue(rest, "--reasoning"),
      });
      if (modelConfig.warning) {
        writeStderrText(`${modelConfig.warning}\n`);
      }
      const model =
        modelConfig.model || modelConfig.reasoning
          ? resolveModelRef(
              await withCliStage("catalog-read", () => deps.client.listCatalog(sessionId)),
              modelConfig,
            )
          : undefined;
      const result = await withCliStage("turn", () =>
        runPrompt(deps.client, {
          sessionId,
          text,
          provider: model?.sourceId ?? flagValue(rest, "--provider") ?? "",
          json,
          ...(model ? { model } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
          ...(json ? {} : { onDelta: writeStderrText }),
        }),
      );
      return result.stdout;
    }
    if (cmd === "models") {
      if (!deps.ensureHostOnline) {
        return "belay models requires launcher wiring";
      }
      const { sessionId } = await deps.ensureHostOnline();
      return formatCatalog(
        await withCliStage("catalog-read", () => deps.client.listCatalog(sessionId)),
        json,
      );
    }
    if (cmd === "cancel") {
      return (await runCancel(deps.client, pos[0] ?? "", pos[1] ?? "")).stdout;
    }
    if (cmd === "transcript") {
      if (!pos[0]) {
        return "usage: belay transcript <session> [--json]";
      }
      return (await runTranscript(deps.client, pos[0], json)).stdout;
    }
    if (cmd === "doctor") {
      if (!pos[0]) {
        return "usage: belay doctor <session> [--json] [--timeout ms]";
      }
      return (await runDoctor(deps.client, pos[0], json, timeoutMs)).stdout;
    }
    if (cmd === "capabilities") {
      if (!pos[0]) {
        return "usage: belay capabilities <session> [--json] [--section id]";
      }
      return (
        await runCapabilities(deps.client, pos[0], {
          json,
          ...(flagValue(rest, "--section") ? { section: flagValue(rest, "--section") } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
        })
      ).stdout;
    }
    if (cmd === "artifact") {
      return runArtifact(pos, rest, json);
    }
    return null;
  };

  const runArtifact = async (
    pos: readonly string[],
    rest: readonly string[],
    json: boolean,
  ): Promise<string> => {
    const [verb, target, out] = pos;
    if (verb === "put") {
      if (!target) {
        return "usage: belay artifact put <file> [--name n] [--mime m] [--json]";
      }
      const bytes = readFile(target);
      const result = await runArtifactPut(
        deps.client,
        bytes,
        inferMime(target, flagValue(rest, "--mime")),
        {
          json,
          name: flagValue(rest, "--name") ?? basename(target),
        },
      );
      return result.stdout;
    }
    if (verb === "get") {
      if (!target) {
        return "usage: belay artifact get <hash> [outfile]";
      }
      const bytes = await runArtifactGet(deps.client, target);
      if (out) {
        writeFile(out, bytes);
        return `Wrote ${bytes.length} bytes to ${out}.`;
      }
      writeStdoutBytes(bytes);
      return "";
    }
    return "usage: belay artifact put <file> | belay artifact get <hash> [outfile]";
  };

  return {
    runSubcommand: async (args) => {
      const [cmd, ...rest] = args;
      if (cmd === "list") {
        return runList(deps.lifecycleIo, deps.projectName(), rest.includes("--archived"));
      }
      if (cmd === "archive" || cmd === "unarchive") {
        return runArchive(deps.lifecycleIo, (rest[0] ?? "").trim(), cmd === "archive");
      }
      if (cmd === "stop" || cmd === "kill") {
        return runStop(deps.hostControlIo, (rest[0] ?? "").trim(), cmd === "kill");
      }
      if (cmd) {
        return runHeadless(cmd, rest);
      }
      return null;
    },
  };
}
