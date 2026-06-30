# Host God-File Decomposition - Implementation Plan

> **Status: deferred / gated.** This plan is authored so the decision and design are not lost, but it does not start until its gates clear (see Hard Dependencies). It is the high-judgment counterpart to the mechanical `22.1`.

## 0. Hard Dependencies

- [ ] **Plan 22.1 (`22.1-codebase-organization`) must land first.** <!-- D-005 --> The four god-files are split *in place* in their post-22.1 homes; doing this before the relocation would entangle moves with semantic splits.
- [ ] **The affected files' package boundaries must be settled.** <!-- D-005 --> Plans 28 (`packages/sdk`), 21, and 10 redraw coarse package boundaries; decomposing a file those plans will move/extract means decompose-then-re-decompose. Gate each god-file on whether a pending plan still intends to move it - not on all churn everywhere.
- [ ] **Doctor work coordinates with plan 41 (`41-doctor-health-surface`).** <!-- D-005 --> Splitting `doctor/snapshot.ts` and moving `doctorFacts` out of `main.ts` overlaps 41's doctor rebaseline; sequence so they do not fight.

## Architecture

This plan decomposes the host's four god-files so a reader holds one cohesive responsibility at a time. The four are ~20% of host LOC concentrated in four outliers (the next-biggest file is ~633 lines), and after 22.1 they already sit in their domain dirs - so this is a set of four targeted, **in-place** splits, not a layout change. <!-- D-001 -->

| File | LOC | Nature | Split approach |
|---|---|---|---|
| `main.ts` | 2652 | sequential narrative (composition root + startup + `handleEvent` routing) | Extract handler **bodies** into `events/`; keep the composition root and the routing **table** visible and local. <!-- D-003 --> |
| `agent/loop.ts` | 1038 | sequential narrative (model<->tool loop) | Extract cohesive helpers; preserve the loop's control-flow locality. <!-- D-004 --> |
| `tools/docs/docs.ts` | 895 | bag-of-concerns | Split into cohesive sub-modules under `tools/docs/`. <!-- D-004 --> |
| `doctor/snapshot.ts` | 799 | bag-of-concerns | Split into cohesive sub-modules; absorb `doctorFacts` relocated from `main.ts`. <!-- D-004 --> |

The discipline that makes this safe is **characterization-tests-first**: before splitting a file, pin its observable behavior - especially `handleEvent` routing completeness and startup/init order - then split keeping those tests green. <!-- D-002 --> Each god-file is split as its own commit so a regression is bisectable to one file. <!-- D-001 -->

### Key Constraints

| Constraint | Impact |
|---|---|
| Behavior-preserving | No observable change to turns, events, the loop, docs tooling, or doctor output. Proven by characterization tests + existing suites. <!-- D-001 --> |
| Tests before splits | `handleEvent` routing completeness and startup/init order are characterized before any extraction; these are exactly what typecheck and existing tests do not assert. <!-- D-002 --> |
| Keep the transition table local | `main.ts`'s event routing stays a visible switch/table; do NOT convert it into a scattered dispatch map. <!-- D-003 --> |
| Split by responsibility, not size | Sequential narratives (`main.ts`, `loop.ts`) are slimmed cautiously; only genuine bag-of-concerns files are broken into sub-modules. Line count is never the reason. <!-- D-004 --> |
| One file at a time | Each god-file split is an isolated, bisectable commit. <!-- D-001 --> |

### Boundaries

This plan owns the internal decomposition of the four named files and the `events/` dir that receives `main.ts`'s handler bodies. It does not own file relocation or renames (22.1), package extraction (28), or the doctor area model (41, which it coordinates with).

### Observability

The `events/` extraction must preserve every existing log/emit at the event boundary; characterization tests assert routing completeness so no event silently loses its handler.

## Phases

### Phase 1: Characterization Safety Net

**Goal:** Observable behavior of the god-files is pinned before any structural change.

**Gate from previous:** 22.1 merged; per-file boundary gates clear.

#### M1: Characterize Routing, Startup, and Loop Behavior

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add characterization tests asserting `handleEvent` routes every current `SessionEvent` kind to its handler (completeness). <!-- D-002 -->
  2. GREEN: Make them pass against current `main.ts` (they document, not change, behavior).
  3. RED: Add a startup/init-order assertion covering the composition-root wiring sequence. <!-- D-002 -->
  4. GREEN: Make it pass against current startup.
  5. RED: Add characterization tests for `agent/loop.ts`'s observable turn outcomes. <!-- D-004 -->
  6. GREEN: Make them pass against the current loop.
  7. REFACTOR: Keep the characterization suite fast and deterministic (fake provider).

