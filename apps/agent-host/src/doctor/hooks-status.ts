import { abbrevHome } from "@host/boot/paths";
import type { HookEvent } from "@host/hooks/config";
import type { HooksStatusSnapshot } from "@host/hooks/runtime";
import type { HookStatsEntry } from "@host/hooks/stats";
import type { DoctorFinding } from "@trevor/session";
import { plural, statusHistogram } from "./format";
import type { PeripheralState } from "./probe-input";

/**
 * The /doctor hooks rollup (plan 25 M9, D-009): folds the hooks runtime's status snapshot
 * (configured hooks + freshly evaluated trust + config issues + legacy HOOK.md files) and its
 * per-hook run counters into the one {@link PeripheralState} the doctor Hooks area renders,
 * plus the area's extra findings and the compact debug histogram - the mcp/lsp-status
 * tradition. Pure over already-redacted data: keys are `<source>:<id>` identities, issue
 * details were bounded at config parse, and the only path this module touches (a legacy
 * HOOK.md location) is home-abbreviated before display. The findings ladder: unapproved/
 * changed-trust hooks warn with approval guidance (D-006 - they never execute until approved),
 * missing scripts warn, degrading handlers (repeated timeouts / habitual slow runs) warn from
 * the stats snapshot, non-informational config issues warn, and legacy executable HOOK.md
 * files warn with migration guidance (M10 - reported, never executed).
 *
 * Responsible for: folding hooks status + stats into the doctor PeripheralState, the extra
 * findings, and the debug summary line.
 * Not for: reading live runtime state (host-facts.ts injects the snapshots) or rendering the
 * area (areas-connectivity.ts peripheralArea).
 */

/** A hook with this many timeouts on record is degrading, not having one bad afternoon. */
export const REPEATED_TIMEOUTS_THRESHOLD = 2;

/** A hook with this many slow (>80% of budget) completions on record is a slow handler. */
export const SLOW_RUNS_THRESHOLD = 3;

/** Folds the runtime status snapshot into the doctor Hooks peripheral state. */
export function hooksPeripheralState(snapshot: HooksStatusSnapshot): PeripheralState {
  if (snapshot.hooks.length === 0 && snapshot.issues.length === 0 && snapshot.legacy.length === 0) {
    // Nothing configured and nothing legacy: the steady "not set up" state, never an error.
    return { kind: "unconfigured" };
  }
  return { kind: "ready", detail: readyDetail(snapshot) };
}

/** The D-009 ready line: counts by event type, the trust rollup, disabled + issue counts. */
function readyDetail(snapshot: HooksStatusSnapshot): string {
  const parts = [`${plural(snapshot.hooks.length, "hook")}${eventBreakdown(snapshot)}`];

  const approved = snapshot.hooks.filter((hook) => hook.trust === "approved").length;
  if (snapshot.hooks.length > 0) {
    parts.push(`${approved} approved`);
  }

  const awaiting = snapshot.hooks.filter(
    (hook) => hook.trust === "unapproved" || hook.trust === "changed",
  ).length;
  if (awaiting > 0) {
    parts.push(`${awaiting} awaiting approval`);
  }

  const missing = snapshot.hooks.filter((hook) => hook.trust === "missing-script").length;
  if (missing > 0) {
    parts.push(`${missing} missing script`);
  }

  const disabled = snapshot.hooks.filter((hook) => !hook.enabled).length;
  if (disabled > 0) {
    parts.push(`${disabled} disabled`);
  }

  const issues = snapshot.issues.length;
  if (issues > 0) {
    parts.push(plural(issues, "config issue"));
  }

  if (snapshot.legacy.length > 0) {
    parts.push(`${plural(snapshot.legacy.length, "legacy HOOK.md file")} (migrate)`);
  }

  return parts.join(" · ");
}

/** "(2 PreToolUse · 1 Stop)" - the per-event configured counts; empty with no hooks. */
function eventBreakdown(snapshot: HooksStatusSnapshot): string {
  if (snapshot.hooks.length === 0) {
    return "";
  }
  const counts = new Map<HookEvent, number>();
  for (const hook of snapshot.hooks) {
    counts.set(hook.event, (counts.get(hook.event) ?? 0) + 1);
  }
  const breakdown = [...counts.entries()].map(([event, count]) => `${count} ${event}`);
  return ` (${breakdown.join(" · ")})`;
}

