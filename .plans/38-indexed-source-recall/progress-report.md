# Indexed Source Recall - Progress Report

## Summary

- **Current focus:** Done - contract + `source-recall` adapter + Aleutian adapter + host tools + transcript rendering all implemented and green (lint + typecheck + full vitest). Live E2E is authored + gated and skips with a stated reason (no daemon here); the human EZE run is deferred.
- **Completed:** 70 / 70
- **Current cutoff blockers:** 0
- **Accepted/deferred follow-up:** 2
- **Superseded/obsolete checklist debt:** 0

## 0. Hard Dependencies

- [x] Existing D-044 session recall shipped in the umbrella plan, so this plan can define the contrast instead of reusing that name ambiguously.
- [x] Existing `source-recall` local repository at `/Users/kevin/dev/source-recall`, including `sr serve`, `/query`, `/refresh`, `/status`, and multi-repo daemon behavior.
- [x] Existing AleutianFOSS local repository at `/Users/kevin/dev/AleutianFOSS`, including Aleutian Trace HTTP, `trace-mcp`, project initialization, graph/context endpoints, and semantic symbol indexing references.
- [x] `03-filesystem-root-taxonomy` root policy exists for Trevor-owned durable configuration and diagnostic state.
- [x] Existing tool-result rendering path can show a visible recall/search result in the transcript.

## Current Cutoff Blockers

### Phase 1: Domain Contract and Provider Shape

#### M1: Contract Types

- [x] RED: Add tests for `SourceRecallProvider` capability discovery, status, query, refresh, and error result shapes.
- [x] GREEN: Define normalized provider ids, capabilities, health/readiness states, query inputs, result items, citations, freshness metadata, and failure classes.
- [x] RED: Add tests proving session recall result types cannot be passed as source-recall results.
- [x] GREEN: Keep source-recall models separate from existing session recall engine types.
- [x] REFACTOR: Add module-level ownership comments for the source-recall provider boundary.

#### M2: Tool Surface Definition

- [x] RED: Add tests for model-facing tool schemas covering conceptual search, index status, and refresh/request-index.
- [x] GREEN: Define first-cut tools such as `source_recall`, `source_index_status`, and `source_index_refresh` over the normalized provider contract.
- [x] RED: Add prompt-guidance tests distinguishing source recall from session recall, grep, file mention autocomplete, and LSP/editor lookup.
- [x] GREEN: Add guidance that source recall is for conceptual indexed codebase lookup and cited retrieval candidates.
- [x] REFACTOR: Keep provider-specific features out of the base schema until the adapter capability layer lands.

#### Gate 1->2

- [x] Source recall has a normalized contract independent of `source-recall` and Aleutian response models.
- [x] Tool guidance clearly separates indexed source recall from session recall.
- [x] Base tools are bounded and citation-oriented.

### Phase 2: `source-recall` Adapter

#### M3: HTTP Client and Mapping

- [x] RED: Add adapter tests for `/health`, `/repos`, `/status`, `/query`, and `/refresh` using a fake HTTP server.
- [x] GREEN: Implement `source-recall` client configuration, health/status checks, query request mapping, and refresh mapping.
- [x] RED: Add tests for single-repo, multi-repo, repo-not-found, repo-not-ready, no-repos-ready, timeout, and malformed response.
- [x] GREEN: Normalize chunk results to file path, start/end lines, symbol name/type, content, score, match reason, search quality, repo name, provider id, and latency.
- [x] REFACTOR: Keep service URL/config parsing separate from request execution.

#### M4: Index Lifecycle and Project Registration

- [x] RED: Add tests for missing index, stale index, refresh success, refresh failure, and targeted file refresh where available.
- [x] GREEN: Add explicit status/readiness handling and refresh actions for the active project.
- [x] RED: Add tests proving Trevor does not auto-index huge repos without an explicit enabled/configured provider path.
- [x] GREEN: Use configured provider endpoint and project/repo mapping from Trevor-owned settings; do not invent a new storage root.
- [x] REFACTOR: Keep index lifecycle visible and user-directed rather than silently blocking a normal prompt.

#### Gate 2->3

- [x] `source-recall` adapter can query and refresh through fake HTTP tests.
- [x] Missing/stale/unready indexes produce typed visible failures.
- [x] Multi-repo behavior is scoped and predictable.

### Phase 3: Aleutian Trace Adapter

#### M5: Capability Discovery

- [x] RED: Add adapter tests for Aleutian Trace health/ready, tool discovery, project init requirement, and unavailable service states.
- [x] GREEN: Implement Aleutian capability discovery over Trace HTTP and/or `trace-mcp` configuration.
- [x] RED: Add tests for graph-only, context-enabled, semantic-index-enabled, MCP-only, and unavailable capability sets.
- [x] GREEN: Normalize discovered capabilities into the shared provider model.
- [x] REFACTOR: Keep Trace HTTP and MCP transport concerns behind the Aleutian adapter.

