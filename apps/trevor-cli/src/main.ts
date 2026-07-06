import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname } from "node:path";
import {
  formatStatus,
  launch,
  loadHosts,
  nodeFs,
  nodePlatform,
  processAlive,
  removeHost,
  resolveProjectRoot,
  serviceUrl,
  TREVOR_STATE_HOME,
} from "@trevor/launcher";
import { createTrevorClient, resolveOpenTarget } from "@trevor/sdk";
import { errorMessage, PRODUCER_IDS, type SessionSummary } from "@trevor/session";
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
import { createSpinner } from "./spinner";

// Honor the same node-side URL overrides the host and supervisor do, so `trevor` can be pointed at a
// remote store/blob (e.g. in a container or a shared dev box), not only the local loopback default.
const STORE_URL = process.env.SESSION_STORE_URL ?? serviceUrl("store");
const BLOB_URL = process.env.BLOB_STORE_URL ?? serviceUrl("blob");

// One SDK client per process, bound to the local session-store + blob-store. Every headless verb and the
// lifecycle IO route through it, stamping the CLI producer id on the events they publish (plan 28 M7).
const client = createTrevorClient({
  sessionUrl: STORE_URL,
  blobUrl: BLOB_URL,
  producerId: PRODUCER_IDS.cli,
});

/** The real HTTP/transport IO for the lifecycle subcommands, routed through the SDK client. */
const lifecycleIo: LifecycleIo = {
  fetchSessions: async () => {
    try {
      return await client.fetchInventory();
    } catch (error) {
      throw new Error(`session-store unavailable - is Trevor running? (${errorMessage(error)})`);
    }
  },
  publishArchived: (sessionId, archived) =>
    archived ? client.archive(sessionId) : client.unarchive(sessionId),
  now: Date.now,
};

/** The host-control IO for stop/kill: the launcher's ownership records + real process signalling
 *  (the liveness probe is the launcher platform's `processAlive`, shared rather than re-rolled). This is
 *  launcher/local-owned (OS signals), NOT an SDK workflow (D-003). */
const hostControlIo: HostControlIo = {
  lookupHost: (sessionId) => {
    const record = loadHosts(nodeFs, TREVOR_STATE_HOME)[sessionId];
    return record ? { pid: record.pid } : null;
  },
  processAlive,
  signal: (pid, sig) => process.kill(pid, sig),
  removeHost: (sessionId) => removeHost(nodeFs, TREVOR_STATE_HOME, sessionId),
};

