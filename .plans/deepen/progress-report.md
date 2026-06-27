# Deepen — Progress Report

Standing deepening backlog. Each candidate is checked ONLY when its deepening has been
implemented (via a separate `planner` redesign session) and merged. Recording a candidate
here does not check it. The backlog is pick-any — there is no current-focus sequencing.

**Summary:** 8 candidates recorded, 0 implemented. Audit passes run: 1.

## High

- [ ] DC-001 — Collapse the `ToolMessage` thin wrapper (`web/components/chat/tool-message.tsx`)
- [ ] DC-002 — Centralize duplicated markdown-body rendering (`web/components/chat/{message,transcript-row-view,queued-prompts}.tsx`)

## Medium

- [ ] DC-003 — Provider metadata registry behind `pi-key` (`agent-host/providers/pi-key.ts` + catalog + protocol-anomaly)
- [ ] DC-004 — Finish deprecating the `ToolGroup` wrapper (`web/components/assistant-ui/tool-group.tsx`)
- [ ] DC-005 — Collapse the twin `ResumeModal`/`WorktreeModal` wrappers (`web/resume`, `web/worktrees`)
- [ ] DC-006 — Remove the `richterTransport` pass-through (`packages/richter/src/client.ts`)

## Low

- [ ] DC-007 — Inline the `useInventory` query-mapping hook (`web/resume/use-inventory.ts`)
- [ ] DC-008 — Inline the `PanelControls` prop pass-through (`web/components/panel/panel-controls.tsx`)
