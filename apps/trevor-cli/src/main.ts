import { formatStatus, launch } from "./launch";
import { nodePlatform } from "./platform";

/**
 * The `trevor` CLI entrypoint (D-085): run from any project directory to resolve the project root,
 * reuse-or-derive its session, ready the shared local services, spawn-or-reuse the matching agent-host
 * (with SESSION_ID + TREVOR_WORKSPACE + cwd all pointing at the project), and open the browser at the
 * session URL. The no-arg ordinary path; explicit `--session` / `--new` overrides are a later
 * extension. All orchestration lives in launch.ts; this only wires the real platform and prints the
 * secret-free status line.
 */
async function main(): Promise<void> {
  const outcome = await launch(nodePlatform());
  process.stdout.write(`${formatStatus(outcome)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`trevor: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
