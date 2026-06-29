# LSP Integration - Implementation Plan

## 0. Hard Dependencies

None.

## Architecture

LSP integration is a host-owned read-only tool surface. The host owns language-server discovery, lifecycle, workspace association, request timeouts, result caps, and Doctor status; the web UI only renders structured host-provided read models and diagnostics. <!-- D-001 -->

The first cut is intentionally pull-based. The model receives no ambient diagnostics, no automatic prompt injection, and no pre-edit gate. LSP facts enter the model context only when the agent explicitly calls an LSP tool and receives a bounded tool result. <!-- D-003 -->

The first supported project family is TypeScript/JavaScript, behind a language-server adapter boundary that can support later adapters without changing the public tool contract. <!-- D-004 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Host-owned lifecycle | LSP processes and workspace state live in `apps/agent-host`, not the browser. <!-- D-001 --> |
| Read-only first cut | Tools cover status, diagnostics, hover, document symbols, workspace symbols, and code-action proposals only. <!-- D-002 --> |
| No ambient feed | Diagnostics are not injected automatically and do not block edits or tool use. <!-- D-003 --> |
| TypeScript/JavaScript first | Use a generic adapter boundary, with TS/JS as the first implementation target. <!-- D-004 --> |
| Code actions are proposals | Applying workspace edits, rename edits, and mutating actions are deferred. <!-- D-005 --> |
| Graceful degradation | Missing, slow, stale, unsupported, or noisy servers return bounded typed errors instead of blocking work. <!-- D-006 --> |
| Read-only scheduler classification | LSP tools are registered as read-only so they can run concurrently with other read-only tools. <!-- D-007 --> |
| Doctor integration | Doctor reports LSP health and findings without performing repairs. <!-- D-008 --> |

### Boundaries

Owned by this plan:

- LSP runtime manager in the host
- language-server adapter interface and TS/JS adapter
- read-only LSP model-facing tools
- bounded result schemas and typed errors
- prompt guidance for when to use or avoid LSP
- Doctor LSP status and diagnostics
- tests, fixtures, and evals for usefulness and distraction resistance

Not owned by this plan:

- applying workspace edits
- rename edits
- mutating code actions
- ambient diagnostic streaming
- automatic prompt injection
- LSP as the default search engine
- browser-owned filesystem or server lifecycle

### Observability

The LSP runtime must be debuggable without making ordinary turns noisy:

- inspectable host state for configured server, workspace root, status, last request, last error, and stale age
- structured logs for spawn, initialize, request timeout, server exit, and restart
- typed tool results for unavailable, unsupported, timeout, stale, and error cases
- Doctor area reporting configured/missing/unavailable/stale/error/timeout/diagnostic-warning states <!-- D-008 -->

## Phases

### Phase 1: Contract and Runtime Foundation

**Goal:** Trevor has a host-owned LSP runtime contract and TypeScript-first adapter boundary with no model-visible behavior change yet.

**Gate from previous:** none.

#### M1: Protocol and Tool Contract

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add protocol/tool contract tests for LSP status, diagnostics, hover, document symbols, workspace symbols, and code-action proposal result shapes.
  2. GREEN: Define shared result schemas with stable status, range, location, severity, symbol, and proposal types.
  3. RED: Add tests for typed unavailable, unsupported, timeout, stale, and server-error outcomes.
  4. GREEN: Define bounded typed error/result variants for degraded LSP responses. <!-- D-006 -->
  5. RED: Add tests proving LSP tool result payloads are capped and do not dump full-project data.
  6. GREEN: Add caps for diagnostics, symbols, hovers, locations, proposal text, and server logs.
  7. RED: Add tests proving LSP tools are declared read-only.
  8. GREEN: Register future LSP tool definitions with `readOnly: true`. <!-- D-007 -->

#### M2: Host Runtime Manager and Adapter Boundary

- **Dependencies:** M1
- **Effort:** L
- **Tasks:**
  1. RED: Add host tests for workspace-root detection and per-workspace LSP manager lookup.
  2. GREEN: Implement a host-owned runtime manager that associates language-server state with workspace roots. <!-- D-001 -->
  3. RED: Add tests for TypeScript/JavaScript adapter selection in a TS workspace.
  4. GREEN: Add a generic language-server adapter interface and first TS/JS adapter. <!-- D-004 -->
  5. RED: Add tests for spawn, initialize, ready, shutdown, crash, and restart state transitions.
  6. GREEN: Implement lifecycle state with bounded initialize and shutdown timeouts.
  7. RED: Add tests proving missing server binaries return unavailable status rather than throwing through a turn.
  8. GREEN: Surface missing or unavailable servers as bounded typed results. <!-- D-006 -->

