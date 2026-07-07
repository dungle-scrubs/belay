# Compact MCP Tool Summaries - Implementation Plan

Fix the compact transcript row for the existing `mcp` gateway tool so it shows what the call did instead
of rendering only `mcp`.

## 0. Hard Dependencies

None. This is a focused web display fix on top of the already-shipped MCP gateway tool and compact
transcript system. <!-- D-003 -->

## 1. Architecture

Compact transcript rows already reduce every tool message through one presentation contract:
`compactDisplayFor(message)` sets the primary label to `message.name` and the secondary label to
`compactToolSummary(message.name, message.args)`.

The current gap is that `compactToolSummary()` delegates to `salientToolArg()`, whose generic fallback is
`args.path`. The model-facing `mcp` tool is a gateway with arguments shaped as `action`, `query`, `name`,
`server`, `uri`, and `args`; it has no `path`. So the compact row has no secondary text and appears as
only `mcp`.

The fix is to teach the shared tool-argument summary owner how to summarize the gateway `mcp` tool. It
must not add a bespoke compact-row renderer, because compact rows, full tool headers, action labels, and
detail takeovers should continue to share one salient-argument vocabulary. <!-- D-004 -->

### Label Shape

The `mcp` gateway summary is action-first and compact:

| Action | Summary |
|--------|---------|
| `search` | `search: <query>` |
| `call` | `call: <qualified name>` |
| `resources` with `server` + `uri` | `resources: <server> <uri>` |
| `resources` with only `server` | `resources: <server>` |
| `resources` with neither | `resources` |
| `prompt` with `name` | `prompt: <qualified name>` |
| `prompt` with only `server` | `prompt: <server>` |
| `prompt` with neither | `prompt` |
| `status` | `status` |

Malformed or incomplete `mcp` args should degrade to a short safe label, not throw and not expose raw JSON.
Unknown tools with no recognized salient field must keep returning `null`; this plan does not loosen that
safety behavior. <!-- D-001 --> <!-- D-002 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| MCP host behavior stays unchanged | No changes to `apps/agent-host/src/tools/mcp.ts` execution or schema. |
| One summary owner | Extend `apps/web/src/tool-args.ts`; avoid duplicate compact-only logic. |
| No raw JSON fallback | Preserve the existing safety rule for unknown or malformed tool args. |
| One-line compact row | Labels must stay short and truncatable by the existing compact display path. |

### Boundaries

- `apps/web/src/tool-args.ts` owns MCP gateway salient-label derivation.
- `apps/web/src/components/chat/compact-display.ts` should keep using `salientToolArg()` and
  `compactToolSummary()` without special-casing `mcp`.
- `apps/web/src/components/chat/compact-tool-summary.test.tsx` covers compact row labels for each MCP
  action shape.
- Host MCP runtime, tool execution, and result rendering are out of scope. <!-- D-003 -->

### Observability

No runtime observability is required. The work changes a pure web projection from already-projected
transcript messages. Verification is unit-level and UI projection-level.

## 2. Current State

- `compactDisplayFor()` sets a tool row's secondary summary from `compactToolSummary()`.
- `compactToolSummary()` parses JSON args and delegates to `salientToolArg()`.
- `salientToolArg()` has explicit branches for built-in tools such as `bash`, `grep`, `docs`, and
  `multi_edit`; otherwise it returns `args.path`.
- `compact-tool-summary.test.tsx` already asserts an MCP-shaped dynamic tool name with a `path`, but it
  does not cover the actual gateway tool named `mcp`.
- The host `mcp` gateway schema uses `action`, `query`, `name`, `server`, `uri`, and `args`.

## 3. Phases

### Phase 1: Shared MCP Summary Projection

**Goal:** The existing compact transcript row for `mcp` displays a meaningful action summary for every
gateway action while preserving unknown-tool safety.

**Gate from previous:** none.

