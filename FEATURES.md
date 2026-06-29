# Trevor V2 - Features Ledger

This is the **implemented-feature ledger** for Trevor V2: a map of behavior that
**currently exists in this repository**, with implementation anchors and validation
references so a future agent can update it without rediscovering the whole system.

It is **descriptive, not aspirational**. It records what exists now and excludes
dropped work, unstarted backlog, and roadmap items. Planned work and the architecture /
roadmap source of truth live under [`.plans/`](.plans/) (the canonical Trevor V2
umbrella plan plus the numbered feature plans); per the root [`AGENTS.md`](AGENTS.md)
planning rule, the canonical plan wins when documents disagree. An entry becomes true
here only when the behavior is in code or tests.

## How to update this ledger

- **Update `FEATURES.md` in the same branch as the feature** whenever user-visible
  capability, a workflow, provider behavior, or an operator workflow is added, removed,
  or materially changed. The ledger update is part of feature completion, not later
  cleanup.
- Every implementation plan that changes user-visible behavior should include a
  `FEATURES.md` update task.
- Internal-only refactors that change no user-visible capability do **not** require a
  ledger update.
- Every entry needs at least one **implementation anchor** (a code or test path a
  maintainer can open). If a feature cannot be verified from code or tests, put it under
  **Needs verification** rather than presenting it as implemented.

## Schema

Each row: **Capability** (user-visible behavior) · **Implementation anchor** (where it
lives) · **Validation** (test/e2e evidence). Entries are grouped by product area.

---

## Session substrate (event log, stores, protocol)

Trevor is a multi-participant system over a durable event log: the browser and the host
are both participants; all state is projected from the log.

| Capability | Implementation anchor | Validation |
|---|---|---|
| Typed session event protocol (`user.*`, `assistant.*`, `tool.*`, `provider.question.*`, `handoff.*`, `context.*`, `session.*`, `host.*`) + permissive wire decode | `packages/session/src/protocol.ts`, `protocol-decode.ts` | `packages/session/src/*.test.ts` |
| Provider-question (`ask_user`) data contract: grouped questions, choices, answers, validation | `packages/session/src/provider-question.ts` | `provider-question.test.ts` |
| Isomorphic stream transport: `/sessions` REST + WebSocket stream, replay + live | `packages/session/src/stream-transport.ts`, `transport.ts`, `session-routes.ts` | `stream-transport.test.ts` |
| Reserved local ports (web 17420 / blob 17423 / store 17424) as one source of truth | `packages/session/src/ports.ts` | - |
| Local session store: SQLite event log + WS fan-out (standalone Richter equivalent) | `apps/session-store/` | `e2e/boot.test.ts`, `e2e/golden-path.test.ts` |
| Content-addressed blob store (sha256-named, immutable, dedup) for artifacts | `apps/blob-store/` | `e2e/blobs.test.ts` |
| Server kit (shared HTTP/WS server scaffolding for the stores) | `packages/server-kit/` | package tests |

## Host runtime (agent loop, scheduling, lifecycle)

The host (`apps/agent-host`) is an Effect program that runs the model↔tools agent loop
per turn and owns turn scheduling, leadership, and session lifecycle.

