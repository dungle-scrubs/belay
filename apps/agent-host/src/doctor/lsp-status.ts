import { homedir } from "node:os";
import { type DoctorFinding, relativeTime } from "@belay/session";
import { MAX_LSP_DEGRADED_DETAIL_CHARS } from "@host/lsp/caps";
import type { LspServerStatus } from "@host/lsp/contract";
import { clipLine } from "@host/tools/shared";
import { plural, statusHistogram } from "./format";
import { classifyPeripheral, type PeripheralClassificationRule } from "./peripheral-classifier";
import type { DoctorLspDiagnostics, PeripheralState } from "./probe-input";

/**
 * The /doctor LSP rollup (plan 24 M8, D-008): folds the LSP manager's per-workspace status
 * snapshot into the one {@link PeripheralState} the doctor LSP area renders, plus the
 * stored-diagnostics summary (the plan's diagnostic-warning finding) and the compact debug
 * histogram. Classification rides the manager's MACHINE `status` field - the manager parks
 * failures by errors.ts tag (an initialize timeout is "timeout", a crash over budget is
 * "error"), so nothing here sniffs message shapes. Every emitted detail is scrubbed (home
 * paths abbreviated) and bounded, because manager last-errors can carry raw workspace paths
 * and server stderr tails.
 *
 * Responsible for: folding LSP status snapshots into the doctor PeripheralState, the
 * diagnostic-warning finding, and the debug summary line.
 * Not for: reading live manager state (host-facts.ts injects the snapshot) or rendering the
 * area (areas-connectivity.ts peripheralArea + snapshot.ts).
 */

/** Abbreviates every home-prefixed path and clips to one bounded line. */
function scrub(detail: string): string {
  return clipLine(detail.split(homedir()).join("~"), MAX_LSP_DEGRADED_DETAIL_CHARS);
}

/** The display name covering the folded workspaces ("typescript-language-server"). */
function serverName(entries: readonly LspServerStatus[]): string {
  const named = [...new Set(entries.map((entry) => entry.server).filter(Boolean))];
  return named.length > 0 ? named.join("+") : "the language server";
}

/** "2 errors, 1 warning in 2 files" - the bounded stored-diagnostics phrase (counts only). */
function diagnosticCounts(summary: DoctorLspDiagnostics): string {
  return `${plural(summary.errors, "error")}, ${plural(summary.warnings, "warning")} in ${plural(
    summary.files,
    "file",
  )}`;
}

/** Folds the manager status snapshot into the doctor LSP peripheral state. */
export function lspPeripheralState(
  entries: readonly LspServerStatus[],
  nowMs: number,
): PeripheralState {
  return classifyPeripheral(entries, {
    configured: (entry) => entry.status !== "missing",
    rules: lspRules,
    ready: (configured) => ({ kind: "ready", detail: readyDetail(configured, nowMs) }),
  });
}

const lspRules = [
  {
    // Parked initialize timeouts first: the manager already classified them by machine tag.
    when: (entry) => entry.status === "timeout",
    state: ([timedOut]) => ({
      kind: "timeout",
      detail: scrub(timedOut.lastError ?? `${serverName([timedOut])} timed out during initialize`),
    }),
  },
  {
    when: (entry) => entry.status === "error",
    state: ([failed]) => ({
      kind: "error",
      detail: scrub(failed.lastError ?? `${serverName([failed])} failed`),
    }),
  },
  {
    // Missing binary (or a closed manager): configured but nothing can serve.
    when: (entry) => entry.status === "unavailable",
    state: ([unavailable]) => {
      const server = serverName([unavailable]);
      return {
        kind: "unavailable",
        detail: scrub(
          `${server} is not installed (checked ${unavailable.workspaceRoot}/node_modules/.bin ` +
            `and PATH); install: pnpm add -g ${server}`,
        ),
      };
    },
  },
] satisfies readonly PeripheralClassificationRule<LspServerStatus>[];

/** The D-008 ready line: server name, lifecycle word, diagnostic counts, freshness, last error. */
function readyDetail(configured: readonly LspServerStatus[], nowMs: number): string {
  const parts: string[] = [];
  if (configured.length > 1) {
    parts.push(plural(configured.length, "workspace"));
  }

  const stale = configured.find((entry) => entry.status === "stale");
  const state = configured.some((entry) => entry.status === "ready")
    ? "ready"
    : stale
      ? `stale (quiet for ${Math.round((stale.staleAgeMs ?? 0) / 1000)}s)`
      : configured.some((entry) => entry.status === "initializing")
        ? "initializing"
        : "configured (starts on first use)";
  parts.push(`${serverName(configured)} ${state}`);

  const diagnostics = lspStoredDiagnostics(configured);
  if (diagnostics) {
    parts.push(`diagnostics: ${diagnosticCounts(diagnostics)}`);
  }

  const freshest = Math.max(
    ...configured.map((entry) => entry.lastRequestAt ?? Number.NEGATIVE_INFINITY),
  );
  if (Number.isFinite(freshest)) {
    parts.push(`checked ${relativeTime(new Date(freshest).toISOString(), nowMs)}`);
  }

  // A per-request failure on an otherwise-ready server (request timeout, JSON-RPC error) never
  // parks the workspace; surface the most recent one as a fact, scrubbed and bounded.
  const lastError = configured.find((entry) => entry.lastError !== undefined)?.lastError;
  if (lastError !== undefined) {
    parts.push(`last error: ${scrub(lastError)}`);
  }

  return parts.join(" · ");
}

/** Sums stored-diagnostics counts across workspaces; undefined when nothing is stored. */
export function lspStoredDiagnostics(
  entries: readonly LspServerStatus[],
): DoctorLspDiagnostics | undefined {
  const stored = entries.map((entry) => entry.diagnostics).filter((d) => d !== undefined);
  if (stored.length === 0) {
    return undefined;
  }
  return stored.reduce((total, summary) => ({
    files: total.files + summary.files,
    errors: total.errors + summary.errors,
    warnings: total.warnings + summary.warnings,
  }));
}

/**
 * The diagnostic-warning finding (D-008): stored diagnostics WITH errors surface as one bounded
 * warn finding on the LSP area - counts only, never a message or a path - with the pull tool as
 * the next action (diagnostics stay pull-only, D-003). Warnings alone raise nothing; they stay
 * visible in the ready detail.
 */
export function lspDiagnosticFinding(
  diagnostics: DoctorLspDiagnostics | undefined,
): DoctorFinding | undefined {
  if (!diagnostics || diagnostics.errors === 0) {
    return undefined;
  }
  return {
    id: "lsp.diagnostics",
    status: "warn",
    title: "Workspace diagnostics",
    message: `The language server reports ${diagnosticCounts(diagnostics)}.`,
    nextAction: { label: "Pull details with lsp_diagnostics" },
  };
}

/** One compact status histogram for the debug surface; undefined when no adapter matches. */
export function lspDebugSummary(entries: readonly LspServerStatus[]): string | undefined {
  const configured = entries.filter((entry) => entry.status !== "missing");
  if (configured.length === 0) {
    return undefined;
  }
  const breakdown = statusHistogram(configured.map((entry) => entry.status));
  const diagnostics = lspStoredDiagnostics(configured);
  const stored = diagnostics && diagnostics.errors > 0 ? ` · ${diagnosticCounts(diagnostics)}` : "";
  return `${plural(configured.length, "workspace")} · ${breakdown}${stored}`;
}