### Phase 2: Decompose, One File at a Time

**Goal:** Each god-file is split into cohesive units with the safety net green.

**Gate from previous:** characterization suite green.

#### M2: Decompose `main.ts` (events extraction)

- **Dependencies:** M1
- **Effort:** L
- **Tasks:**
  1. RED: Confirm the routing/startup characterization tests are green pre-split.
  2. GREEN: Extract each long `handleEvent` handler **body** into `events/`, leaving a visible routing table in `main.ts`. <!-- D-003 -->
  3. GREEN: Move remaining domain helpers in `main.ts` to their domain dirs (e.g. `doctorFacts` -> `doctor/`). <!-- D-004 -->
  4. RED: Re-run characterization + turn/e2e suites.
  5. REFACTOR: Add `Responsible for / Not for` headers to the new `events/` modules; keep the composition root readable top-to-bottom. <!-- D-003 -->

#### M3: Decompose `agent/loop.ts`

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Confirm loop characterization tests green pre-split.
  2. GREEN: Extract cohesive helpers (e.g. tool-call orchestration, stream handling) without scattering the loop's control flow. <!-- D-004 -->
  3. RED: Re-run characterization + turn suites.
  4. REFACTOR: Headers + ensure the loop's main control flow still reads in one place.

#### M4: Decompose `tools/docs/docs.ts`

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Add/confirm docs-tool behavioral tests.
  2. GREEN: Split into cohesive sub-modules under `tools/docs/` by responsibility. <!-- D-004 -->
  3. RED: Re-run docs-tool tests.
  4. REFACTOR: Headers + remove dead seams.

#### M5: Decompose `doctor/snapshot.ts` (coordinate with plan 41)

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add/confirm doctor snapshot tests; reconcile with plan 41's area model. <!-- D-005 -->
  2. GREEN: Split `snapshot.ts` into cohesive sub-modules; absorb `doctorFacts` from `main.ts`. <!-- D-004 -->
  3. RED: Re-run doctor tests.
  4. REFACTOR: Headers + confirm `tools/doctor.ts` thin-delegates to `doctor/`.

### Phase 3: Verification

#### M6: Full Verification and Bisectability Check

- **Dependencies:** M5
- **Effort:** S
- **Tasks:**
  1. RED: Confirm each god-file split landed as its own isolated commit.
  2. GREEN: Run lint, typecheck, all Vitest projects, and the hermetic e2e lane. <!-- D-001 -->
  3. REFACTOR: Record completed verification commands and confirm no file exceeds the agreed cohesion bar without justification.

### Done Gate

- [ ] All four god-files decomposed in place; characterization + full suites green.
- [ ] `main.ts` retains a visible routing table and a readable composition root (no dispatch map). <!-- D-003 -->
- [ ] Each split is a separate, bisectable commit.

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---|---|---|---|
| Silent regression in init order / event routing | high | medium | Characterization tests first; split only with the net green. <!-- D-002 --> | implementer |
| Splitting a sequential narrative raises reader context cost | medium | medium | Slim cautiously; keep control flow and routing table local. <!-- D-003 --> <!-- D-004 --> | implementer |
| Doctor split collides with plan 41 | medium | medium | Sequence/coordinate with 41's rebaseline. <!-- D-005 --> | implementer |
| Decompose-then-re-decompose if 28/21/10 move a file | medium | medium | Gate each file on whether a pending plan still intends to move it. <!-- D-005 --> | implementer |

## Escape Hatches

1. **If a god-file is about to be moved by 28/21/10:** defer that one file's split until after that plan lands; do the others.
2. **If `main.ts` resists clean handler extraction:** stop at extracting only the longest handlers; a smaller, still-readable `main.ts` beats an over-split one.
3. **If characterization coverage is too thin to trust a split:** widen the net before splitting; do not split on faith.

## Progress Report Accounting

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "22.2-host-god-file-decomposition"
```

## Validation Commands

```bash
pnpm lint
pnpm typecheck
pnpm test -- --project unit
pnpm test -- --project integration
pnpm test -- --project e2e
```

## Decisions

Canonical decisions are in `.plans/22.2-host-god-file-decomposition/plan.db`. Query them with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "22.2-host-god-file-decomposition"
```