### Gate 1 -> 2

- [ ] Shared result contracts and degraded-state contracts are stable.
- [ ] LSP tools are read-only in the tool registry.
- [ ] The host can detect and manage a TS/JS language-server adapter.
- [ ] Missing servers degrade without failing a user turn.

### Phase 2: Read-Only Tool Surface

**Goal:** The model can explicitly ask for bounded LSP facts when that is the right tool for the task.

**Gate from previous:** Gate 1 passes.

#### M3: Status and Diagnostics Tools

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add tool tests for `lsp_status` showing configured, missing, unavailable, initializing, ready, stale, error, and timeout states.
  2. GREEN: Implement `lsp_status` over the host runtime manager. <!-- D-002 -->
  3. RED: Add diagnostics tests for one file, current workspace summary, severity filtering, and capped results.
  4. GREEN: Implement `lsp_diagnostics` as an explicit pull tool, never an ambient feed. <!-- D-003 -->
  5. RED: Add tests proving diagnostics do not enter prompt context unless returned from a tool call.
  6. GREEN: Keep diagnostics out of system prompt construction and history projection except as ordinary tool results.
  7. REFACTOR: Share range, severity, and source formatting across LSP tools.

#### M4: Hover and Symbols Tools

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Add hover tests for file/position lookup, missing file, stale document state, and capped markdown/plain text.
  2. GREEN: Implement `lsp_hover` for explicit type/signature/doc lookups. <!-- D-002 -->
  3. RED: Add document symbol tests for outline nesting, symbol kinds, range mapping, and cap behavior.
  4. GREEN: Implement `lsp_document_symbols` for one-file orientation.
  5. RED: Add workspace symbol tests for query-driven lookup, limits, location formatting, and no full-project dump.
  6. GREEN: Implement `lsp_workspace_symbols(query, limit)` with required query/cap semantics.
  7. RED: Add tests proving literal text search tasks still prefer `rg`/`ast_grep` guidance instead of symbols.
  8. REFACTOR: Keep symbol output compact and useful for model consumption.

#### M5: Code-Action Proposal Tool

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add code-action tests that return proposal metadata without applying edits.
  2. GREEN: Implement `lsp_code_actions` as read-only proposal output. <!-- D-005 -->
  3. RED: Add tests proving workspace edits, rename edits, and quick-fix application are not executed.
  4. GREEN: Strip or serialize edits as reviewable proposals only, with clear unsupported-mutating status where needed.
  5. RED: Add tests for unsupported or unsafe action kinds.
  6. REFACTOR: Keep proposal output concise enough for a tool result.

### Gate 2 -> 3

- [ ] Every first-cut LSP tool returns bounded structured results.
- [ ] Diagnostics are pull-only and prompt-visible only as explicit tool results.
- [ ] Hover and symbol tools are query/file scoped.
- [ ] Code actions never mutate files.
- [ ] Read-only scheduling still treats LSP calls as concurrent-safe reads.

### Phase 3: Guidance, Degradation, and Evals

**Goal:** The model uses LSP selectively when it helps and keeps normal source/test workflows as the truth source.

**Gate from previous:** Gate 2 passes.

#### M6: Prompt Guidance and Invocation Discipline

- **Dependencies:** M5
- **Effort:** S
- **Tasks:**
  1. RED: Add prompt tests proving guidance names when to use LSP: symbols, hover/type facts, targeted diagnostics, and code-action proposals.
  2. GREEN: Add model guidance for proactive LSP use at chosen moments. <!-- D-002 -->
  3. RED: Add prompt tests proving guidance names when not to use LSP: literal search, docs, config, routes, broad text search, tests, and compiler truth.
  4. GREEN: Add guidance that keeps `rg`, `ast_grep`, file reads, tests, typecheck, and compiler output as final correctness channels. <!-- D-006 -->
  5. RED: Add tests proving no guidance asks the model to wait for LSP before editing.
  6. GREEN: Keep LSP optional and non-blocking in tool guidance. <!-- D-003 -->
  7. REFACTOR: Keep tool descriptions short; do not stuff full LSP doctrine into schemas.

#### M7: Evals and Distraction Resistance

- **Dependencies:** M6
- **Effort:** M
- **Tasks:**
  1. RED: Add a navigation eval where `workspaceSymbols` should beat broad grep.
  2. GREEN: Tune guidance and tool result shape so the agent can find named definitions efficiently.
  3. RED: Add a file-orientation eval where `documentSymbols` should reduce context use.
  4. GREEN: Validate compact outlines improve orientation without full-file dumping.
  5. RED: Add typed repair fixtures where `hover` or targeted diagnostics should reduce churn.
  6. RED: Add distraction regressions for unavailable, noisy, stale, or slow LSP servers.
  7. GREEN: Prove the agent continues through normal read/edit/test work when LSP is not useful. <!-- D-009 -->

