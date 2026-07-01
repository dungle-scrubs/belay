# Loop Helper Composer Wiring - Progress Report

## Summary

> Current focus: M1: Mount the loop helper on a `/loop` line
- Current cutoff blockers: 33 unchecked
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0

## Current Cutoff

### M1: Mount the loop helper on a `/loop` line

- [ ] RED: Web test - a composer whose active line is `/loop max 5 do "run tests"` renders the builder (parsed field rows + `ready`), and a non-`/loop` line renders NO loop helper.
- [ ] GREEN: In `prompt-input.tsx`, detect a `LOOP_COMMAND_NAMES` head on the active line and render `LoopHelper` above the input, fed by `loopPresentation(line)`.
- [ ] RED: Web test - the helper updates live as the line changes (missing-field hints, value diagnostics, `ready`) and disappears when the line stops being a `/loop` command.
- [ ] GREEN: Wire the preview to the live composer value; unmount on a non-loop line.
- [ ] REFACTOR: Extract a `useLoopPreview(line)` selector so `prompt-input` stays focused; no duplicated loop knowledge in the composer.

### M2: Syntax-highlight the `/loop` line

- [ ] RED: Web test - a `/loop` composer line carries the parser's token roles (command / subcommand / keyword / value / flag / unknown) from `CommandParseResult.tokens`.
- [ ] GREEN: Map the parser `CommandToken` spans onto the composer's rendered input, only for `/loop` lines.
- [ ] REFACTOR: Share the token->class mapping with the existing `command-input` rather than re-deriving it.

### Gate 1 to 2

- [ ] The composer shows the builder/preview + keyword guide on a `/loop` line and highlights its tokens.
- [ ] Ordinary composing (plain text, other slash commands, `@`-mentions) is unaffected.
- [ ] `pnpm test --project web` passes for the composer helper.

### M3: Decode + project `loop.status`

- [ ] RED: Session test - `decodeTrevorEvent` decodes a `loop.status` event into a typed `DecodedEvent` carrying the `LoopSnapshot`.
- [ ] GREEN: Add the `loop.status` arm to `DecodedEvent` + `decodeTrevorEvent` in `protocol-decode.ts`.
- [ ] RED: Session test - `loopSnapshotToInventoryRow` maps a snapshot to a `LoopInventoryRow` (status -> client `LoopStatus`, per-state controls, `agentBacked`, progress, `nextRun`); a `deleted` snapshot projects to null.
- [ ] GREEN: Implement the pure `loopSnapshotToInventoryRow` beside `LoopInventoryRow` in `@trevor/session`.
- [ ] REFACTOR: One owner for the status/controls mapping so the row and any status badge cannot drift.

### M4: Inventory store, render, and live controls

- [ ] RED: Web test - a `useLoopInventory` store fed a stream of `loop.status` events holds the latest snapshot per `loopId` as rows, replaces a row on a newer snapshot, and drops a `deleted` loop.
- [ ] GREEN: Implement the store/hook subscribed to decoded `loop.status` events.
- [ ] RED: Web test - `LoopInventory` renders the store's rows, and clicking a control submits `/loop <verb> <id>` (via `loopControlCommand`) rather than mutating local state.
- [ ] GREEN: Mount `LoopInventory` in a surface and wire `onControl` -> `loopControlCommand` -> the command submit path.
- [ ] REFACTOR: Keep the store transient/derived; the host `loop.status` stream stays the source of truth.

### Gate 2 to 3

- [ ] The inventory reflects live `loop.status` (create/pending/running/paused/stopped/completed/deleted).
- [ ] Inventory controls submit `/loop <verb> <id>` commands; there is no optimistic local mutation.
- [ ] `pnpm test --project web` + `pnpm test --project unit` pass for the projection + store.

### M5: App-integration / e2e coverage

- [ ] RED: App-integration test - typing a ready `/loop` line shows the builder, submitting it drives a `loop.status` (pending -> running) that the inventory renders, and a control button submits the matching command.
- [ ] GREEN: Stabilize the wiring under a deterministic event stream / fixtures.
- [ ] RED: Regression test - a non-`/loop` composer line shows no helper and no inventory churn.
- [ ] GREEN: Guard the loop-only rendering paths.
- [ ] REFACTOR: No natural-language drafting and no new host behavior enter here; keep the surface to mounting the plan-17 components.

### Gate 3 to Done

- [ ] `pnpm test --project web` passes for the composer helper + inventory behavior.
- [ ] Typing `/loop` in the running composer shows the builder/preview/keyword-guide (plan-17 M7 gap closed).
- [ ] Inventory controls submit `/loop` commands; the inventory is driven only by `loop.status`.
- [ ] No new grammar/parsing/validation ships; `@trevor/session` remains the single contract source.
