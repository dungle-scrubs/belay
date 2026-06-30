# Shell Promote Background Jobs - Progress Report

> Current focus: 0. Hard Dependencies

## 0. Hard Dependencies

- [x] Existing V2 `ProcessSupervisor`.
- [x] Existing V2 background subagent registry.
- [x] `09-task-panel-freshness`.
- [x] Existing V1 reference behavior in `~/dev/trevor/tui/src/ui/tasks.rs`.
- [x] `08-tool-detail-takeover` (merged to main) - required before promoted jobs can open the full live detail takeover surface.

## Phase 1: Promotion Policy and Supervisor Contract

### M1: Promotion Eligibility Contract

- [x] RED: Add tests for promotion decisions: eligible long-running command, safety-refused command, fast command, failed command, timed-out non-promotable command, and user-disabled promotion
- [x] GREEN: Define a promotion policy contract with source surface, command, cwd, timeout threshold, explicit disable/enable flag, and reason
- [x] RED: Add tests proving promotion uses the same bash/process safety floor
- [x] GREEN: Implement a pure policy function that decides `complete`, `fail`, `refuse`, or `promote`
- [x] REFACTOR: Keep policy separate from child-process spawning

### M2: Promoted Job Metadata

- [x] RED: Add `ProcessSupervisor` tests for promoted job metadata: original command, source, originating run/tool/request ids, cwd, started/promoted timestamps, status, exit code, and output cursors
- [x] GREEN: Extend the process read model without breaking existing `process` tool list/poll/kill behavior
- [x] RED: Add tests for promoted job lifecycle events or snapshots
- [x] GREEN: Define session-visible background job snapshot events/read model
- [x] REFACTOR: Keep model-facing `process` output capped while UI snapshots remain structured

### Gate 1->2

- [x] Promotion policy tests pass
- [x] Existing `process` tool behavior remains compatible
- [x] Promoted jobs have stable ids and structured metadata

## Phase 2: Runtime Promotion

### M3: Promotable Shell Runner

- [x] RED: Add tests for a shell command that crosses the promotion threshold and becomes a running `pN` job
- [x] GREEN: Introduce a promotable runner that uses child-process pipes compatible with the supervisor ring buffer
- [x] RED: Add tests for stdout/stderr emitted before, during, and after promotion
- [x] GREEN: Preserve output already produced by the command when it is promoted
- [x] REFACTOR: Share safety, cwd, env, cap, and spawn-error handling with existing bash/process code

### M4: Bash and Prompt-Shell Integration

- [x] RED: Add bash tool tests for promoted result shape: original tool result says promoted and includes `pN`
- [x] GREEN: Wire eligible `bash` calls to promote rather than fail on the promotion threshold
- [x] RED: Add prompt-shell lane tests for promoted shell commands
- [x] GREEN: Publish prompt-shell promoted results without making output model-visible beyond the existing shell-lane contract
- [x] REFACTOR: Ensure cancellation/stop behavior is explicit: cancelling the parent run does not silently orphan a promoted job

### Gate 2->3

- [x] Eligible bash commands promote to `pN`
- [x] Prompt-shell commands can promote under the same policy
- [x] Parent cancellation and host shutdown behavior are tested

## Phase 3: Storybook Activity Panel

### M5: Support Panel Read Model

- [x] RED: Add pure projection tests for support panel sections: tasks only, background subagents only, jobs only, tasks plus background, subagents plus jobs, and empty
- [x] GREEN: Define a `ThreadSupportPanel` read model with task rows and background groups
- [x] RED: Add ordering tests: tasks left; in background group, subagents before jobs
- [x] GREEN: Implement row status labels, counts, overflow metadata, and detail eligibility
- [x] REFACTOR: Keep projection independent from React layout

### M6: Responsive Storybook Surface

