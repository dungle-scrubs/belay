import assert from "node:assert/strict";
import { homedir } from "node:os";
import type { HookConfigIssue } from "@host/hooks/config";
import type { LegacyHookFile } from "@host/hooks/discovery";
import type { HookStatusEntry, HooksStatusSnapshot } from "@host/hooks/runtime";
import type { HookStatsEntry } from "@host/hooks/stats";
import { test } from "vitest";
import { hooksAreaFindings, hooksDebugSummary, hooksPeripheralState } from "./hooks-status";

/**
 * Plan 25 M9: the /doctor hooks rollup - the runtime's status snapshot (configured hooks +
 * trust states + config issues + legacy HOOK.md files) and the per-hook stats folded into the
 * one PeripheralState the doctor Hooks area renders, plus its extra findings (approval, missing
 * scripts, slow/repeated-timeout handlers, legacy migration) and the debug histogram. Pins the
 * state matrix, the finding matrix, redaction (home paths abbreviated in legacy findings), and
 * that a healthy configured runtime raises NO findings beyond the status line.
 */

function entry(overrides: Partial<HookStatusEntry> = {}): HookStatusEntry {
  return {
    key: "project:fmt",
    event: "PreToolUse",
    source: "project",
    enabled: true,
    trust: "approved",
    ...overrides,
  };
}

function snapshot(
  hooks: readonly HookStatusEntry[],
  overrides: Partial<HooksStatusSnapshot> = {},
): HooksStatusSnapshot {
  return { hooks, issues: [], legacy: [], ...overrides };
}

function stats(overrides: Partial<HookStatsEntry> = {}): HookStatsEntry {
  return {
    key: "project:fmt",
    runs: 10,
    slowRuns: 0,
    timeouts: 0,
    failures: 0,
    invalidOutputs: 0,
    lastDurationMs: 12,
    ...overrides,
  };
}

// --- the state matrix -----------------------------------------------------------------------

test("nothing configured anywhere folds to unconfigured (steady state, not an error)", () => {
  assert.deepEqual(hooksPeripheralState(snapshot([])), { kind: "unconfigured" });
});

test("configured hooks fold to ready with counts by event type and the trust rollup", () => {
  const state = hooksPeripheralState(
    snapshot([
      entry(),
      entry({ key: "project:audit", event: "Stop", trust: "unapproved" }),
      entry({ key: "user:lint", trust: "approved" }),
    ]),
  );
  assert.equal(state.kind, "ready");
  const detail = state.kind === "ready" ? state.detail : "";
  assert.ok(detail.includes("3 hooks"), detail);
  assert.ok(detail.includes("2 PreToolUse"), detail);
  assert.ok(detail.includes("1 Stop"), detail);
  assert.ok(detail.includes("2 approved"), detail);
  assert.ok(detail.includes("1 awaiting approval"), detail);
});

test("a config-issues-only file (every entry malformed) still folds to ready with the issue count", () => {
  const issue: HookConfigIssue = {
    kind: "unknown_event",
    hook: "post",
    source: "project",
    detail: 'unknown hook event "PostToolUse"',
  };
  const state = hooksPeripheralState(snapshot([], { issues: [issue] }));
  assert.equal(state.kind, "ready");
  const detail = state.kind === "ready" ? state.detail : "";
  assert.ok(detail.includes("0 hooks"), detail);
  assert.ok(detail.includes("1 config issue"), detail);
});

test("a disabled hook is counted distinctly in the ready detail", () => {
  const state = hooksPeripheralState(snapshot([entry({ enabled: false })]));
  const detail = state.kind === "ready" ? state.detail : "";
  assert.ok(detail.includes("1 disabled"), detail);
});

test("legacy HOOK.md files alone still surface the area (never silently unconfigured)", () => {
  const legacy: LegacyHookFile = {
    path: `${homedir()}/dev/app/.trevor/hooks/fmt/HOOK.md`,
    source: "project",
    executable: true,
  };
  const state = hooksPeripheralState(snapshot([], { legacy: [legacy] }));
  assert.equal(state.kind, "ready");
});

// --- the finding matrix ---------------------------------------------------------------------