/** The Hooks area's extra findings: approval, missing scripts, degradation, config, legacy. */
export function hooksAreaFindings(
  snapshot: HooksStatusSnapshot,
  stats: readonly HookStatsEntry[],
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];

  // Unapproved + changed-trust hooks: ONE approval warning (D-006). Both states keep the
  // execution gate closed, so the guidance is the same - review, then approve the current hash.
  const awaiting = snapshot.hooks.filter(
    (hook) => hook.trust === "unapproved" || hook.trust === "changed",
  );
  if (awaiting.length > 0) {
    const changed = awaiting.filter((hook) => hook.trust === "changed");
    const changedNote =
      changed.length > 0
        ? ` ${plural(changed.length, "hook")} changed since approval and needs RE-approval.`
        : "";
    findings.push({
      id: "hooks.approval",
      status: "warn",
      title: "Hooks awaiting approval",
      message:
        `${plural(awaiting.length, "hook")} awaiting approval: ` +
        `${awaiting.map((hook) => hook.key).join(", ")}. ` +
        `A hook never executes until its current trust hash is approved.${changedNote}`,
      nextAction: { label: "Review each hook, then approve its trust hash" },
    });
  }

  const missing = snapshot.hooks.filter((hook) => hook.trust === "missing-script");
  if (missing.length > 0) {
    findings.push({
      id: "hooks.scripts",
      status: "warn",
      title: "Hook scripts missing",
      message: `The command script does not exist for: ${missing.map((h) => h.key).join(", ")}.`,
      nextAction: { label: "Restore the script or remove the hook" },
    });
  }

  const degrading = stats.filter(
    (entry) =>
      entry.timeouts >= REPEATED_TIMEOUTS_THRESHOLD || entry.slowRuns >= SLOW_RUNS_THRESHOLD,
  );
  if (degrading.length > 0) {
    const described = degrading.map((entry) =>
      entry.timeouts >= REPEATED_TIMEOUTS_THRESHOLD
        ? `${entry.key} timed out ${entry.timeouts} of ${entry.runs} runs`
        : `${entry.key} ran slow ${entry.slowRuns} of ${entry.runs} runs`,
    );
    findings.push({
      id: "hooks.performance",
      status: "warn",
      title: "Degrading hook handlers",
      message: `${described.join("; ")}. Each gated call pays this latency.`,
      nextAction: { label: "Profile or simplify the hook, or raise its timeoutMs" },
    });
  }

  // Non-informational config issues (a disabled hook is a fact, not a problem).
  const issues = snapshot.issues.filter((issue) => issue.kind !== "disabled_hook");
  if (issues.length > 0) {
    findings.push({
      id: "hooks.config",
      status: "warn",
      title: "Hook config issues",
      message: `${plural(issues.length, "invalid hooks.json entry")} dropped: ${issues
        .map((issue) => issue.detail)
        .join("; ")}`,
      nextAction: { label: "Fix the hooks.json entries" },
    });
  }

  if (snapshot.legacy.length > 0) {
    findings.push({
      id: "hooks.legacy",
      status: "warn",
      title: "Legacy HOOK.md handlers",
      message:
        `${plural(snapshot.legacy.length, "legacy V1 HOOK.md file")} found - these never execute in V2: ` +
        `${snapshot.legacy.map((file) => abbrevHome(file.path)).join(", ")}.`,
      nextAction: { label: "Migrate each handler to a hooks.json entry" },
    });
  }

  return findings;
}

/** One compact trust histogram + run count for the debug surface; undefined when unconfigured. */
export function hooksDebugSummary(
  snapshot: HooksStatusSnapshot,
  stats: readonly HookStatsEntry[],
): string | undefined {
  if (snapshot.hooks.length === 0 && snapshot.issues.length === 0) {
    return undefined;
  }
  const runs = stats.reduce((total, entry) => total + entry.runs, 0);
  const breakdown = statusHistogram(snapshot.hooks.map((hook) => hook.trust));
  return `${plural(snapshot.hooks.length, "hook")}${breakdown ? ` · ${breakdown}` : ""} · ${plural(runs, "run")}`;
}
