# Loop Helper Composer Wiring - Implementation Plan

## 0. Hard Dependencies

- [ ] `17-loop-command-surface` (MERGED) - provides the `/loop` command family this plan surfaces: the
  shared `@trevor/session` contract (`loopPresentation`, `CommandParseResult`/`CommandToken`,
  `LoopSnapshot`, `LoopInventoryRow`, `LoopControl`, `loopControlCommand`), the already-built web
  components under `apps/web/src/components/chat/loop/`, and the host `loop.status` event emission +
  `/loop` command routing.

## Architecture

<!-- D-001 --> This is a WIRING plan, not a feature plan. Plan 17 built + Storybook-verified the `/loop`
web helper (`LoopHelper`, `LoopBuilder`, `LoopKeywords`, `LoopInventory`, the loop `command-input`) but
mounted it NOWHERE: the components are imported only by their own stories/tests, so the running app shows
no builder/preview/keyword-guide when a user types `/loop`. This plan mounts the existing, already-tested
components into the live composer + a live inventory. It adds NO new grammar, parsing, or validation - the
shared `@trevor/session` contract is the single source, reused verbatim.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| <!-- D-002 --> Reuse the shared contract | The web does no local parsing/validation; `loopPresentation(line)` + the built components are the only grammar source. The preview is advisory; Enter submits the raw text the host re-parses authoritatively (plan 17 D-002). |
| <!-- D-003 --> `loop.status` is the only inventory source | The inventory reflects host-published `LoopSnapshot`s; the web never invents loop state. Controls are protocol commands, never local mutations. |
| <!-- D-004 --> Additive to the composer | The helper renders ONLY when the active line is a `/loop` command; ordinary composing (text, other slash commands, `@`-mentions) is untouched. |

### Boundaries

- **`@trevor/session` (shared):** add the `loop.status` decode arm to `protocol-decode.ts` (plan 17 added
  the `events.loopStatus` emit constructor but no `DecodedEvent` arm), and a PURE
  `loopSnapshotToInventoryRow(snapshot)` projection beside `LoopInventoryRow` (the `LoopSnapshot` ->
  `LoopInventoryRow` bridge plan 17 left unwired - status mapping to the client 6-state `LoopStatus`,
  per-state `LoopControl` set, `agentBacked`, progress, `nextRun`). Pure + unit-tested; no React.
- **`apps/web` (composer):** `prompt-input.tsx` (+ the `composer/` hooks) detects a `/loop` head on the
  active line and renders `LoopHelper` above the input, and applies the parser's `CommandToken` roles as
  syntax highlighting. A small `useLoopPreview` selector keeps `prompt-input` readable.
- **`apps/web` (inventory):** a `useLoopInventory` store/hook accumulates the latest `loop.status`
  snapshot per `loopId` (dropping `deleted`) and projects rows; a surface renders `LoopInventory`, whose
  `onControl` submits `/loop <verb> <id>` via the existing `loopControlCommand`.
- **No host changes.** The host already emits `loop.status` + routes `/loop` commands (plan 17). This plan
  is web + shared-contract only.

---

## Phases

### Phase 1: Composer Preview + Highlighting

**Goal:** Typing a `/loop` line in the running composer shows the live builder/preview + keyword guide and
highlights the command tokens - the plan-17 M7 gap.

#### M1: Mount the loop helper on a `/loop` line

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Web test - a composer whose active line is `/loop max 5 do "run tests"` renders the builder
     (parsed field rows + `ready`), and a non-`/loop` line renders NO loop helper.
  2. GREEN: In `prompt-input.tsx`, detect a `LOOP_COMMAND_NAMES` head on the active line and render
     `LoopHelper` above the input, fed by `loopPresentation(line)` (recomputed per keystroke - the parser
     is pure + cheap).
  3. RED: Web test - the helper updates live as the line changes (missing-field hints, value diagnostics,
     `ready`) and disappears when the line stops being a `/loop` command.
  4. GREEN: Wire the preview to the live composer value; unmount on a non-loop line.
  5. REFACTOR: Extract a `useLoopPreview(line)` selector so `prompt-input` stays focused; no duplicated
     loop knowledge in the composer.

#### M2: Syntax-highlight the `/loop` line

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Web test - a `/loop` composer line carries the parser's token roles (command / subcommand /
     keyword / value / flag / unknown) from `CommandParseResult.tokens`.
  2. GREEN: Map the parser `CommandToken` spans onto the composer's rendered input (the same roles the
     Storybook `command-input` renders), only for `/loop` lines.
  3. REFACTOR: Share the token->class mapping with the existing `command-input` rather than re-deriving it.

