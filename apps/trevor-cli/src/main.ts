import { basename } from "node:path";
import { events, type SessionSummary, streamTransport } from "@trevor/session";
import { nodeFs } from "./fs";
import { formatStatus, launch } from "./launch";
import { type LifecycleIo, runArchive, runList } from "./lifecycle";
import { nodePlatform } from "./platform";
import { resolveProjectRoot } from "./project";
import { RESERVED_PORTS } from "./services";
import { createSpinner } from "./spinner";

const STORE_URL = `http://127.0.0.1:${RESERVED_PORTS.store}`;

/** The real HTTP/transport IO for the lifecycle subcommands (talks to the local session-store). */
function lifecycleIo(): LifecycleIo {
  const transport = streamTransport(STORE_URL);
  return {
    fetchSessions: async () => {
      const res = await fetch(`${STORE_URL}/sessions`);
      if (!res.ok) {
        throw new Error(`session-store unavailable (HTTP ${res.status}) - is Trevor running?`);
      }
      const body = (await res.json()) as { sessions?: SessionSummary[] };
      return body.sessions ?? [];
    },
    publishArchived: async (sessionId, archived) => {
      const event = events.sessionArchived({ archived });
      await transport.publishEvent(sessionId, {
        type: event.type,
        producerId: "trevor-cli",
        payload: event.payload,
      });
    },
    now: Date.now,
  };
}

/**
 * Dispatches a `trevor` session-lifecycle subcommand (D-094 M3): `list [--archived]`, `archive
 * <session>`, `unarchive <session>`. Returns the output to print, or null when `args` is not a
 * lifecycle subcommand (so the no-arg launcher path runs).
 */
async function runSubcommand(args: readonly string[]): Promise<string | null> {
  const [cmd, ...rest] = args;
  if (cmd === "list") {
    const project = basename(resolveProjectRoot(process.cwd(), nodeFs));
    return runList(lifecycleIo(), project, rest.includes("--archived"));
  }
  if (cmd === "archive" || cmd === "unarchive") {
    return runArchive(lifecycleIo(), (rest[0] ?? "").trim(), cmd === "archive");
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
const USAGE = `trevor - open this project in Trevor V2

Usage:
  trevor                       Resolve the project (nearest git root), ready the shared services,
                               reuse-or-spawn the matching agent-host, and open in the browser.
  trevor list [--archived]     List this project's sessions (active by default; --archived for filed).
  trevor archive <session>     Archive a session (hides it from the default views; keeps its log).
  trevor unarchive <session>   Unarchive a session.
  trevor --debug               Start the host in debug mode (extra commands like /restart).
  trevor --help                Show this help.
  trevor --version             Show the launcher version.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write("trevor v2 (trevorV2 launcher)\n");
    return;
  }
  // Session-lifecycle subcommands (D-094) run against the local store and print, without launching.
  const sub = await runSubcommand(args);
  if (sub !== null) {
    process.stdout.write(`${sub}\n`);
    return;
  }
  const debug = args.includes("--debug");
  // Live spinner on stderr for the several seconds of startup; the final status block prints to
  // stdout after it succeeds, so piping `trevor` still yields a clean machine-readable summary.
  const spinner = createSpinner();
  spinner.step("starting Trevor…");
  try {
    const outcome = await launch(nodePlatform({ step: (text) => spinner.step(text) }), { debug });
    spinner.succeed("Trevor ready");
    process.stdout.write(`${formatStatus(outcome)}\n`);
  } catch (error) {
    spinner.fail("Trevor failed to start");
    throw error;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`trevor: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
