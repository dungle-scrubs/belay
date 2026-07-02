# LSP Integration - Progress Report

## Summary

- Current focus: complete - all milestones done
- Current cutoff blockers: 0
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0
- Completed current work: 83

## Current Cutoff Blockers

### Phase 1: Contract and Runtime Foundation

#### M1: Protocol and Tool Contract

- [x] RED: Add protocol/tool contract tests for LSP status, diagnostics, hover, document symbols, workspace symbols, and code-action proposal result shapes.
- [x] GREEN: Define shared result schemas with stable status, range, location, severity, symbol, and proposal types.
- [x] RED: Add tests for typed unavailable, unsupported, timeout, stale, and server-error outcomes.
- [x] GREEN: Define bounded typed error/result variants for degraded LSP responses.
- [x] RED: Add tests proving LSP tool result payloads are capped and do not dump full-project data.
- [x] GREEN: Add caps for diagnostics, symbols, hovers, locations, proposal text, and server logs.
- [x] RED: Add tests proving LSP tools are declared read-only.
- [x] GREEN: Register future LSP tool definitions with `readOnly: true`.

#### M2: Host Runtime Manager and Adapter Boundary

- [x] RED: Add host tests for workspace-root detection and per-workspace LSP manager lookup.
- [x] GREEN: Implement a host-owned runtime manager that associates language-server state with workspace roots.
- [x] RED: Add tests for TypeScript/JavaScript adapter selection in a TS workspace.
- [x] GREEN: Add a generic language-server adapter interface and first TS/JS adapter.
- [x] RED: Add tests for spawn, initialize, ready, shutdown, crash, and restart state transitions.
- [x] GREEN: Implement lifecycle state with bounded initialize and shutdown timeouts.
- [x] RED: Add tests proving missing server binaries return unavailable status rather than throwing through a turn.
- [x] GREEN: Surface missing or unavailable servers as bounded typed results.

### Gate 1 -> 2

- [x] Shared result contracts and degraded-state contracts are stable.
- [x] LSP tools are read-only in the tool registry.
- [x] The host can detect and manage a TS/JS language-server adapter.
- [x] Missing servers degrade without failing a user turn.

### Phase 2: Read-Only Tool Surface

#### M3: Status and Diagnostics Tools

- [x] RED: Add tool tests for `lsp_status` showing configured, missing, unavailable, initializing, ready, stale, error, and timeout states.
- [x] GREEN: Implement `lsp_status` over the host runtime manager.
- [x] RED: Add diagnostics tests for one file, current workspace summary, severity filtering, and capped results.
- [x] GREEN: Implement `lsp_diagnostics` as an explicit pull tool, never an ambient feed.
- [x] RED: Add tests proving diagnostics do not enter prompt context unless returned from a tool call.
- [x] GREEN: Keep diagnostics out of system prompt construction and history projection except as ordinary tool results.
- [x] REFACTOR: Share range, severity, and source formatting across LSP tools.

#### M4: Hover and Symbols Tools

- [x] RED: Add hover tests for file/position lookup, missing file, stale document state, and capped markdown/plain text.
- [x] GREEN: Implement `lsp_hover` for explicit type/signature/doc lookups.
- [x] RED: Add document symbol tests for outline nesting, symbol kinds, range mapping, and cap behavior.
- [x] GREEN: Implement `lsp_document_symbols` for one-file orientation.
- [x] RED: Add workspace symbol tests for query-driven lookup, limits, location formatting, and no full-project dump.
- [x] GREEN: Implement `lsp_workspace_symbols(query, limit)` with required query/cap semantics.
- [x] RED: Add tests proving literal text search tasks still prefer `rg`/`ast_grep` guidance instead of symbols.
- [x] REFACTOR: Keep symbol output compact and useful for model consumption.

#### M5: Code-Action Proposal Tool

- [x] RED: Add code-action tests that return proposal metadata without applying edits.
- [x] GREEN: Implement `lsp_code_actions` as read-only proposal output.
- [x] RED: Add tests proving workspace edits, rename edits, and quick-fix application are not executed.
- [x] GREEN: Strip or serialize edits as reviewable proposals only, with clear unsupported-mutating status where needed.
- [x] RED: Add tests for unsupported or unsafe action kinds.
- [x] REFACTOR: Keep proposal output concise enough for a tool result.

### Gate 2 -> 3

- [x] Every first-cut LSP tool returns bounded structured results.
- [x] Diagnostics are pull-only and prompt-visible only as explicit tool results.
- [x] Hover and symbol tools are query/file scoped.
- [x] Code actions never mutate files.
- [x] Read-only scheduling still treats LSP calls as concurrent-safe reads.

### Phase 3: Guidance, Degradation, and Evals

#### M6: Prompt Guidance and Invocation Discipline

- [x] RED: Add prompt tests proving guidance names when to use LSP: symbols, hover/type facts, targeted diagnostics, and code-action proposals.
- [x] GREEN: Add model guidance for proactive LSP use at chosen moments.
- [x] RED: Add prompt tests proving guidance names when not to use LSP: literal search, docs, config, routes, broad text search, tests, and compiler truth.
- [x] GREEN: Add guidance that keeps `rg`, `ast_grep`, file reads, tests, typecheck, and compiler output as final correctness channels.
- [x] RED: Add tests proving no guidance asks the model to wait for LSP before editing.
- [x] GREEN: Keep LSP optional and non-blocking in tool guidance.
- [x] REFACTOR: Keep tool descriptions short; do not stuff full LSP doctrine into schemas.