### Gate 1 to 2

- [ ] The composer shows the builder/preview + keyword guide on a `/loop` line and highlights its tokens.
- [ ] Ordinary composing (plain text, other slash commands, `@`-mentions) is unaffected.
- [ ] `pnpm test --project web` passes for the composer helper.

### Phase 2: Live Inventory

**Goal:** The inventory reflects live host `loop.status` events and its controls drive loops over the
command protocol.

#### M3: Decode + project `loop.status`

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Session test - `decodeTrevorEvent` decodes a `loop.status` event into a typed `DecodedEvent`
     carrying the `LoopSnapshot`.
  2. GREEN: Add the `loop.status` arm to `DecodedEvent` + `decodeTrevorEvent` in `protocol-decode.ts`.
  3. RED: Session test - `loopSnapshotToInventoryRow` maps a snapshot to a `LoopInventoryRow`: full
     `LoopLifecycle` status -> client `LoopStatus` (pending -> draft), per-state `LoopControl` set,
     `agentBacked` (false for `process`), progress, and `nextRun`; a `deleted` snapshot projects to null.
  4. GREEN: Implement the pure `loopSnapshotToInventoryRow` beside `LoopInventoryRow` in `@trevor/session`.
  5. REFACTOR: One owner for the status/controls mapping so the row and any status badge cannot drift.

#### M4: Inventory store, render, and live controls

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Web test - a `useLoopInventory` store fed a stream of `loop.status` events holds the latest
     snapshot per `loopId` as rows, replaces a row on a newer snapshot, and drops a `deleted` loop.
  2. GREEN: Implement the store/hook subscribed to decoded `loop.status` events.
  3. RED: Web test - `LoopInventory` renders the store's rows, and clicking a control submits
     `/loop <verb> <id>` (via `loopControlCommand`) rather than mutating local state.
  4. GREEN: Mount `LoopInventory` in a surface and wire `onControl` -> `loopControlCommand` -> the command
     submit path.
  5. REFACTOR: Keep the store transient/derived; the host `loop.status` stream stays the source of truth.

### Gate 2 to 3

- [ ] The inventory reflects live `loop.status` (create/pending/running/paused/stopped/completed/deleted).
- [ ] Inventory controls submit `/loop <verb> <id>` commands; there is no optimistic local mutation.
- [ ] `pnpm test --project web` + `pnpm test --project unit` pass for the projection + store.

### Phase 3: App-Integration Coverage

**Goal:** The end-to-end composer->create->inventory->control flow (the coverage plan 17's M7 skipped) is
tested deterministically.

#### M5: App-integration / e2e coverage

- **Dependencies:** M1, M2, M3, M4
- **Effort:** M
- **Tasks:**
  1. RED: App-integration test - typing a ready `/loop` line shows the builder, submitting it drives a
     `loop.status` (pending -> running) that the inventory renders, and a control button submits the
     matching command.
  2. GREEN: Stabilize the wiring under a deterministic event stream / fixtures.
  3. RED: Regression test - a non-`/loop` composer line shows no helper and no inventory churn.
  4. GREEN: Guard the loop-only rendering paths.
  5. REFACTOR: No natural-language drafting and no new host behavior enter here; keep the surface to
     mounting the plan-17 components.

### Gate 3 to Done

- [ ] `pnpm test --project web` passes for the composer helper + inventory behavior.
- [ ] Typing `/loop` in the running composer shows the builder/preview/keyword-guide (plan-17 M7 gap closed).
- [ ] Inventory controls submit `/loop` commands; the inventory is driven only by `loop.status`.
- [ ] No new grammar/parsing/validation ships; `@trevor/session` remains the single contract source.

---

## Non-Goals

- No new `/loop` grammar, parser, or validation - the `@trevor/session` contract is reused verbatim.
- No host-side changes: the loop runtime, runner seams, scheduler, and persistence are all plan 17. In
  particular the prompt/background runner-seam turn-await + real background isolation (plan 17's documented
  first-cut limitation) is a SEPARATE host follow-up, not in scope here.
- The deferred natural-language loop-drafting layer (plan 17 D-012) stays deferred.
- No slash-menu redesign - the host already announces `/loop`/`/loops`; this plan only mounts the helper.
