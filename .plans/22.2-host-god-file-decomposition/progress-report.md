# Host God-File Decomposition - Progress Report

> **Status: deferred / gated.** Does not start until 22.1 merges and the per-file boundary gates clear (see implementation.md § Hard Dependencies).

## Summary

- Current focus: M1 - Characterize Routing, Startup, and Loop Behavior (BLOCKED on gates)
- Current cutoff blockers: 0
- Accepted/deferred follow-up: 30
- Superseded/obsolete checklist debt: 0
- Completed current work: 0

## Current Cutoff Blockers

None - this plan is gated. All work is parked under Accepted/Deferred Follow-Up until the hard-dependency gates clear.

## Accepted/Deferred Follow-Up

### Phase 1: Characterization Safety Net

#### M1: Characterize Routing, Startup, and Loop Behavior

- [ ] RED: Add characterization tests asserting `handleEvent` routes every current `SessionEvent` kind to its handler (completeness).
- [ ] GREEN: Make them pass against current `main.ts` (document, not change, behavior).
- [ ] RED: Add a startup/init-order assertion covering the composition-root wiring sequence.
- [ ] GREEN: Make it pass against current startup.
- [ ] RED: Add characterization tests for `agent/loop.ts`'s observable turn outcomes.
- [ ] GREEN: Make them pass against the current loop.
- [ ] REFACTOR: Keep the characterization suite fast and deterministic (fake provider).

### Phase 2: Decompose, One File at a Time

#### M2: Decompose `main.ts` (events extraction)

- [ ] RED: Confirm the routing/startup characterization tests are green pre-split.
- [ ] GREEN: Extract each long `handleEvent` handler body into `events/`, leaving a visible routing table in `main.ts`.
- [ ] GREEN: Move remaining domain helpers in `main.ts` to their domain dirs (e.g. `doctorFacts` -> `doctor/`).
- [ ] RED: Re-run characterization + turn/e2e suites.
- [ ] REFACTOR: Add headers to new `events/` modules; keep the composition root readable top-to-bottom.

#### M3: Decompose `agent/loop.ts`

- [ ] RED: Confirm loop characterization tests green pre-split.
- [ ] GREEN: Extract cohesive helpers (tool-call orchestration, stream handling) without scattering control flow.
- [ ] RED: Re-run characterization + turn suites.
- [ ] REFACTOR: Headers + ensure the loop's main control flow still reads in one place.

#### M4: Decompose `tools/docs/docs.ts`

- [ ] RED: Add/confirm docs-tool behavioral tests.
- [ ] GREEN: Split into cohesive sub-modules under `tools/docs/` by responsibility.
- [ ] RED: Re-run docs-tool tests.
- [ ] REFACTOR: Headers + remove dead seams.

#### M5: Decompose `doctor/snapshot.ts` (coordinate with plan 41)

- [ ] RED: Add/confirm doctor snapshot tests; reconcile with plan 41's area model.
- [ ] GREEN: Split `snapshot.ts` into cohesive sub-modules; absorb `doctorFacts` from `main.ts`.
- [ ] RED: Re-run doctor tests.
- [ ] REFACTOR: Headers + confirm `tools/doctor.ts` thin-delegates to `doctor/`.

### Phase 3: Verification

#### M6: Full Verification and Bisectability Check

- [ ] RED: Confirm each god-file split landed as its own isolated commit.
- [ ] GREEN: Run lint, typecheck, all Vitest projects, and the hermetic e2e lane.
- [ ] REFACTOR: Record completed verification commands and confirm the cohesion bar holds.

### Done Gate

- [ ] All four god-files decomposed in place; characterization + full suites green.
- [ ] `main.ts` retains a visible routing table and readable composition root (no dispatch map).
- [ ] Each split is a separate, bisectable commit.

## Superseded/Obsolete Checklist Debt

None.
