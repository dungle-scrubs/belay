# Shell Promote Background Jobs - Implementation Plan

## 0. Hard Dependencies

- [x] Existing V2 `ProcessSupervisor` - `apps/agent-host/src/processes.ts` already owns tracked `pN` jobs, ring-buffered stdout/stderr, poll, kill, and list semantics.
- [x] Existing V2 background subagent registry - `apps/agent-host/src/main.ts` tracks session-level background children and exposes them to diagnostics.
- [x] `09-task-panel-freshness` - the task panel freshness plan owns stale-active-state problems and the current task-area behavior this plan extends.
- [x] Existing V1 reference behavior - `~/dev/trevor/tui/src/ui/tasks.rs` provides the prior support-surface model: tasks and background work share a bottom area, split into columns when both exist, with background subagents grouped above background jobs.
- [ ] `28-tool-detail-takeover` - required before promoted jobs can open the full live detail takeover surface; the first runtime promotion slice can still define process read models, but final UI completion depends on this.

## 1. Architecture

`shell.promote` turns an overlong blocking shell command into a tracked background job instead of treating timeout as the end of the story. The host already has two execution lanes:

- `bash`: blocking shell command with safety floor, timeout, and capped output.
- `process`: non-blocking supervisor-managed `pN` job with poll/kill/list and bounded output rings.

This plan bridges them. When a bash or prompt-shell command is eligible for promotion, the host should adopt it into the supervisor model and publish a user-visible background job state. The transcript should stop pretending the original blocking tool is still the only surface. The user should be able to see the adopted `pN` job in the activity panel, inspect live output through the tool-detail takeover once available, and stop/kill it through the same process controls.

The UI extends the current `TasksPanel` area into a Storybook-first "thread support" area inspired by Trevor V1:

- If tasks exist and background activity exists, show two columns when the parent container is wide enough.
- Left column: tasks.
- Right column: background activity.
- Background activity column groups background subagents first and promoted/background processes second.
- If only one of tasks/background activity exists, use one column.
- If the parent is not wide enough, stack or collapse to a single-column presentation without hiding status.

The activity panel and the tool-detail takeover should be conceptually aligned: the panel is the compact live overview; the takeover is where the user zooms into real-time bash/process output, terminal output, MCP streams, or other detail-rich work.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Storybook first | Combined task/background activity states are reviewed before live app wiring. |
| Promotion is explicit policy | The plan must define when timeout promotes versus returns a timeout error. |
| No orphaned processes | Promoted jobs remain host-owned and die with host shutdown unless a later plan explicitly persists them. |
| Same safety floor | Promotion must not bypass bash/process command safety classification. |
| UI mirrors V1 shape | Tasks left, background right when both exist and width permits; background subagents above jobs. |
| Detail alignment | Promoted jobs expose the same live detail model that tool-detail takeover uses. |

### Boundaries

- `apps/agent-host/src/tools/run-shell.ts` owns blocking shell execution semantics today. This plan may split or extend that boundary so eligible commands can be started with a promotable child process instead of `exec`.
- `apps/agent-host/src/processes.ts` owns background job lifecycle, `pN` ids, output rings, poll/list/kill, and future promoted-job metadata.
- Session protocol/read models own job snapshots that web can render without polling through model tools.
- `apps/web/src/TasksPanel.tsx` should evolve into a support/activity panel rather than a task-only component.
- `28-tool-detail-takeover` owns the full detail takeover; this plan supplies the promoted-process read model and entry points.

### Observability

Promoted jobs are runtime/background behavior and need first-class observability:

- promotion decision: command, source surface (`bash`, prompt shell, or future shell lane), timeout/promotion threshold, run id/request id, cwd, and reason;
- job lifecycle: promoted, running, output appended, exited, killed, failed, missing, output-truncated;
- correlation ids: original tool call/request id, promoted `pN` id, session id, run id;
- user-visible inspection: activity panel row, transcript marker, detail takeover entry;
- failure payloads: refusal, spawn error, not eligible, already exited before promotion, process not found, kill failed.

## 2. Current State

V2 already has a supervisor-managed `process` tool that starts `pN` jobs and lets the model poll/kill/list them. It is model-driven and not currently an automatic continuation of `bash`.

V2 `bash` uses `exec` through `runShell`, which enforces safety classification, a 30s timeout, and a max buffer. Once `exec` times out, the current execution path returns a failed shell result; there is no supervised job to inspect.

V2 web currently renders only `TasksPanel` above the composer. It does not render a V1-style two-column support area with tasks plus background subagents/jobs.

