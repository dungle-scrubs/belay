import { formatStatus, launch } from "./launch";
import { nodePlatform } from "./platform";
import { createSpinner } from "./spinner";

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
  trevor            Resolve the project (nearest git root), ready the shared services,
                    reuse-or-spawn the matching agent-host, and open the session in the browser.
  trevor --debug    Start the host in debug mode (extra commands like /restart).
  trevor --help     Show this help.
  trevor --version  Show the launcher version.
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
