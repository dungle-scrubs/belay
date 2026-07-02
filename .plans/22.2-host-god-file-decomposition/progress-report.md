# Host God-File Decomposition - Progress Report

> Gates cleared 2026-07-02: 22.1 merged; plans 28/21/10 do not move any of the four god-files
> (verified against their implementation plans); plan 41 already carries the D-008 forward
> accommodation expecting this plan's doctor split to land first.

## Summary

- Current focus: M3 - Decompose agent/loop.ts
- Current cutoff blockers: 18
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0
- Completed current work: 12

## Current Cutoff Blockers

### Phase 1: Characterization Safety Net

#### M1: Characterize Routing, Startup, and Loop Behavior

- [x] RED: Add characterization tests asserting `handleEvent` routes every current `SessionEvent` kind to its handler (completeness).
- [x] GREEN: Make them pass against current `main.ts` (document, not change, behavior).
- [x] RED: Add a startup/init-order assertion covering the composition-root wiring sequence.
- [x] GREEN: Make it pass against current startup.
- [x] RED: Add characterization tests for `agent/loop.ts`'s observable turn outcomes.
- [x] GREEN: Make them pass against the current loop.
- [x] REFACTOR: Keep the characterization suite fast and deterministic (fake provider).

### Phase 2: Decompose, One File at a Time

#### M2: Decompose `main.ts` (events extraction)

- [x] RED: Confirm the routing/startup characterization tests are green pre-split.
- [x] GREEN: Extract each long `handleEvent` handler body into `events/`, leaving a visible routing table in `main.ts`. (Shape per D-007: seven domain clusters - doctor/host-facts, worktrees/commands, handoff/orchestrator, providers/source-signin, session/session-switch, commands/lifecycle, serial-run/commands - instead of an events/ indirection layer; the routing chain stays whole in main.ts and its arms are now short delegations. main.ts 2932 -> 1926 lines.)
- [x] GREEN: Move remaining domain helpers in `main.ts` to their domain dirs (e.g. `doctorFacts` -> `doctor/`).
- [x] RED: Re-run characterization + turn/e2e suites.
- [x] REFACTOR: Add headers to new `events/` modules; keep the composition root readable top-to-bottom.

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
