# Worktree Fleet - Progress Report

## Summary

- **Current cutoff blockers:** 38
- **Completed current work:** 0
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** M1 - Request -> spec parse

## Completed Current State / Hard Dependencies

- [x] Handoff entry exists: `apps/agent-host/src/handoff-flow.ts` (spawn new host for new session).
- [x] Worktree commands exist: `/worktree-new|switch|merge|delete|reconcile` (`apps/agent-host/src/main.ts`).
- [x] `planner` skill exists (`~/.agents/skills/planner`) - workers run it in implement mode.
- [x] HARD DEP identified: `.plans/54-workflows-runtime` (the engine the fleet workflow runs on).
- [x] HARD DEP identified: `.plans/48-managed-worktree-hardening` (cwd-lock for N concurrent mutating trees).
- [x] HARD DEP identified: `.plans/47-bounded-child-takeover` (bounded-child behind each leaf; transitive via 54).
- [x] SUPPORTING identified: `.plans/50-forkable-sessions-lineage` (durable fleet run session).

## Current Cutoff Blockers

### Phase 1: Spec parse, confirm, handoff entry

**M1 - Request -> spec parse**
- [ ] RED: NL request -> N `{branch, plan, worktree}` specs; plan refs resolve to existing `.plans/NN`;
  unknown/ambiguous refs rejected.
- [ ] GREEN: parse step (small LLM leaf) + spec schema + validation against the plan registry.
- [ ] REFACTOR: parse separate from execution.

**M2 - Confirm gate + handoff**
- [ ] RED: specs presented for approval before any tree/agent; approve -> durable run spawned;
  reject -> nothing created.
- [ ] GREEN: confirm-spec-first gate + reuse `handoff-flow` to spawn the fleet session/host.
- [ ] RED: `fire-immediately` config variant.
- [ ] GREEN: config-driven gate (default confirm).
- [ ] REFACTOR: gate policy separate from the workflow body.

**Gate 1->2**
- [ ] A request yields validated specs bound to real plans.
- [ ] No tree/agent created before approval (default gate).
- [ ] The run is owned by a dedicated durable session via handoff.

### Phase 2: The `worktree-fleet` workflow

**M3 - Worker leaves (planner implement in a tree)**
- [ ] RED: each spec -> a write-capable worktree leaf running `planner` implement-mode against its plan;
  isolated; non-racing.
- [ ] GREEN: the built-in `worktree-fleet` workflow - "implement" phase fanning out worker leaves on 54.
- [ ] RED: failure/stall - failed worker marked failed, siblings continue, `<=1` retry.
- [ ] GREEN: fail-soft + bounded retry + structured per-worker result.
- [ ] REFACTOR: worker policy in the workflow, not the engine.

**M4 - Flat audit phase**
- [ ] RED: after each worker, an auditor leaf (`53`/M2 verifier / `code-review`) reviews the tree's diff
  and attaches a verdict + findings.
- [ ] GREEN: the "audit" phase (flat; orchestrator-owned).
- [ ] REFACTOR: reuse the verifier leaf shape from `53`/M2.

**Gate 2->3**
- [ ] N plans implement in parallel, each in an isolated tree, with bounded retry on failure.
- [ ] Each tree carries an audit verdict + findings.

### Phase 3: Aggregation + disposition

**M5 - Aggregation report**
- [ ] RED: per-tree `{ branch, status, diffstat, audit verdict + findings, conflict-with-base }` +
  summary, stored durably, re-openable.
- [ ] GREEN: aggregation + durable run report (projection of `54`'s journal).
- [ ] REFACTOR: keep the report derived, not separately authored.

**M6 - Disposition policy**
- [ ] RED: default leave-branches + report (no base writes); PR-per-tree; auto-merge clean + passing
  (audit as a hard gate).
- [ ] GREEN: disposition executor reusing `/worktree-merge` / `/worktree-delete`; PR path behind a remote.
- [ ] REFACTOR: disposition policy-driven and revisitable.

**Gate 3->4**
- [ ] The report is durable and re-openable.
- [ ] Default disposition writes nothing to base branches; alternatives opt-in.

### Phase 4: Presentation + e2e

**M7 - Reuse existing surfaces**
- [ ] RED: N worker sessions show as sidebar rows with activity; `/worktree` modal shows per-tree status
  incl. audit verdict.
- [ ] GREEN: wire fleet/worktree status into the existing sidebar + `/worktree` modal; run is resumable.
- [ ] REFACTOR: no new dashboard surface.

**M8 - Hermetic e2e**
- [ ] RED: e2e - request -> confirm -> N trees -> planner-implement -> audit -> report -> leave-branches
  (fake provider).
- [ ] GREEN: full fleet loop e2e in `e2e/`.

### Done Gate

- [ ] One request produces N audited worktrees + a durable, re-openable report.
- [ ] Default disposition leaves base branches untouched; merge stays a human action.
- [ ] The run survives a tab close and resumes.
- [ ] Unit, web, integration, and hermetic e2e are green.

## Accepted / Deferred Follow-Up

None.

## Superseded / Obsolete Checklist Debt

None.