| Capability | Implementation anchor | Validation |
|---|---|---|
| Per-turn agent loop (model ↔ tools), streaming deltas/thinking/usage, typed termination | `apps/agent-host/src/turn.ts`, `turn-termination.test.ts`, `turn-preflight.ts` | `turn-termination.test.ts`, `e2e/live/agent.test.ts` |
| Adaptive step budget with auto-continue checkpoints: the step backstop is a re-evaluation CHECKPOINT, not a hard pause - a turn that reaches the adaptive budget with context headroom + progress AUTO-CONTINUES (quiet `assistant.continued` breadcrumb) instead of pausing; it terminates on the step axis only at the absolute emergency ceiling (256) or when context stops advancing (progress guard). Context-pressure and loop-stall stops stay authoritative | `apps/agent-host/src/agent/turn-policy.ts`, `turn-budget.ts`, `loop.ts`; web `transcript.ts` + `transcript-row-view.tsx` (quiet breadcrumb) | `turn-policy.test.ts`, `turn-budget.test.ts`, `loop.test.ts`, `test/turn.test.ts`, `transcript.test.ts`, `transcript-row-view.test.tsx` |
| Turn scheduler: one-turn-at-a-time, FIFO queue of mid-turn prompts, catch-up on leadership | `apps/agent-host/src/agent/turn-scheduler.ts` | `agent/*.test.ts` |
| Lease-based single-leader election (only the leader answers prompts) | `apps/agent-host/src/lease.ts` | `lease.test.ts` |
| Session lifecycle: ensure/switch/retire, replacement-host spawn | `apps/agent-host/src/session-lifecycle.ts` | `session-lifecycle.test.ts` |
| Workspace switch (`/cd`, `/worktree`) gated so a switch never abandons a live turn | `apps/agent-host/src/workspace-switch.ts` | `workspace-switch.test.ts` |
| Direct continuation handoff (`/handoff --direct <prompt>`): fresh target session + injected prompt + browser switch | `apps/agent-host/src/handoff.ts`, `handoff-flow.ts` | `handoff.test.ts`, `e2e/handoff.test.ts` |
| Generated continuation handoff (`/handoff` or `/handoff <request>`): the host drafts the target prompt with the provider (`handoff.requested`→`generating`→`generated`), the browser surfaces it for approve / edit / reject, and approval reuses the shared finalized-execution path to launch the target. Replaces the old dead-end "not available yet" failure | `apps/agent-host/src/handoff-generate.ts`, `handoff-flow.ts` (`executeFinalizedHandoff`), `main.ts` (`runGeneratedHandoff`/`approveHandoff`), `apps/web/src/components/handoff/HandoffApprovalSurface.tsx`, `apps/web/src/derive.ts` (`pendingHandoffFrom`) | `handoff-generate.test.ts`, `handoff-flow.test.ts`, `HandoffApprovalSurface.test.tsx`, `derive.test.ts`, `e2e/handoff.test.ts` |
| Control-prompt model fidelity: an auto-resumed / continued / retried / handed-off turn resolves its model in three tiers (last turn's catalog `ModelRef` → last real user turn's provider string, skipping the host's own control prompts → compaction/default), so a paused legacy-provider turn no longer silently downgrades to the local default model | `apps/agent-host/src/control-model.ts`, `main.ts` (`controlModel`) | `control-model.test.ts` |
| Context compaction (`/compact`): proactive + blocking-before fold, full history retained | `apps/agent-host/src/context/` , `main.ts` (fold gate) | `apps/agent-host/src/context/*.test.ts` |
| Managed git worktrees: announce + switch | `apps/agent-host/src/worktrees/` | worktree tests |
| Git status reporting on `host.online` | `apps/agent-host/src/git-status.ts` | `git-status.test.ts` |
| Background process registry + jobs (`/jobs`, `/jobs-stop`), shell-promote to background | `apps/agent-host/src/processes.ts`, `process-registry.ts` | `processes.test.ts` |
| Doctor health surface (`/doctor`) | `apps/agent-host/src/doctor/`, `tools/doctor.ts` | `doctor.test.ts` |
| Skills registry + `skill_view` / skills-list | `apps/agent-host/src/skills.ts`, `skill-registry.test.ts` | `skills.test.ts` |
| Capability manifest discovery | `apps/agent-host/src/manifest-discovery.ts` | - |
| Debug/operator commands (`/debug`, `/restart`, `/stop`, `/archive`, `/unarchive`) | `apps/agent-host/src/debug-commands.ts` | `debug-commands.test.ts` |
| Startup + connectivity + service wiring | `apps/agent-host/src/startup.ts`, `connectivity/`, `services.ts` | `startup.test.ts` |

## Providers

| Capability | Implementation anchor | Validation |
|---|---|---|
| Multi-provider catalog/roster (Anthropic, OpenAI-compatible, LM Studio local, Codex, pi-ai) | `apps/agent-host/src/providers/catalog.ts`, `roster.test.ts`, `index.ts` | `catalog.test.ts`, `roster.test.ts` |
| LM Studio local client (OpenAI-compatible) | `apps/agent-host/src/providers/lmstudio.ts`, `lmstudio-client.ts` | `lmstudio-client.test.ts` |
| pi-ai provider + key handling | `apps/agent-host/src/providers/pi-ai.ts`, `pi-key.ts` | `pi-ai.test.ts`, `pi-key.test.ts` |
| Provider failure taxonomy, error classification, anomaly detection, failure-evidence log | `apps/agent-host/src/providers/failure-taxonomy.ts`, `error-classifier.ts`, `protocol-anomaly.ts`, `provider-failure-log.ts` | `*.test.ts` in `providers/` |
| Provider-outage auto-reconnect: a transient pre-token stream drop is retried up to 10 attempts with a capped backoff curve (~75s, under the 90s stall watchdog); the transcript shows the true `attempt/maxAttempts`, and a generic transport detail is enriched with the specific syscall code recovered from the nested `.cause` chain (e.g. `Connection error. (ECONNRESET)`), redacted | `apps/agent-host/src/agent/loop.ts` (budget), `providers/failure-evidence.ts` (`causeChainDetail`), `pi-ai.ts`, `apps/web/src/transcript.ts` (`maxAttempts`) | `reconnect.test.ts`, `failure-evidence.test.ts`, `protocol.test.ts`, `transcript.test.ts` |
| Reasoning-level policy per provider/model | `apps/agent-host/src/providers/reasoning-policy.ts` | `reasoning-policy.test.ts` |
| Source auth / sign-in flow | `apps/agent-host/src/providers/source-auth.test.ts`, `provider-auth.ts` | `source-auth.test.ts` |
| System-prompt assembly | `apps/agent-host/src/providers/system-prompt.ts` | `system-prompt.test.ts` |
| Local observation/failure corpus store | `apps/agent-host/src/providers/observation-store.ts` | `observation-store.test.ts` |

## Tools (the agent's toolbelt)

| Capability | Implementation anchor | Validation |
|---|---|---|
| File read / write / edit / multi-edit (with diff) | `apps/agent-host/src/tools/read.ts`, `write.ts`, `edit.ts`, `multi-edit.ts`, `replace.ts` | `replace.test.ts`, web `multi-edit-diff` |
| Bash with safety gating + run-shell | `apps/agent-host/src/tools/bash.ts`, `bash-safety.ts`, `run-shell.ts` | `run-shell.test.ts` |
| Search: glob, grep, ast-grep, unified search, search-process | `apps/agent-host/src/tools/glob.ts`, `grep.ts`, `ast-grep.ts`, `search.ts` | `glob.test.ts`, `grep.test.ts`, `ast-grep.test.ts`, `search.test.ts` |
| `ask_user` provider question (blocking interactive question) | `apps/agent-host/src/tools/ask-user.ts` | `ask-user.test.ts`, `e2e/ask-user.test.ts` |
| `session_recall` (indexed prior-session recall) | `apps/agent-host/src/tools/session-recall.ts` | `session-recall.test.ts` |
| `web_search` | `apps/agent-host/src/tools/web-search.ts` | - |
| Open in editor | `apps/agent-host/src/tools/open-editor.ts` | - |
| Skill view / skills list | `apps/agent-host/src/tools/skill-view.ts`, `skills-list.ts` | `skill-view.test.ts` |
| Doctor (as a tool) | `apps/agent-host/src/tools/doctor.ts` | `doctor.test.ts` |

## Web frontend (the browser UI)

`apps/web` is a React 19 + Vite + Effect participant. State is projected from the event
log; pure selectors live in `derive.ts` / `transcript.ts`.

| Capability | Implementation anchor | Validation |
|---|---|---|
| Virtualized transcript (TanStack Virtual), reveal-at-live-edge, pinned follow | `apps/web/src/components/chat/virtual-transcript.tsx`, `transcript-rows.ts` | `virtual-transcript.test.tsx` |
| Transcript fold from event log (assistant segments, tools, shell, delegation, compaction, recovered/reconnecting) | `apps/web/src/transcript.ts` | `transcript.test.ts` |
| Scroll follow: at-bottom detection, jump-to-bottom chevron, unpinned auto-follow gate (`mayAutoFollow`) | `apps/web/src/scroll.ts`, `hooks/use-scroll-follow.ts` | `scroll.test.ts`, `use-scroll-follow.test.tsx` |
| Composer: draft + image tokens, attachments/upload, paste/drop, prompt-shell lane (`!`), slash menu | `apps/web/src/components/chat/prompt-input.tsx`, `hooks/use-composer.ts`, `use-slash-menu.ts` | `use-composer.test.tsx`, `use-slash-menu.test.tsx` |
| Local send queue + hard-steer fold; first-Escape queued steer, second-Escape cancel | `apps/web/src/send-queue.ts`, `hooks/use-send-queue.ts`, `esc-action.ts` | `send-queue.test.ts`, `use-send-queue.test.tsx`, `esc-action.test.ts` |
| Prompt history recall (ArrowUp/Down) + tab-scoped draft persistence | `apps/web/src/hooks/use-prompt-history.ts`, `use-draft-persistence.ts` | `*.test.tsx` |
| Full-surface prompt editor (takeover, composer-expand + programmatic open) | `apps/web/src/components/panel/prompt-surface-editor.tsx`, `hooks/use-prompt-editor.ts` | `prompt-surface-editor.test.tsx`, `use-prompt-editor.test.tsx` |
| Model chooser takeover + quick picker, per-provider reasoning, persisted preferences | `apps/web/src/components/chooser/model-chooser.tsx`, `hooks/use-model-selection.ts` | `model-chooser.test.tsx`, `use-model-selection.test.ts` |
| Model picker fidelity: the collapsed button shows the SELECTED model's name (catalog `displayName`, per-model) not the static per-provider roster label; model/effort/show-thinking/preferences are persisted PER SESSION (scoped localStorage keys) so changing one session never live-switches another; pi-ai's bundled per-model context window is correctable via a host-side override | `apps/web/src/model-selection.ts` (`activeModelLabel`, `sessionScopedKey`), `App.tsx`, `hooks/use-model-selection.ts`, `apps/agent-host/src/providers/model-metadata-overrides.ts`, `catalog.ts` | `model-selection.test.ts`, `use-model-selection.test.tsx`, `model-metadata-overrides.test.ts` |
| `ask_user` question surface (interactive answer, roving keyboard nav, focus-on-mount + on-window-return) | `apps/web/src/components/question/QuestionSurface.tsx` | `QuestionSurface.test.tsx` |
| Resolved-question slim transcript item (asked → answered, raw tool hidden) | `apps/web/src/components/chat/question-item.tsx`, `transcript.ts` | `question-item.test.tsx`, `transcript.test.ts` |
| Selection→Quote/Copy toolbar (drag-highlight transcript text, viewport-clamped) | `apps/web/src/components/assistant-ui/quote-selection-toolbar.tsx`, `quote-selection-placement.ts` | `quote-selection-toolbar.test.tsx`, `quote-selection-placement.test.ts` |
| Cross-item transcript selection persistence: shift-extend a selection across transcript items; a Trevor-owned highlight (CSS Custom Highlight API) stays visible after the native selection collapses or rows remount, and clears only on Escape/new selection; Copy/Quote act on the full cross-item range | `apps/web/src/components/assistant-ui/transcript-selection.ts`, `quote-selection-toolbar.tsx`, `chat/transcript-row-view.tsx`, `index.css` | `transcript-selection.test.tsx`, `quote-selection-toolbar.test.tsx`, `transcript-row-view.test.tsx` |
| Side panel: context/usage meter, request treemap, workspace identity, worktree count | `apps/web/src/components/panel/SidePanel.tsx`, `Treemap.tsx`, `WorkspaceIdentity.tsx` | panel tests |
| Session sidebar: list current-project sessions, rename/archive/soft-delete, switch | `apps/web/src/components/panel/session-sidebar.tsx` | `session-sidebar.test.tsx` |
| Resume chooser + worktree switcher (browser-side UI commands) | `apps/web/src/resume.ts`, `hooks/use-modal-state.ts`, `command-modal/` | `use-modal-state.test.tsx` |
| Tool rendering: per-tool cards, concurrent read-only batches, diffs, output, web-search, doctor | `apps/web/src/components/chat/tool-message.tsx`, `concurrent-tools.tsx`, `tool-diff.tsx`, `doctor/` | component tests |
| Markdown + image + diff rendering | `apps/web/src/components/chat/markdown-body.tsx`, `message-images.tsx`, `image-carousel.tsx` | `markdown.test.tsx`, `image-carousel.test.tsx` |
| Queued-prompts UI, compacting bar, internet/connectivity status, archived notice | `apps/web/src/components/chat/queued-prompts.tsx`, `compacting-bar.tsx`, `internet-status.tsx`, `archived-notice.tsx` | component tests |
| Global Escape policy (cancel / clear-draft / flush-queued-steer / modal precedence) | `apps/web/src/esc-action.ts`, `App.tsx` | `esc-action.test.ts` |
| Orphaned-turn recovery (phantom "Working" guard when no leader) | `apps/web/src/derive.ts` (`detectOrphanedTurn`) | `derive.test.ts` |
| Hostless-pending prompt affordance: a prompt left trailing on a session with no host connected shows the no-host affordance instead of an indefinite "Working" spinner (after the grace); the queued prompt still runs via the host's reattach catch-up | `apps/web/src/derive.ts` (`isHostlessPendingPrompt`), `App.tsx` | `derive.test.ts` |
| Host status / presence projection | `apps/web/src/derive.ts` (`hostStatus`) | `derive.test.ts` |
| `/loop` command surface (builder/guide/inventory, Storybook) | `apps/web/src/components/chat/loop/`, `commands/` | component tests/stories |

## CLI / launcher

| Capability | Implementation anchor | Validation |
|---|---|---|
| `trevor` CLI: launch + drive the local stack (stores + host + web) | `apps/trevor-cli/` | `e2e/boot.test.ts` |
| Headless host harness (boot a host without a browser) | `apps/agent-host/` (testing export), `packages/test-kit/` | `e2e/*.test.ts` |

## Verification notes

- **Test tiers** (one runner, four projects — see repo-root `AGENTS.md` "Testing"):
  `unit` (co-located `*.test.ts`, node), `integration` (`test/` dirs), `web` (`*.test.tsx`
  under jsdom), `e2e` (`e2e/`, boots real services). Run with
  `pnpm test:unit | test:integration | test:web | test:e2e`.
- **Hermetic e2e** for the cross-participant flows: `e2e/golden-path.test.ts`,
  `e2e/ask-user.test.ts`, `e2e/handoff.test.ts`, `e2e/blobs.test.ts`, `e2e/boot.test.ts`,
  `e2e/virtualization-performance-artifacts.test.ts`; live-model checks in `e2e/live/`.

### Needs verification

These exist in the tree but their current user-visible behavior was not directly
confirmed while writing this ledger; verify against code/tests before relying on them:

- Codex provider (`apps/agent-host/src/providers/codex.ts`) — wiring/runtime status.
- `web_search` and `open-editor` tools — end-to-end availability in the live UI.
- `/loop` command surface — host wiring vs Storybook-only state (see `.plans/` notes).
