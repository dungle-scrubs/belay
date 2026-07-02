# Main Composition Slimming - Implementation Plan

Finishes the `main.ts` decomposition plan 22.2 deferred under its escape hatch. After plans 23-25
wired their runtimes, `main.ts` sits at ~1953 lines; the six clusters below are the remaining
extractable mass. <!-- D-001 -->

## 0. Hard Dependencies

- [x] Plan 22.2 (merged): the make*(deps) factory pattern, the characterization net
  (`test/routing-characterization.test.ts`), and its D-003/D-004 constraints (visible routing chain
  and readable composition root stay in `main.ts`).

## Architecture

Behavior-preserving extractions, one commit per cluster, exactly the 22.2 M2 mechanics: deps objects
for `main.ts`-owned mutable state (getters/setters), static imports for module singletons, the same
local names at the wiring site so `handleEvent`/dispatch call sites do not change shape. <!-- D-002 -->

| Cluster | Members | Target |
|---|---|---|
| Continuation/control prompts | controlProvider, controlModel, controlPromptEvent, publishControlPrompt, continueAfterStop, retryLastPrompt, clipPromptEvent, runClip, compressThenContinue, maybeAutoResume (+ autoContinuedRuns) | `agent/control-prompts.ts` |
| Run lifecycle | closeRun, abortRuns, reapOrphans | `agent/run-lifecycle.ts` |
| Compaction commands | compactionProgress, needsCompaction, startCompaction, forceCompact (+ manualCompactFiber ownership if clean) | `agent/compaction-commands.ts` |
| Shell lane | runShellCommand | `processes/shell-lane.ts` |
| Presence/leadership | currentGit, currentWorktrees, announceOnline, goLive, onBecomeLeader (+ leaseRunning if clean) | `transport/presence.ts` + `boot/leadership.ts` |
| Turn fork | startTurn (+ runningRunId/activeSwitch/backgroundChildren ownership decisions) | `agent/start-turn.ts` |

Stays in `main.ts` per 22.2 D-003/D-004: config/singleton construction, the factory wiring section,
`emit`/`EmitLive`, `admit`/`recordEvent`, the full visible `handleEvent` routing chain, `connect`,
signal handlers, and the bootstrap tail. Target size ~1100 lines. <!-- D-001 -->

## Phases

### Phase 1: Extraction

#### M1: Continuation + run lifecycle + compaction clusters

- **Tasks:**
  1. RED: Characterization + turn/loop suites green pre-split.
  2. GREEN: Extract the three agent/ clusters as factories, one pure-extraction commit each.
  3. RED: Suites re-run green after each commit.

#### M2: Shell lane + presence/leadership + turn fork

- **Tasks:**
  1. GREEN: Extract the remaining three clusters, one commit each; wiring order stays TDZ-valid.
  2. RED: Characterization (startup order pin) + full suites green after each commit.
  3. REFACTOR: Headers on new modules; the factory wiring section reads as one block.

### Phase 2: Verification

#### M3: Full gate

- **Tasks:**
  1. GREEN: `pnpm lint`, `pnpm typecheck`, full `pnpm test` (unit/integration/web/hermetic e2e).
  2. GREEN: Boot the host from a foreign cwd (tsx + TSX_TSCONFIG_PATH) to prove startup intact.
  3. REFACTOR: Record final line counts; confirm main.ts is composition + routing only.

### Done Gate

- [ ] main.ts ~1100 lines; every extracted cluster in its domain dir with headers.
- [ ] Routing chain + startup narrative still visible in main.ts (characterization green).
- [ ] Full suites green; host boots.

## Non-Goals

Splitting `handleEvent` (D-003 keeps the routing chain local); any behavior change; touching the
plan-23/24/25 runtime singletons beyond wiring.

## Validation Commands

```bash
pnpm lint && pnpm typecheck && pnpm test
```

## Decisions

Canonical decisions in `.plans/22.3-main-composition-slimming/plan.db`.