V1 has a useful reference shape in `tui/src/ui/tasks.rs`: task lines and background lines share a thread support area, split horizontally when both exist, and background lines combine subagent rows above job rows.

## 3. Phases

### Phase 1: Promotion Policy and Supervisor Contract

**Goal:** Define when a shell command can become a supervised `pN` job and how that job is represented.

**Gate from previous:** Existing `ProcessSupervisor` tests are understood and retained.

#### M1: Promotion Eligibility Contract

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for promotion decisions: eligible long-running command, safety-refused command, fast command, failed command, timed-out non-promotable command, and user-disabled promotion.
  2. GREEN: Define a promotion policy contract with source surface, command, cwd, timeout threshold, explicit disable/enable flag, and reason.
  3. RED: Add tests proving promotion uses the same bash/process safety floor.
  4. GREEN: Implement a pure policy function that decides `complete`, `fail`, `refuse`, or `promote`.
  5. REFACTOR: Keep policy separate from child-process spawning.

#### M2: Promoted Job Metadata

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add `ProcessSupervisor` tests for promoted job metadata: original command, source, originating run/tool/request ids, cwd, started/promoted timestamps, status, exit code, and output cursors.
  2. GREEN: Extend the process read model without breaking existing `process` tool list/poll/kill behavior.
  3. RED: Add tests for promoted job lifecycle events or snapshots.
  4. GREEN: Define session-visible background job snapshot events/read model.
  5. REFACTOR: Keep model-facing `process` output capped while UI snapshots remain structured.

### Gate 1->2

- [ ] Promotion policy tests pass.
- [ ] Existing `process` tool behavior remains compatible.
- [ ] Promoted jobs have stable ids and structured metadata.

### Phase 2: Runtime Promotion

**Goal:** Eligible shell commands can be adopted into the supervisor without losing output or creating orphaned processes.

**Gate from previous:** Promotion contract and supervisor metadata are ready.

#### M3: Promotable Shell Runner

- **Dependencies:** M2
- **Effort:** L
- **Tasks:**
  1. RED: Add tests for a shell command that crosses the promotion threshold and becomes a running `pN` job.
  2. GREEN: Introduce a promotable runner that uses child-process pipes compatible with the supervisor ring buffer.
  3. RED: Add tests for stdout/stderr emitted before, during, and after promotion.
  4. GREEN: Preserve output already produced by the command when it is promoted.
  5. REFACTOR: Share safety, cwd, env, cap, and spawn-error handling with existing bash/process code.

#### M4: Bash and Prompt-Shell Integration

- **Dependencies:** M3
- **Effort:** L
- **Tasks:**
  1. RED: Add bash tool tests for promoted result shape: original tool result says promoted and includes `pN`.
  2. GREEN: Wire eligible `bash` calls to promote rather than fail on the promotion threshold.
  3. RED: Add prompt-shell lane tests for promoted shell commands.
  4. GREEN: Publish prompt-shell promoted results without making output model-visible beyond the existing shell-lane contract.
  5. REFACTOR: Ensure cancellation/stop behavior is explicit: cancelling the parent run does not silently orphan a promoted job.

### Gate 2->3

- [ ] Eligible bash commands promote to `pN`.
- [ ] Prompt-shell commands can promote under the same policy.
- [ ] Parent cancellation and host shutdown behavior are tested.

### Phase 3: Storybook Activity Panel

**Goal:** The task area becomes a responsive support/activity panel showing tasks, background subagents, and background jobs.

**Gate from previous:** Structured task/background/job read models exist as fixtures.

#### M5: Support Panel Read Model

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add pure projection tests for support panel sections: tasks only, background subagents only, jobs only, tasks plus background, subagents plus jobs, and empty.
  2. GREEN: Define a `ThreadSupportPanel` read model with task rows and background groups.
  3. RED: Add ordering tests: tasks left; in background group, subagents before jobs.
  4. GREEN: Implement row status labels, counts, overflow metadata, and detail eligibility.
  5. REFACTOR: Keep projection independent from React layout.

#### M6: Responsive Storybook Surface

- **Dependencies:** M5
- **Effort:** M
- **Tasks:**
  1. RED: Add Storybook stories for V1-like states: tasks only, background only, both wide/two-column, both narrow/single-column, many rows with overflow, running subagent, running job, failed job, completed job.
  2. GREEN: Build the responsive support panel replacing the task-only panel in Storybook.
  3. RED: Add interaction tests for row actions, overflow disclosure, and detail-open affordances.
  4. GREEN: Implement two-column layout only when both task and background groups exist and the parent container is wide enough.
  5. REFACTOR: Keep row height stable and avoid nested card styling.

### Gate 3->4

