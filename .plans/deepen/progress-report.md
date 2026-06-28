# Deepen — Progress Report

Standing deepening backlog. Each candidate is checked ONLY when its deepening has been
implemented (via a separate `planner` redesign session) and merged. Recording a candidate
here does not check it. The backlog is pick-any — there is no current-focus sequencing.

**Summary:** 17 candidates recorded, 0 implemented. Audit passes run: 5 (per-pass new finds: 8, 5, 2, 1, 1).

## High

- [ ] DC-001 — Collapse the `ToolMessage` thin wrapper (`web/components/chat/tool-message.tsx`)
- [ ] DC-002 — Centralize duplicated markdown-body rendering (`web/components/chat/{message,transcript-row-view,queued-prompts}.tsx`)
- [ ] DC-009 — Single owner for reserved service ports (`trevor-cli/services.ts` + 5 consumers)
- [ ] DC-012 — Re-export provider error types from `providers/index.ts` (6 callers reach into `providers/errors`)
- [ ] DC-013 — Complete the `tools/index.ts` public surface (re-export errors + `Tool`; `processes`/`skills`/`tasks` reach in)
- [ ] DC-014 — `createService(routes)` lifecycle helper in `server-kit` (`blob-store` re-implements the request lifecycle)

## Medium

- [ ] DC-003 — Provider metadata registry behind `pi-key` (`agent-host/providers/pi-key.ts` + catalog + protocol-anomaly)
- [ ] DC-004 — Finish deprecating the `ToolGroup` wrapper (`web/components/assistant-ui/tool-group.tsx`)
- [ ] DC-005 — Collapse the twin `ResumeModal`/`WorktreeModal` wrappers (`web/resume`, `web/worktrees`)
- [ ] DC-006 — Remove the `richterTransport` pass-through (`packages/richter/src/client.ts`)
- [ ] DC-010 — Export a runtime `RECALL_KINDS` array from `packages/session` (`tools/session-recall.ts` hardcodes it)
- [ ] DC-015 — Shared `raceTimeout` abort+timeout utility (`trevor-cli/platform.ts` + `agent-host/connectivity/node-io.ts`)

## Low

- [ ] DC-007 — Inline the `useInventory` query-mapping hook (`web/resume/use-inventory.ts`)
- [ ] DC-008 — Inline the `PanelControls` prop pass-through (`web/components/panel/panel-controls.tsx`)
- [ ] DC-011 — Import `PRODUCER_IDS` in host tests instead of hardcoding (3 `agent/*.test.ts`)
- [ ] DC-016 — Fold doctor status→color logic into `DOCTOR_STATUS_META` (`web/components/chat/doctor/*`)
- [ ] DC-017 — One owner for doctor status→headline strings (`session/doctor.ts` + `web/.../doctor-summary.tsx`)
