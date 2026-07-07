import { homedir } from "node:os";
import { basename } from "node:path";
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
import { commandUsageText, createCommandRouter } from "./command-router";
import type { HostControlIo, LifecycleIo } from "./lifecycle";
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

const commandRouter = createCommandRouter({
  client,
  lifecycleIo,
  hostControlIo,
  projectName: () => basename(resolveProjectRoot(process.cwd(), nodeFs)),
});

/**
 * The `trevor` CLI entrypoint (D-085): run from any project directory to resolve the project root,
 * reuse-or-derive its session, ready the shared local services, spawn-or-reuse the matching agent-host
 * (with SESSION_ID + TREVOR_WORKSPACE + cwd all pointing at the project), and open the browser at the
 * session URL. The no-arg ordinary path; explicit `--session` / `--new` overrides are a later
 * extension. All orchestration lives in launch.ts; this only wires the real platform and prints the
 * secret-free status line.
 */
const USAGE = commandUsageText();

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
  const sub = await commandRouter.runSubcommand(args);
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
