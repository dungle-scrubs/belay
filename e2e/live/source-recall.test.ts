import assert from "node:assert/strict";
import type { Tool } from "@host/tools";
import {
  loadSourceRecallConfig,
  normalizeSourceRecallConfig,
} from "@host/tools/source-recall/config";
import { createSourceRecallRegistry } from "@host/tools/source-recall/registry";
import { buildSourceRecallTools } from "@host/tools/source-recall/tools";
import { decodeSourceRecallIndexStatus } from "@trevor/session";
import { Effect } from "effect";
import { test } from "vitest";

/**
 * Plan 38 M10 (live, gated): exercise the source-recall tools against a REAL running provider daemon
 * (`sr serve` at SOURCE_RECALL_URL / http://127.0.0.1:7249, or Aleutian Trace at ALEUTIAN_TRACE_URL).
 * The daemons are NOT running in CI, so this lane probes reachability at load time and SKIPS with a
 * stated reason when nothing answers - it never fails the run and never silently passes. Run it with a
 * live daemon: `SOURCE_RECALL_URL=http://127.0.0.1:7249 pnpm test:e2e`.
 */

const OPTED_IN = process.env.TREVOR_LIVE === "1" || Boolean(process.env.SOURCE_RECALL_URL);
const URL = process.env.SOURCE_RECALL_URL ?? "http://127.0.0.1:7249";

interface Probe {
  readonly reachable: boolean;
  readonly reason: string;
}

/** Probes the daemon's `/health` with a short timeout so a missing daemon skips fast, never hangs. */
async function probeHealth(url: string): Promise<Probe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/health`, { signal: controller.signal });
    if (!response.ok) {
      return {
        reachable: false,
        reason: `source-recall daemon at ${url} returned ${response.status}`,
      };
    }
    return { reachable: true, reason: "" };
  } catch {
    return {
      reachable: false,
      reason: `source-recall daemon not reachable at ${url} (start it with 'sr serve')`,
    };
  } finally {
    clearTimeout(timer);
  }
}

const probe: Probe = OPTED_IN
  ? await probeHealth(URL)
  : {
      reachable: false,
      reason: "set SOURCE_RECALL_URL or TREVOR_LIVE=1 to run the live source-recall check",
    };

if (!probe.reachable) {
  // State the skip reason (never silently pass): mirrors the repo's live-model lane gating.
  console.info(`[live source-recall] skipped: ${probe.reason}`);
}

function liveTools(): Record<string, Tool<unknown>> {
  // Prefer the user's real config if present; otherwise a single provider pointed at the probed URL.
  const configured = loadSourceRecallConfig();
  const config = configured.providers.length
    ? configured
    : normalizeSourceRecallConfig({
        providers: { live: { kind: "source-recall", endpoint: URL } },
      });
  const registry = createSourceRecallRegistry(config);
  return Object.fromEntries(
    buildSourceRecallTools(registry).map((t) => [t.name, t as unknown as Tool<unknown>]),
  );
}

test.skipIf(!probe.reachable)("live: source_index_status reaches the running daemon", async () => {
  const raw = await Effect.runPromise(
    (liveTools().source_index_status as Tool<unknown>).execute({} as never, {
      workspaceRoot: process.cwd(),
    }),
  );
  const decoded = decodeSourceRecallIndexStatus(raw);
  assert.ok(decoded, "the live daemon returned a decodable index-status envelope");
  assert.ok(
    decoded.status === "ok" || decoded.status === "unready",
    `unexpected status ${decoded.status}`,
  );
});

test.skipIf(!probe.reachable)(
  "live: source_recall returns cited results from the running index",
  async () => {
    const raw = await Effect.runPromise(
      (liveTools().source_recall as Tool<unknown>).execute({ query: "server startup" } as never, {
        workspaceRoot: process.cwd(),
      }),
    );
    assert.ok(!raw.startsWith("error:"), `live query should not error: ${raw.slice(0, 200)}`);
  },
);