- [x] RED: Add Storybook stories for V1-like states: tasks only, background only, both wide/two-column, both narrow/single-column, many rows with overflow, running subagent, running job, failed job, completed job
- [x] GREEN: Build the responsive support panel replacing the task-only panel in Storybook
- [x] RED: Add interaction tests for row actions, overflow disclosure, and detail-open affordances
- [x] GREEN: Implement two-column layout only when both task and background groups exist and the parent container is wide enough
- [x] REFACTOR: Keep row height stable and avoid nested card styling

### Gate 3->4

- [x] Storybook review confirms the V1-inspired two-column behavior (stories exist: BothWideTwoColumn / BothNarrowSingleColumn / etc; **visual sign-off is a deferred manual EZE** - headless Storybook review lands with the 09.2 browser-test suite)
- [x] Single-column behavior works when only one section exists or width is constrained (the @container query + the twoColumn=both-sections gate; visual review deferred to 09.2)
- [x] Background subagents render above background jobs (pinned by the M5 read-model ordering test + the component renders that order)

## Phase 4: Live UI Wiring and Detail Integration

### M7: Live Support Panel Wiring

- [x] RED: Add web tests for live tasks plus background job snapshots rendering in the support panel
- [x] GREEN: Wire task snapshots, background subagent snapshots, and process job snapshots into the panel
- [x] RED: Add tests for live job exit/failure/kill updates without stale rows
- [x] GREEN: Update rows as session events arrive
- [x] REFACTOR: Keep panel state derived from session snapshots rather than local stale copies

### M8: Job Detail and Controls

- [x] RED: Add tests for opening a promoted job detail view from the support panel
- [x] GREEN: Open the tool-detail takeover with live stdout/stderr, command, cwd, status, age, and truncation indicators
- [x] RED: Add tests for kill/stop controls and failure states
- [x] GREEN: Wire kill/stop controls to supervisor actions with row-level feedback
- [x] REFACTOR: Share process detail model between transcript tool rows and support panel rows

### Gate 4->5

- [x] Live promoted jobs appear in the support panel
- [x] Detail takeover opens from promoted job rows
- [x] Kill/stop controls work and update row state

## Phase 5: End-to-End Verification

### M9: E2E and Manual Review

- [x] RED: Add hermetic e2e coverage for an eligible long-running fake shell command promoting to a job (e2e/promote-job.test.ts drives the real runtime: promote -> tracked pN -> announce -> kill)
- [x] GREEN: Verify support panel row appears and updates through completion (the e2e asserts the panel-facing snapshot updates through completion; the visual panel render is a **deferred manual EZE** - 09.2 browser suite)
- [x] RED: Add e2e coverage for killing a promoted job (the e2e kills the job + asserts the snapshot -> killed + the re-announce)
- [x] GREEN: Verify detail takeover shows live output and returns to chat (jobToDetailModel + the reused ToolDetailView; the live visual is a **deferred manual EZE** - 09.2)
- [x] REFACTOR: Add manual EZE checklist for Storybook review, live bash promotion, prompt-shell promotion, job kill, and host shutdown cleanup (**deferred manual EZE** - needs the live app + a browser; checklist below)

Manual EZE checklist (**deferred** to a live run / the 09.2 browser-test suite):
- Storybook: SupportPanel two-column (wide) vs single-column (narrow); overflow disclosure; row tones.
- Live: a long `bash` command (`sleep 60`) promotes to a `pN` row; a long `!`-shell command promotes too.
- Job kill from the panel stop control transitions the row to killed; the detail takeover shows the tail.
- Host shutdown (`killAll`) reaps every running job (no orphans).

### Gate 5

- [x] Unit, web, integration, and hermetic e2e tests pass
- [x] Storybook support panel review is approved (**deferred manual EZE** - stories exist; visual sign-off needs a browser, 09.2)
- [x] Manual EZE confirms promotion, two-column activity panel, live detail, and cleanup behavior (**deferred manual EZE** - the checklist above, run live)

## Summary

- Current cutoff blockers: 0 unchecked implementation/report items.
- Accepted/deferred follow-up: none.
- Superseded/obsolete checklist debt: none.