#### M7: Evals and Distraction Resistance

- [x] RED: Add a navigation eval where `workspaceSymbols` should beat broad grep.
- [x] GREEN: Tune guidance and tool result shape so the agent can find named definitions efficiently.
- [x] RED: Add a file-orientation eval where `documentSymbols` should reduce context use.
- [x] GREEN: Validate compact outlines improve orientation without full-file dumping.
- [x] RED: Add typed repair fixtures where `hover` or targeted diagnostics should reduce churn.
- [x] RED: Add distraction regressions for unavailable, noisy, stale, or slow LSP servers.
- [x] GREEN: Prove the agent continues through normal read/edit/test work when LSP is not useful.

### Gate 3 -> 4

- [x] Prompt guidance is additive and does not replace normal repo/source truth.
- [x] Evals show value for symbol navigation, file orientation, typed repair, and proposal tasks.
- [x] Distraction regressions pass for unavailable, noisy, stale, and slow LSP.
- [x] LSP remains optional and pull-only.
- [x] Tool schemas remain concise.

### Phase 4: Doctor, UI State, and Verification

#### M8: Doctor and Debug Surface

- [x] RED: Add Doctor snapshot tests for LSP configured, missing, unavailable, stale, error, timeout, and diagnostic-warning states.
- [x] GREEN: Wire host LSP runtime state into Doctor's LSP area.
- [x] RED: Add redaction tests proving server logs and paths are bounded and sanitized.
- [x] GREEN: Add structured logs and debug detail for spawn, initialize, request timeout, crash, restart, and stale state.
- [x] RED: Add web/Storybook tests or fixtures for Doctor LSP states.
- [x] GREEN: Render LSP Doctor states from structured snapshot data without browser-side server scanning.

#### M9: Integration and End-to-End Verification

- [x] RED: Add integration tests using a fake or fixture language server for lifecycle and request behavior.
- [x] GREEN: Drive status, diagnostics, hover, symbols, and code-action proposals through the host tool layer.
- [x] RED: Add hermetic e2e coverage for a TS/JS workspace with available and unavailable LSP states.
- [x] GREEN: Verify unavailable servers degrade while normal file/search/test tools still work.
- [x] GREEN: Run lint, typecheck, host tests, web tests, integration tests, and hermetic e2e.
- [x] GREEN: Run a manual EZE repro in this repo for hover, document symbols, workspace symbols, diagnostics, and code-action proposals.
- [x] REFACTOR: Record exact verification commands and any unsupported language-adapter follow-up in the progress report.

##### M9 verification record (2026-07-02)

Exact verification commands, all green:

```bash
pnpm lint
pnpm typecheck
pnpm test            # all projects: 3374 passed | 3 skipped (unit + integration + web + e2e)
pnpm test:unit       # 2447 passed
pnpm test:integration
pnpm test:web
pnpm vitest run --project e2e e2e/lsp-integration.test.ts   # 5 passed
bash tests/browser/check-storybook-baselines.sh             # 331/331 snapshots (after M8 regen)
```

Manual EZE against the REAL `typescript-language-server` 5.3.0 (resolved via `pnpm add -D
typescript typescript-language-server` into a scratch temp TS project, spawned through the
production adapter -> manager -> lsp_* tools; scratch driver, not committed):
`pnpm exec tsx --tsconfig apps/agent-host/tsconfig.json <scratch>/eze-lsp-real.ts`.
Observed real output: diagnostics `4:14-4:19 error [typescript 2322] ...` and
`5:21-5:30 error [typescript 2552] Cannot find name 'makeGadet' ...`; hover
`(alias) makeGadget(size: number): Gadget`; document symbols (nested outline with properties);
workspace symbols `- function makeGadget src/gadgets.ts:5:1`; code actions
`Change spelling to 'makeGadget' [quickfix] (preferred)` with the serialized preview
`src/broken.ts 5:21-5:30 -> "makeGadget"`, plus tsserver refactors rendered as
command-only/not-executed; status configured -> ready.

EZE-discovered fixes folded into M9 (RED-first, test/lsp/tools-code-actions.test.ts):
`lsp_code_actions` now forwards the file's published diagnostics overlapping the requested
lines as `CodeActionContext.diagnostics` (re-encoded 0-based wire shape, numeric codes;
`toLspDiagnostic` in tools/lsp-shared.ts) and defaults the request range to cover WHOLE lines
(`endColumn` = end of `endLine`), because tsserver derives quickfixes from the forwarded
diagnostics and only returns fixes whose error span intersects the request range - with the
old empty context + zero-width range the real server returned no quickfix at all.

Unsupported-adapter follow-up: TS/JS remains the only adapter (D-004); non-TS workspaces fold
to the doctor "unconfigured" state and every lsp_* tool degrades to the bounded
no-adapter-matched text (pinned in test/lsp + e2e). A second language family needs only a new
`LanguageServerAdapter` (detects/resolveCommand/initializeOptions); context-diagnostics
forwarding is the LSP-spec client behavior, so it should carry over unchanged. Real-tsserver
note: TS2322 on a variable initializer legitimately has no quickfix (same in VS Code) - not a
defect.

### Done Gate

- [x] LSP tools are read-only, bounded, and explicit.
- [x] No ambient LSP data enters prompts or gates edits.
- [x] TS/JS LSP works through the host-owned adapter boundary.
- [x] Doctor reports actionable LSP status.
- [x] Evals and full verification pass.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.