- [ ] Storybook review confirms the V1-inspired two-column behavior.
- [ ] Single-column behavior works when only one section exists or width is constrained.
- [ ] Background subagents render above background jobs.

### Phase 4: Live UI Wiring and Detail Integration

**Goal:** Promoted jobs and background subagents show live in the app and can open detail takeover.

**Gate from previous:** Storybook surface approved and runtime promotion works.

#### M7: Live Support Panel Wiring

- **Dependencies:** M4, M6
- **Effort:** M
- **Tasks:**
  1. RED: Add web tests for live tasks plus background job snapshots rendering in the support panel.
  2. GREEN: Wire task snapshots, background subagent snapshots, and process job snapshots into the panel.
  3. RED: Add tests for live job exit/failure/kill updates without stale rows.
  4. GREEN: Update rows as session events arrive.
  5. REFACTOR: Keep panel state derived from session snapshots rather than local stale copies.

#### M8: Job Detail and Controls

- **Dependencies:** M7, `28-tool-detail-takeover`
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for opening a promoted job detail view from the support panel.
  2. GREEN: Open the tool-detail takeover with live stdout/stderr, command, cwd, status, age, and truncation indicators.
  3. RED: Add tests for kill/stop controls and failure states.
  4. GREEN: Wire kill/stop controls to supervisor actions with row-level feedback.
  5. REFACTOR: Share process detail model between transcript tool rows and support panel rows.

### Gate 4->5

- [ ] Live promoted jobs appear in the support panel.
- [ ] Detail takeover opens from promoted job rows.
- [ ] Kill/stop controls work and update row state.

### Phase 5: End-to-End Verification

**Goal:** Promotion, panel display, detail inspection, and cleanup are verified together.

**Gate from previous:** Runtime and UI wiring are complete.

#### M9: E2E and Manual Review

- **Dependencies:** M8
- **Effort:** M
- **Tasks:**
  1. RED: Add hermetic e2e coverage for an eligible long-running fake shell command promoting to a job.
  2. GREEN: Verify support panel row appears and updates through completion.
  3. RED: Add e2e coverage for killing a promoted job.
  4. GREEN: Verify detail takeover shows live output and returns to chat.
  5. REFACTOR: Add manual EZE checklist for Storybook review, live bash promotion, prompt-shell promotion, job kill, and host shutdown cleanup.

### Gate 5

- [ ] Unit, web, integration, and hermetic e2e tests pass.
- [ ] Storybook support panel review is approved.
- [ ] Manual EZE confirms promotion, two-column activity panel, live detail, and cleanup behavior.

## 4. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Promotion loses early output | high | medium | Use one runner/ring-buffer path and test output before/during/after promotion. | Host |
| Promotion bypasses safety floor | high | low | Centralize safety classification and test both bash and process paths. | Host |
| Parent cancellation semantics are confusing | high | medium | Explicitly decide and test whether promoted jobs survive parent cancellation; show row state immediately. | Host/Web |
| Activity panel becomes cluttered | medium | medium | V1-inspired capped rows, overflow count, Storybook density review. | Web |
| Tool detail and process detail diverge | medium | medium | Share process detail read model between promoted job rows and detail takeover. | Web |
| Background subagents and jobs are conflated | medium | medium | Separate background groups: subagents first, jobs second, distinct labels and controls. | Web |

## 5. Escape Hatches

1. **If true adoption from `exec` is unsafe:** replace the bash runner with a spawn-based runner before enabling promotion, so no process needs to be adopted after timeout.
2. **If automatic promotion policy is contentious:** ship manual "run as background process" affordance first, then enable auto-promote behind a config flag.
3. **If detail takeover is not ready:** ship the activity panel with job rows and basic kill controls, but keep full live output in a disabled detail affordance until `28-tool-detail-takeover` lands.
4. **If two-column density fails review:** preserve the grouping/order but use a single responsive stacked layout until a better wide layout is approved.

## 6. Progress Report Accounting

The progress report is `.plans/29-shell-promote-background-jobs/progress-report.md`. It tracks shell promotion, promoted process snapshots, the combined task/background support panel, and promoted-job detail integration. It does not track general tool-detail takeover implementation except as a dependency.

## 7. Validation Commands

```bash
pnpm --filter @trevor/agent-host test -- processes bash run-shell
pnpm --filter @trevor/web storybook
pnpm --filter @trevor/web test -- TasksPanel PanelHost
pnpm test -- --project e2e
pnpm typecheck
pnpm biome check
```

## 8. Decisions

Canonical decisions are in `.plans/29-shell-promote-background-jobs/plan.db`.

