import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";
import {
  BELAY_STATE_HOME,
  formatStatus,
  type LaunchOutcome,
  launch,
  loadHosts,
  nodeFs,
  nodePlatform,
  processAlive,
  removeHost,
  resolveProjectRoot,
  serviceUrl,
} from "@belay/launcher";
import { createTrevorClient, resolveOpenTarget } from "@belay/sdk";
import {
  errorMessage,
  events,
  freshSessionId,
  PRODUCER_IDS,
  type SessionSummary,
} from "@belay/session";
import { commandUsageText, createCommandRouter, flagValue } from "./command-router";
import { resolveModelConfig } from "./config";
import { runPrompt } from "./headless";
import type { HostControlIo, LifecycleIo } from "./lifecycle";
import { resolveModelRef } from "./model-flags";
import { createSpinner } from "./spinner";
import { CliStageError, isCliStageError, withCliStage } from "./stage-error";

// Honor the same node-side URL overrides the host and supervisor do, so `belay` can be pointed at a
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
      throw new Error(`session-store unavailable - is Belay running? (${errorMessage(error)})`);
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
    const record = loadHosts(nodeFs, BELAY_STATE_HOME)[sessionId];
    return record ? { pid: record.pid } : null;
  },
  processAlive,
  signal: (pid, sig) => process.kill(pid, sig),
  removeHost: (sessionId) => removeHost(nodeFs, BELAY_STATE_HOME, sessionId),
};

const commandRouter = createCommandRouter({
  client,
  lifecycleIo,
  hostControlIo,
  ensureHostOnline: () => ensureHostOnline(),
  projectName: () => basename(resolveProjectRoot(process.cwd(), nodeFs)),
});

/**
 * The `belay` CLI entrypoint (D-085): run from any project directory to resolve the project root,
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
 * after it succeeds, so piping `belay` still yields a clean machine-readable summary.
 */
async function launchWith(options: {
  readonly debug?: boolean;
  readonly noBrowser?: boolean;
  readonly session?: { sessionId: string; root: string };
}): Promise<LaunchOutcome> {
  const spinner = createSpinner();
  spinner.step(options.session ? "opening session…" : "starting Belay…");
  try {
    const outcome = await launch(nodePlatform({ step: (text) => spinner.step(text) }), options);
    if (!outcome.online) {
      throw new CliStageError("waitForHostOnline", "host did not join before the timeout");
    }
    spinner.succeed("Belay ready");
    if (!options.noBrowser) {
      process.stdout.write(`${formatStatus(outcome)}\n`);
    }
    return outcome;
  } catch (error) {
    spinner.fail("Belay failed to start");
    throw isCliStageError(error) ? error : new CliStageError("host-launch", errorMessage(error));
  }
}

async function ensureHostOnline(): Promise<LaunchOutcome> {
  return launchWith({ noBrowser: true });
}

function spawnedByThisInvocation(hostAction: LaunchOutcome["hostAction"]): boolean {
  return hostAction !== "reuse" && hostAction !== "reused-concurrent";
}

function liveHostOwnsRoot(root: string): boolean {
  return Object.values(loadHosts(nodeFs, BELAY_STATE_HOME)).some(
    (record) => record.root === root && processAlive(record.pid),
  );
}

function baseRepoForRoot(root: string): string | null {
  const result = spawnSync("git", ["-C", root, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return null;
  }
  const first = result.stdout
    .split("\n")
    .find((line) => line.startsWith("worktree "))
    ?.slice("worktree ".length)
    .trim();
  return first && first !== root ? first : null;
}

async function stampBaseRepoForWorktree(sessionId: string, root: string): Promise<void> {
  const baseRepo = baseRepoForRoot(root);
  if (!baseRepo) {
    return;
  }
  await client.publishEvent(sessionId, events.sessionProject({ path: baseRepo }), "publishEvent");
}

/**
 * Runs `belay open <session>` (D-094 M3): resolve the requested session from the store inventory to
 * its workspace root, then launch it (spawn-or-attach the matching host + open the browser). A
 * missing/unknown id prints a clear message and does not launch.
 */
async function runOpen(sessionId: string): Promise<void> {
  const id = sessionId.trim();
  if (!id) {
    process.stdout.write("usage: belay open <session>\n");
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

function oneShotPrompt(args: readonly string[]): string | undefined {
  const prompt = flagValue(args, "-p") ?? flagValue(args, "--prompt");
  return prompt?.trim() ? prompt : undefined;
}

async function runOneShotPrompt(args: readonly string[], text: string): Promise<void> {
  const ephemeral = args.includes("--ephemeral");
  const root = resolveProjectRoot(process.cwd(), nodeFs);
  if (ephemeral && liveHostOwnsRoot(root)) {
    throw new CliStageError(
      "cwd-ownership",
      `a live host already owns ${root}; refusing duplicate ephemeral mutating host`,
    );
  }
  const outcome = ephemeral
    ? await launchWith({
        noBrowser: true,
        session: { sessionId: freshSessionId(), root },
      })
    : await ensureHostOnline();
  try {
    await stampBaseRepoForWorktree(outcome.sessionId, root).catch((error: unknown) => {
      throw new CliStageError("session-project", errorMessage(error));
    });
    const modelConfig = resolveModelConfig({
      flagModel: flagValue(args, "--model"),
      flagReasoning: flagValue(args, "--reasoning"),
    });
    if (modelConfig.warning) {
      process.stderr.write(`${modelConfig.warning}\n`);
    }
    const model =
      modelConfig.model || modelConfig.reasoning
        ? resolveModelRef(
            await withCliStage("catalog-read", () => client.listCatalog(outcome.sessionId)),
            modelConfig,
          )
        : undefined;
    const json = args.includes("--json");
    const timeout = flagValue(args, "--timeout");
    const result = await withCliStage("turn", () =>
      runPrompt(client, {
        sessionId: outcome.sessionId,
        text,
        provider: model?.sourceId ?? flagValue(args, "--provider") ?? "",
        json,
        ...(model ? { model } : {}),
        ...(timeout ? { timeoutMs: Number(timeout) } : {}),
        ...(json ? {} : { onDelta: (delta) => process.stderr.write(delta) }),
      }),
    );
    process.stdout.write(`${result.stdout}\n`);
  } finally {
    if (ephemeral && outcome.hostPid && spawnedByThisInvocation(outcome.hostAction)) {
      try {
        process.kill(outcome.hostPid, "SIGTERM");
      } catch {
        // The host may already have exited after the one-shot turn.
      }
      removeHost(nodeFs, BELAY_STATE_HOME, outcome.sessionId);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write("belay launcher\n");
    return;
  }
  const prompt = oneShotPrompt(args);
  if (prompt) {
    await runOneShotPrompt(args, prompt);
    return;
  }
  // `belay open <session>` is a launch variant (spinner + full platform), handled before the
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
  if (process.argv.includes("--json") && isCliStageError(error)) {
    process.stderr.write(`${JSON.stringify({ stage: error.stage, message: error.message })}\n`);
  } else {
    process.stderr.write(`belay: ${errorMessage(error)}\n`);
  }
  process.exit(1);
});