### Gate 3 -> 4

- [ ] Prompt guidance is additive and does not replace normal repo/source truth.
- [ ] Evals show value for symbol navigation, file orientation, typed repair, and proposal tasks.
- [ ] Distraction regressions pass for unavailable, noisy, stale, and slow LSP.
- [ ] LSP remains optional and pull-only.
- [ ] Tool schemas remain concise.

### Phase 4: Doctor, UI State, and Verification

**Goal:** LSP is observable through Doctor and verified through host, web, and e2e coverage.

**Gate from previous:** Gate 3 passes.

#### M8: Doctor and Debug Surface

- **Dependencies:** M7
- **Effort:** M
- **Tasks:**
  1. RED: Add Doctor snapshot tests for LSP configured, missing, unavailable, stale, error, timeout, and diagnostic-warning states.
  2. GREEN: Wire host LSP runtime state into Doctor's LSP area. <!-- D-008 -->
  3. RED: Add redaction tests proving server logs and paths are bounded and sanitized.
  4. GREEN: Add structured logs and debug detail for spawn, initialize, request timeout, crash, restart, and stale state.
  5. RED: Add web/Storybook tests or fixtures for Doctor LSP states.
  6. GREEN: Render LSP Doctor states from structured snapshot data without browser-side server scanning.

#### M9: Integration and End-to-End Verification

- **Dependencies:** M8
- **Effort:** L
- **Tasks:**
  1. RED: Add integration tests using a fake or fixture language server for lifecycle and request behavior.
  2. GREEN: Drive status, diagnostics, hover, symbols, and code-action proposals through the host tool layer.
  3. RED: Add hermetic e2e coverage for a TS/JS workspace with available and unavailable LSP states.
  4. GREEN: Verify unavailable servers degrade while normal file/search/test tools still work. <!-- D-006 -->
  5. GREEN: Run lint, typecheck, host tests, web tests, integration tests, and hermetic e2e. <!-- D-009 -->
  6. GREEN: Run a manual EZE repro in this repo for hover, document symbols, workspace symbols, diagnostics, and code-action proposals.
  7. REFACTOR: Record exact verification commands and any unsupported language-adapter follow-up in the progress report.

### Done Gate

- [ ] LSP tools are read-only, bounded, and explicit.
- [ ] No ambient LSP data enters prompts or gates edits.
- [ ] TS/JS LSP works through the host-owned adapter boundary.
- [ ] Doctor reports actionable LSP status.
- [ ] Evals and full verification pass.

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Ambient diagnostics distract the model | high | medium | Keep diagnostics pull-only and test prompt construction for no ambient injection. <!-- D-003 --> | implementer |
| Language server lifecycle becomes flaky | medium | medium | Use bounded initialize/request/shutdown timeouts and typed unavailable states. <!-- D-006 --> | implementer |
| LSP result payloads bloat context | medium | medium | Cap diagnostics, symbols, hover content, locations, proposals, and logs. | implementer |
| Code actions accidentally mutate files | high | low | Return proposals only and test that edits are never applied. <!-- D-005 --> | implementer |
| TS-specific code leaks into public contract | medium | medium | Keep the adapter boundary generic and TS/JS as the first adapter. <!-- D-004 --> | implementer |
| LSP replaces source/test truth | high | medium | Add guidance and evals proving LSP stays auxiliary to repo files, tests, typecheck, and compiler output. <!-- D-009 --> | implementer |

## Escape Hatches

1. **If a real language server is too flaky for hermetic tests:** use a fixture server for integration tests and gate real-server tests behind explicit availability checks.
2. **If `typescript-language-server` is not the right first adapter:** keep the adapter contract and swap the TS/JS implementation to a better server without changing model-facing tool schemas.
3. **If code-action proposals are too large:** return only titles/kinds/ranges by default and add an explicit detail path later.
4. **If mutating LSP actions become necessary:** create a separate mutating-LSP plan with explicit tool semantics and user-visible edit events. <!-- D-005 -->

## Progress Report Accounting

The progress report is the implementation resume state. It must distinguish current cutoff blockers from deferred follow-up and superseded checklist debt.

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "24-lsp-integration"
```

## Validation Commands

```bash
pnpm lint
pnpm typecheck
pnpm test -- --project unit
pnpm test -- --project integration
pnpm test -- --project web
pnpm test -- --project e2e
```

## Decisions

Canonical decisions are in `.plans/24-lsp-integration/plan.db`. Query them with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "24-lsp-integration"
```