test("a healthy configured runtime raises no findings", () => {
  assert.deepEqual(hooksAreaFindings(snapshot([entry()]), [stats()]), []);
});

test("unapproved and trust-changed hooks raise ONE approval warning naming the hooks", () => {
  const findings = hooksAreaFindings(
    snapshot([
      entry({ key: "project:new", trust: "unapproved" }),
      entry({ key: "user:edited", trust: "changed" }),
      entry(),
    ]),
    [],
  );
  assert.equal(findings.length, 1);
  const finding = findings[0];
  assert.equal(finding?.id, "hooks.approval");
  assert.equal(finding?.status, "warn");
  assert.ok(finding?.message.includes("project:new"), finding?.message);
  assert.ok(finding?.message.includes("user:edited"), finding?.message);
  assert.match(finding?.message ?? "", /never execute/i);
  assert.ok(finding?.nextAction, "approval guidance is actionable");
});

test("a missing script raises its own warning naming the hook", () => {
  const findings = hooksAreaFindings(
    snapshot([entry({ key: "project:gone", trust: "missing-script" })]),
    [],
  );
  assert.deepEqual(
    findings.map((f) => [f.id, f.status]),
    [["hooks.scripts", "warn"]],
  );
  assert.ok(findings[0]?.message.includes("project:gone"), findings[0]?.message ?? "");
});

test("repeated timeouts and slow handlers raise one performance warning from the stats snapshot", () => {
  const findings = hooksAreaFindings(snapshot([entry()]), [
    stats({ key: "project:fmt", timeouts: 3 }),
    stats({ key: "user:lint", runs: 12, slowRuns: 5 }),
    stats({ key: "user:fine", runs: 100, slowRuns: 1, timeouts: 1 }),
  ]);
  assert.deepEqual(
    findings.map((f) => [f.id, f.status]),
    [["hooks.performance", "warn"]],
  );
  const message = findings[0]?.message ?? "";
  assert.ok(message.includes("project:fmt"), message);
  assert.ok(message.includes("user:lint"), message);
  assert.ok(!message.includes("user:fine"), "one slow run / one timeout is not a degradation");
});

test("config issues raise one warning; a disabled hook is informational, never a warning", () => {
  const issues: HookConfigIssue[] = [
    {
      kind: "unknown_event",
      hook: "post",
      source: "project",
      detail: 'unknown hook event "PostToolUse"',
    },
    { kind: "disabled_hook", hook: "fmt", source: "project", detail: "disabled" },
  ];
  const findings = hooksAreaFindings(snapshot([entry()], { issues }), []);
  assert.deepEqual(
    findings.map((f) => f.id),
    ["hooks.config"],
  );
  assert.ok(findings[0]?.message.includes("PostToolUse"), findings[0]?.message ?? "");
});

test("legacy HOOK.md files raise the migration warning with abbreviated paths, never executed", () => {
  const findings = hooksAreaFindings(
    snapshot([], {
      legacy: [
        {
          path: `${homedir()}/dev/app/.trevor/hooks/fmt/HOOK.md`,
          source: "project",
          executable: true,
        },
      ],
    }),
    [],
  );
  assert.deepEqual(
    findings.map((f) => [f.id, f.status]),
    [["hooks.legacy", "warn"]],
  );
  const finding = findings[0];
  assert.match(finding?.message ?? "", /HOOK\.md/);
  assert.match(finding?.message ?? "", /never execute/i);
  assert.ok(
    finding?.message.includes("~/dev/app/.trevor/hooks/fmt/HOOK.md"),
    finding?.message ?? "",
  );
  assert.ok(!finding?.message.includes(homedir()), "home directory is abbreviated");
  assert.match(finding?.nextAction?.label ?? "", /hooks\.json/i);
});

// --- the debug summary ----------------------------------------------------------------------

test("the debug summary is a compact trust histogram plus run count; undefined when unconfigured", () => {
  assert.equal(hooksDebugSummary(snapshot([]), []), undefined);
  const summary = hooksDebugSummary(
    snapshot([entry(), entry({ key: "project:new", trust: "unapproved" })]),
    [stats({ runs: 7 })],
  );
  assert.equal(summary, "2 hooks · 1 approved · 1 unapproved · 7 runs");
});
