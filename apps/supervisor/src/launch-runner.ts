import { type LaunchPlatform, launch, nodePlatform } from "@trevor/launcher";

/**
 * The node-backed launch runner (plan 44.1). It reuses the launcher core's FULL spawn-or-reuse
 * orchestration - shared services ensured, the per-session lock, `decideHostAction`, the ownership
 * records, and the host-online wait - rather than forking a second, divergent host-lifecycle path
 * (D-002: the launcher is the single source of host ownership). It differs from the CLI in exactly one
 * way: it SUPPRESSES the browser open. The supervisor is not the user's terminal; the requesting
 * browser navigates itself once the freshly spawned host announces `host.online` on its own session, so
 * the control session stays a pure request/response side-channel.
 *
 * Maps the launcher's host action to the browser-facing vocabulary: a reused live host (including a
 * concurrent launch that already holds the lock) is `reused`; a fresh or replaced-stale host is
 * `launched`.
 */
export async function nodeLaunch(input: {
  readonly sessionId: string;
  readonly root: string;
}): Promise<"launched" | "reused"> {
  const platform: LaunchPlatform = { ...nodePlatform(), openBrowser: () => Promise.resolve() };
  const outcome = await launch(platform, {
    session: { sessionId: input.sessionId, root: input.root },
  });
  return outcome.hostAction === "reuse" || outcome.hostAction === "reused-concurrent"
    ? "reused"
    : "launched";
}
