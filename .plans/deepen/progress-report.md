# Deepen - Progress Report

> A standing backlog: each box is one recorded deepening candidate; check it only when that
> deepening has been designed (planner) and shipped. Boxes are appended by /deepen-plan passes.

## Summary

> Current focus: M1: SessionTransport read/await/identity helpers

- Total checklist items: 25
- Completed: 0
- Current cutoff blockers: 25

## High

- [ ] M1: SessionTransport read/await/identity helpers (packages/session)
- [ ] M2: child-spawn hygiene primitive (agent-host processes/)
- [ ] M3: hostAnnouncement projection (web derive.ts)
- [ ] M4: provider-failure sink (agent-host agent/ + loop-failures)

- [ ] M21: url-guard async SSRF boundary (tools/web-fetch; pass 2)
- [ ] M22: per-tool argument schema owner (web; pass 2)

## Medium

- [ ] M5: framed JSON-RPC child connection (mcp + lsp; after M2)
- [ ] M6: ConversationLog history-projection state (agent-host)
- [ ] M7: peripheral classification fold (doctor mcp/lsp/hooks-status)
- [ ] M8: doctor fact-bag ctx.doctor (commands.ts)
- [ ] M9: LSP request pipeline helper (tools/lsp-shared)
- [ ] M10: publish(prompt) object signature (web hooks)
- [ ] M11: programmatic-command dispatch lane (main.ts user.command arm)
- [ ] M12: startStore boot helper (server-kit)
- [ ] M13: joinSession + waitForType (test-kit)

- [ ] M23: session fan-out hub (session-store; pass 2)

## Low

- [ ] M14: ActiveRun cell (runningRunId + activeSwitch)
- [ ] M15: failure-record-schema evidence composition (providers)
- [ ] M16: useActiveModel extraction (web app.tsx)
- [ ] M17: @trevor/session testing leaf (conformance primitives)
- [ ] M18: compaction planner forwarders (agent/compactor)
- [ ] M19: shellMessageStatus (web tool-status)
- [ ] M20: transcript message-kind descriptor registry (web renderers)
- [ ] M24: requireLoadedCorpus (tools/docs; pass 2)
- [ ] M25: worktree summaryRow builder (worktrees/manager; pass 2)