#### M1: Characterize the Current Gap

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add failing compact-summary tests showing gateway `mcp` calls currently lack summaries for
     `search`, `call`, `resources`, `prompt`, and `status`.
  2. GREEN: Confirm the failures are from missing `mcp` salient-argument handling, not compact row layout.
  3. RED: Add malformed and incomplete `mcp` arg cases that must not throw and must not render raw JSON.
  4. GREEN: Keep the current unknown-tool fallback test passing: no recognized salient field still returns
     `null`.
  5. REFACTOR: Group MCP fixture helpers in the compact-summary test so expected labels read as a table.

#### M2: Add Gateway-Aware Salient Labels

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Add direct `tool-args` coverage for the `mcp` gateway label helper or `salientToolArg("mcp", ...)`
     if that is the chosen public seam.
  2. GREEN: Implement `mcp` action label derivation in `apps/web/src/tool-args.ts` using only the safe,
     known schema fields.
  3. RED: Add tests for priority and fallback within `resources` and `prompt` labels (`name` before
     `server`, `server` before bare action where applicable).
  4. GREEN: Route `compactToolSummary("mcp", args)` through the shared salient path and existing truncation.
  5. REFACTOR: Keep string formatting small, pure, and isolated enough to reuse from future non-compact
     tool labels without importing React/UI code.

#### M3: Verify Compact Transcript Behavior

- **Dependencies:** M2
- **Effort:** S
- **Tasks:**
  1. RED: Add or extend a compact transcript/row test showing a rendered `mcp` row includes both `mcp` and
     the action summary.
  2. GREEN: Wire any missing projection path so the row displays the new secondary text without layout
     changes.
  3. RED: Add a regression for malformed `mcp` args rendering a safe fallback row.
  4. GREEN: Ensure malformed args still produce an inspectable tool row and never crash compact rendering.
  5. REFACTOR: Remove duplicate test setup and keep MCP cases alongside existing per-tool compact summary
     coverage.

### Gate 1->done

- [ ] Gateway `mcp` compact rows show action-specific secondary text.
- [ ] Unknown tools without recognized salient args still render no noisy raw JSON.
- [ ] Malformed or incomplete `mcp` args do not throw.
- [ ] Focused web tests pass for `tool-args`, compact summary, and compact row/projection behavior.

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Summary labels leak nested MCP `args` content | medium | low | Only use `action`, `query`, `name`, `server`, and `uri`; never stringify raw `args`. | web |
| Label logic forks between compact and full rows | medium | medium | Put the behavior in `tool-args.ts` and keep compact-display generic. | web |
| Incomplete streaming args show confusing text | low | medium | Use action-only fallbacks such as `resources`, `prompt`, or `mcp`; tests pin partial shapes. | web |

## Escape Hatches

1. **If full tool headers need different wording later:** add a second formatter that composes from the
   same parsed `mcp` summary model rather than moving logic into React components.
2. **If future MCP actions are added:** unknown `action` values degrade to the safest available field or
   `mcp`, with no raw JSON fallback.

## Progress Report Accounting

The progress report is the implementation resume state. Current cutoff work is all milestone tasks plus
the done gate. There is no accepted/deferred follow-up and no superseded checklist debt.

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "60-compact-mcp-tool-summaries"
```

## Validation Commands

```bash
pnpm --filter web test -- compact-tool-summary tool-args compact-row
pnpm test -- --project web --runInBand
pnpm typecheck
```

## Decisions

Canonical decisions are in `.plans/60-compact-mcp-tool-summaries/plan.db`.

- `D-001` - MCP gateway labels are action-first (`search: ...`, `call: ...`, `resources: ...`,
  `prompt: ...`, `status`).
- `D-002` - Unknown tools with no recognized salient argument keep returning no raw summary.
- `D-003` - Scope is limited to the compact/display summary gap; host MCP execution is unchanged.
- `D-004` - Summary ownership stays in the shared tool argument summary path.