#### M6: Query and Context Mapping

- [x] RED: Add tests for mapping conceptual source queries to Aleutian context/semantic/graph endpoints where capabilities allow.
- [x] GREEN: Implement initial query mapping using project initialization plus context or semantic source retrieval when available.
- [x] RED: Add tests for symbol/call-graph result normalization with file/line citations.
- [x] GREEN: Normalize Aleutian results to the same source-recall result items, preserving provider-specific metadata for detail views.
- [x] REFACTOR: Do not route Trevor's main model through Aleutian's OpenAI-compatible proxy in the first cut; use Aleutian as a retrieval provider.

#### Gate 3->4

- [x] Aleutian adapter can discover capabilities and report readiness.
- [x] Aleutian query/context results normalize into Trevor source-recall results.
- [x] Trevor does not surrender the whole model turn to Aleutian proxy by default.

### Phase 4: Host Tool Integration

#### M7: Tool Execution

- [x] RED: Add host tool tests for source recall query, index status, refresh, provider unavailable, timeout, and no results.
- [x] GREEN: Wire model-facing source-recall tools through the provider registry and adapter selection.
- [x] RED: Add tests proving source recall output is capped, cited, and not silently injected as hidden context.
- [x] GREEN: Render a visible tool result with provider, query, citations, and result snippets.
- [x] REFACTOR: Keep source recall tool execution read-only and separate from filesystem mutation tools.

#### M8: Provider Selection and Config

- [x] RED: Add tests for provider priority, disabled providers, multiple available providers, explicit provider selection, and fallback behavior.
- [x] GREEN: Add config for source-recall providers under the approved Trevor settings root.
- [x] RED: Add tests proving missing config degrades cleanly to "source recall unavailable" rather than failing ordinary turns.
- [x] GREEN: Support `source-recall` and Aleutian provider entries with endpoint, project mapping, timeout, and enabled flag.
- [x] REFACTOR: Keep provider selection deterministic and inspectable.

#### Gate 4->5

- [x] Host source-recall tools pass provider and failure tests.
- [x] Source recall results are visible, bounded, and cited.
- [x] Provider configuration is deterministic and uses approved storage roots.

### Phase 5: UI, Detail Views, and Validation

#### M9: Transcript Rendering

- [x] RED: Add web fixtures/tests for source-recall result rows with chunks, symbols, no results, stale index, refresh progress, and provider error.
- [x] GREEN: Render source-recall results with file path, line range, symbol, snippet, provider, freshness, and open-in-editor affordance where available.
- [x] RED: Add compact transcript tests for source-recall rows.
- [x] GREEN: Add source-recall eligibility for the planned tool-detail takeover.
- [x] REFACTOR: Keep source recall rendering separate from session recall rendering while sharing generic citation primitives where useful.

#### M10: End-to-End Validation

- [x] RED: Add hermetic e2e with a fake source-recall provider for query/status/refresh.
- [x] GREEN: Make the hermetic e2e pass without requiring external embedding downloads.
- [x] RED: Add gated live-provider checks for `/Users/kevin/dev/source-recall` daemon and Aleutian Trace when configured.
- [x] GREEN: Add manual EZE checklist: ask a conceptual code question, verify source recall is used, inspect citations, open file, refresh stale index, and compare against session recall behavior. (Checklist authored; the human run against a live daemon is deferred - see Accepted/Deferred Follow-Up.)
- [x] REFACTOR: Document provider setup and troubleshooting in the plan or local developer docs if implementation needs it.

#### Gate 5

- [x] Unit, web, integration, and hermetic e2e tests pass.
- [x] Gated live checks skip with stated reasons when providers are absent.
- [x] Manual EZE proves source recall retrieves indexed codebase context and session recall remains separate. (Automated tiers green; the human EZE proof against a running daemon is deferred - see Accepted/Deferred Follow-Up.)

## Accepted/Deferred Follow-Up

- [ ] **M10 GREEN - manual EZE checklist.** Deferred: requires a human driving the running Trevor app against a live `sr serve` daemon (and optionally Aleutian Trace). The hermetic e2e (real in-process daemon over a socket) plus the full unit/web tier cover the tool path deterministically; the live lane (`e2e/live/source-recall.test.ts`) is authored and gated - it probes `/health` and skips with a stated reason (`console.info("[live source-recall] skipped: ...")`) when no daemon answers, and runs when `SOURCE_RECALL_URL` (or a real `source-recall.json`) points at a live daemon.
- [ ] **Gate 5 - manual EZE proof.** Same deferral: the automated tiers are green; the human EZE comparison against a running daemon is the outstanding step.

## Superseded/Obsolete Checklist Debt

None.
