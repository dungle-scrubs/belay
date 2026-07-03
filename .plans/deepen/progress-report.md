# Deepen - Progress Report

> A standing backlog: each box is one recorded deepening candidate; check it only when that
> deepening has been designed (planner) and shipped. Boxes are appended by /deepen-plan passes.

## Summary

> Current focus: complete

- Total checklist items: 30
- Completed: 30
- Current cutoff blockers: 0

## High

- [x] M1: SessionTransport read/await/identity helpers (packages/session)
- [x] M2: child-spawn hygiene primitive (agent-host processes/)
- [x] M3: hostAnnouncement projection (web derive.ts)
- [x] M4: provider-failure sink (agent-host agent/ + loop-failures)

- [x] M21: url-guard async SSRF boundary (tools/web-fetch; pass 2)
- [x] M22: per-tool argument schema owner (web; pass 2)

## Medium

- [x] M5: framed JSON-RPC child connection (mcp + lsp; after M2)
- [x] M6: ConversationLog history-projection state (agent-host)
- [x] M7: peripheral classification fold (doctor mcp/lsp/hooks-status)
- [x] M8: doctor fact-bag ctx.doctor (commands.ts)
- [x] M9: LSP request pipeline helper (tools/lsp-shared)
- [x] M10: publish(prompt) object signature (web hooks)
- [x] M11: programmatic-command dispatch lane (main.ts user.command arm)
- [x] M12: startStore boot helper (server-kit)
- [x] M13: joinSession + waitForType (test-kit)

- [x] M23: session fan-out hub (session-store; pass 2)
- [x] M26: event-provenance predicates (host + session; pass 3)
- [x] M27: cancellable-fiber Exit interpretation (agent-host; pass 3)
- [x] M28: fork.ts public-surface narrowing (packages/session; pass 4)
- [x] M30: session-switch teardown invariant (session/handoff/main; pass 5)

## Low

- [x] M14: ActiveRun cell (runningRunId + activeSwitch)
- [x] M15: failure-record-schema evidence composition (providers)
- [x] M16: useActiveModel extraction (web app.tsx)
- [x] M17: @trevor/session testing leaf (conformance primitives)
- [x] M18: compaction planner forwarders (agent/compactor)
- [x] M19: shellMessageStatus (web tool-status)
- [x] M20: transcript message-kind descriptor registry (web renderers)
- [x] M24: requireLoadedCorpus (tools/docs; pass 2)
- [x] M25: worktree summaryRow builder (worktrees/manager; pass 2)
- [x] M29: e2e/live live-turn harness (test-kit; pass 4)