/** A flag's value from `--flag value`, or undefined when the flag is absent. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/** Positional args (everything that is not a `--flag` or a value consumed by one). */
function positionals(args: readonly string[], valueFlags: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg.startsWith("--")) {
      if (valueFlags.includes(arg)) {
        i += 1; // skip the flag's value
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

/** Dispatches a headless SDK-backed command; returns the stdout to print, or null when not a headless cmd. */
async function runHeadless(cmd: string, rest: readonly string[]): Promise<string | null> {
  const json = rest.includes("--json");
  const timeout = flagValue(rest, "--timeout");
  const timeoutMs = timeout ? Number(timeout) : undefined;
  const pos = positionals(rest, ["--provider", "--timeout", "--section", "--name", "--mime"]);

  if (cmd === "prompt") {
    const [sessionId, ...textParts] = pos;
    const text = textParts.join(" ");
    if (!sessionId || !text) {
      return "usage: trevor prompt <session> <text> [--provider p] [--json] [--timeout ms]";
    }
    const result = await runPrompt(client, {
      sessionId,
      text,
      provider: flagValue(rest, "--provider") ?? "",
      json,
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(json ? {} : { onDelta: (delta) => process.stderr.write(delta) }),
    });
    return result.stdout;
  }
  if (cmd === "cancel") {
    return (await runCancel(client, pos[0] ?? "", pos[1] ?? "")).stdout;
  }
  if (cmd === "transcript") {
    if (!pos[0]) {
      return "usage: trevor transcript <session> [--json]";
    }
    return (await runTranscript(client, pos[0], json)).stdout;
  }
  if (cmd === "doctor") {
    if (!pos[0]) {
      return "usage: trevor doctor <session> [--json] [--timeout ms]";
    }
    return (await runDoctor(client, pos[0], json, timeoutMs)).stdout;
  }
  if (cmd === "capabilities") {
    if (!pos[0]) {
      return "usage: trevor capabilities <session> [--json] [--section id]";
    }
    return (
      await runCapabilities(client, pos[0], {
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
}

/** `trevor artifact put <file>` / `get <hash> [outfile]`. */
async function runArtifact(
  pos: readonly string[],
  rest: readonly string[],
  json: boolean,
): Promise<string> {
  const [verb, target, out] = pos;
  if (verb === "put") {
    if (!target) {
      return "usage: trevor artifact put <file> [--name n] [--mime m] [--json]";
    }
    const bytes = new Uint8Array(readFileSync(target));
    const mime =
      flagValue(rest, "--mime") ??
      MIME_BY_EXT[extname(target).toLowerCase()] ??
      "application/octet-stream";
    const result = await runArtifactPut(client, bytes, mime, {
      json,
      name: flagValue(rest, "--name") ?? basename(target),
    });
    return result.stdout;
  }
  if (verb === "get") {
    if (!target) {
      return "usage: trevor artifact get <hash> [outfile]";
    }
    const bytes = await runArtifactGet(client, target);
    if (out) {
      writeFileSync(out, bytes);
      return `Wrote ${bytes.length} bytes to ${out}.`;
    }
    process.stdout.write(bytes);
    return "";
  }
  return "usage: trevor artifact put <file> | trevor artifact get <hash> [outfile]";
}

/**
 * Dispatches a `trevor` session-lifecycle subcommand (D-094 M1/M3): `list [--archived]`, `archive
 * <session>`, `unarchive <session>`, `stop <session>`, `kill <session>`. Returns the output to
 * print, or null when `args` is not a lifecycle subcommand (so the no-arg launcher path runs).
 */
async function runSubcommand(args: readonly string[]): Promise<string | null> {
  const [cmd, ...rest] = args;
  if (cmd === "list") {
    const project = basename(resolveProjectRoot(process.cwd(), nodeFs));
    return runList(lifecycleIo, project, rest.includes("--archived"));
  }
  if (cmd === "archive" || cmd === "unarchive") {
    return runArchive(lifecycleIo, (rest[0] ?? "").trim(), cmd === "archive");
  }
  if (cmd === "stop" || cmd === "kill") {
    return runStop(hostControlIo, (rest[0] ?? "").trim(), cmd === "kill");
  }
  if (cmd) {
    return runHeadless(cmd, rest);
  }
  return null;
}

/**
 * The `trevor` CLI entrypoint (D-085): run from any project directory to resolve the project root,
 * reuse-or-derive its session, ready the shared local services, spawn-or-reuse the matching agent-host
 * (with SESSION_ID + TREVOR_WORKSPACE + cwd all pointing at the project), and open the browser at the
 * session URL. The no-arg ordinary path; explicit `--session` / `--new` overrides are a later
 * extension. All orchestration lives in launch.ts; this only wires the real platform and prints the
 * secret-free status line.
 */
const USAGE = `trevor - open this project in Trevor

Usage:
  trevor                       Resolve the project (nearest git root), ready the shared services,
                               reuse-or-spawn the matching agent-host, and open in the browser.
  trevor list [--archived]     List this project's sessions (active by default; --archived for filed).
  trevor open <session>        Open/resume a session by id (spawn-or-attach its host) in the browser.
  trevor archive <session>     Archive a session (hides it from the default views; keeps its log).
  trevor unarchive <session>   Unarchive a session.
  trevor stop <session>        Gracefully shut down the session's host (SIGTERM); keeps its log.
  trevor kill <session>        Force-terminate a wedged session host (SIGKILL); keeps its log.
  trevor prompt <session> <text>   Submit a prompt and stream the turn (--json, --provider, --timeout).
  trevor cancel <session> <runId>  Cancel the active run (publishes user.cancel; not stop/kill).
  trevor transcript <session>      Print the session transcript (--json for machine output).
  trevor doctor <session>          Print the host /doctor snapshot (--json).
  trevor capabilities <session>    Print the host capability manifest export (--json, --section).
  trevor artifact put <file>       Upload an artifact; artifact get <hash> [outfile] downloads it.
  trevor --debug               Start the host in debug mode (extra commands like /restart).
  trevor --help                Show this help.
  trevor --version             Show the launcher version.
`;

/**
 * Runs the launcher behind the startup spinner and prints the secret-free status line. The live
 * spinner is on stderr for the several seconds of startup; the final status block prints to stdout
 * after it succeeds, so piping `trevor` still yields a clean machine-readable summary.
 */
async function launchWith(options: {
  readonly debug?: boolean;
  readonly session?: { sessionId: string; root: string };
}): Promise<void> {
  const spinner = createSpinner();
  spinner.step(options.session ? "opening session…" : "starting Trevor…");
  try {
    const outcome = await launch(nodePlatform({ step: (text) => spinner.step(text) }), options);
    spinner.succeed("Trevor ready");
    process.stdout.write(`${formatStatus(outcome)}\n`);
  } catch (error) {
    spinner.fail("Trevor failed to start");
    throw error;
  }
}

/**
 * Runs `trevor open <session>` (D-094 M3): resolve the requested session from the store inventory to
 * its workspace root, then launch it (spawn-or-attach the matching host + open the browser). A
 * missing/unknown id prints a clear message and does not launch.
 */
async function runOpen(sessionId: string): Promise<void> {
  const id = sessionId.trim();
  if (!id) {
    process.stdout.write("usage: trevor open <session>\n");
    return;
  }
  let summaries: readonly SessionSummary[];
  try {
    summaries = await lifecycleIo.fetchSessions();
  } catch (error) {
    process.stdout.write(`${errorMessage(error)}\n`);
    return;
  }
  const target = resolveOpenTarget(summaries, id, homedir());
  if ("error" in target) {
    process.stdout.write(`${target.error}\n`);
    return;
  }
  await launchWith({ session: target });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write("trevor launcher\n");
    return;
  }
  // `trevor open <session>` is a launch variant (spinner + full platform), handled before the
  // print-only lifecycle subcommands.
  if (args[0] === "open") {
    await runOpen(args[1] ?? "");
    return;
  }
  // Session-lifecycle + headless subcommands run against the local store and print, without launching.
  const sub = await runSubcommand(args);
  if (sub !== null) {
    if (sub.length > 0) {
      process.stdout.write(`${sub}\n`);
    }
    return;
  }
  await launchWith({ debug: args.includes("--debug") });
}

main().catch((error: unknown) => {
  process.stderr.write(`trevor: ${errorMessage(error)}\n`);
  process.exit(1);
});
