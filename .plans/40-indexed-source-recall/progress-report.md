# Indexed Source Recall - Progress Report

## Summary

- **Current focus:** M1 - Contract Types
- **Completed:** 5 / 70
- **Current cutoff blockers:** 65
- **Accepted/deferred follow-up:** 0
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

- [ ] RED: Add tests for `SourceRecallProvider` capability discovery, status, query, refresh, and error result shapes.
- [ ] GREEN: Define normalized provider ids, capabilities, health/readiness states, query inputs, result items, citations, freshness metadata, and failure classes.
- [ ] RED: Add tests proving session recall result types cannot be passed as source-recall results.
- [ ] GREEN: Keep source-recall models separate from existing session recall engine types.
- [ ] REFACTOR: Add module-level ownership comments for the source-recall provider boundary.

#### M2: Tool Surface Definition

- [ ] RED: Add tests for model-facing tool schemas covering conceptual search, index status, and refresh/request-index.
- [ ] GREEN: Define first-cut tools such as `source_recall`, `source_index_status`, and `source_index_refresh` over the normalized provider contract.
- [ ] RED: Add prompt-guidance tests distinguishing source recall from session recall, grep, file mention autocomplete, and LSP/editor lookup.
- [ ] GREEN: Add guidance that source recall is for conceptual indexed codebase lookup and cited retrieval candidates.
- [ ] REFACTOR: Keep provider-specific features out of the base schema until the adapter capability layer lands.

#### Gate 1->2

- [ ] Source recall has a normalized contract independent of `source-recall` and Aleutian response models.
- [ ] Tool guidance clearly separates indexed source recall from session recall.
- [ ] Base tools are bounded and citation-oriented.

### Phase 2: `source-recall` Adapter

#### M3: HTTP Client and Mapping

- [ ] RED: Add adapter tests for `/health`, `/repos`, `/status`, `/query`, and `/refresh` using a fake HTTP server.
- [ ] GREEN: Implement `source-recall` client configuration, health/status checks, query request mapping, and refresh mapping.
- [ ] RED: Add tests for single-repo, multi-repo, repo-not-found, repo-not-ready, no-repos-ready, timeout, and malformed response.
- [ ] GREEN: Normalize chunk results to file path, start/end lines, symbol name/type, content, score, match reason, search quality, repo name, provider id, and latency.
- [ ] REFACTOR: Keep service URL/config parsing separate from request execution.

#### M4: Index Lifecycle and Project Registration

- [ ] RED: Add tests for missing index, stale index, refresh success, refresh failure, and targeted file refresh where available.
- [ ] GREEN: Add explicit status/readiness handling and refresh actions for the active project.
- [ ] RED: Add tests proving Trevor does not auto-index huge repos without an explicit enabled/configured provider path.
- [ ] GREEN: Use configured provider endpoint and project/repo mapping from Trevor-owned settings; do not invent a new storage root.
- [ ] REFACTOR: Keep index lifecycle visible and user-directed rather than silently blocking a normal prompt.

#### Gate 2->3

- [ ] `source-recall` adapter can query and refresh through fake HTTP tests.
- [ ] Missing/stale/unready indexes produce typed visible failures.
- [ ] Multi-repo behavior is scoped and predictable.

### Phase 3: Aleutian Trace Adapter

#### M5: Capability Discovery

- [ ] RED: Add adapter tests for Aleutian Trace health/ready, tool discovery, project init requirement, and unavailable service states.
- [ ] GREEN: Implement Aleutian capability discovery over Trace HTTP and/or `trace-mcp` configuration.
- [ ] RED: Add tests for graph-only, context-enabled, semantic-index-enabled, MCP-only, and unavailable capability sets.
- [ ] GREEN: Normalize discovered capabilities into the shared provider model.
- [ ] REFACTOR: Keep Trace HTTP and MCP transport concerns behind the Aleutian adapter.

#### M6: Query and Context Mapping

- [ ] RED: Add tests for mapping conceptual source queries to Aleutian context/semantic/graph endpoints where capabilities allow.
- [ ] GREEN: Implement initial query mapping using project initialization plus context or semantic source retrieval when available.
- [ ] RED: Add tests for symbol/call-graph result normalization with file/line citations.
- [ ] GREEN: Normalize Aleutian results to the same source-recall result items, preserving provider-specific metadata for detail views.
- [ ] REFACTOR: Do not route Trevor's main model through Aleutian's OpenAI-compatible proxy in the first cut; use Aleutian as a retrieval provider.

#### Gate 3->4

- [ ] Aleutian adapter can discover capabilities and report readiness.
- [ ] Aleutian query/context results normalize into Trevor source-recall results.
- [ ] Trevor does not surrender the whole model turn to Aleutian proxy by default.

### Phase 4: Host Tool Integration

#### M7: Tool Execution

- [ ] RED: Add host tool tests for source recall query, index status, refresh, provider unavailable, timeout, and no results.
- [ ] GREEN: Wire model-facing source-recall tools through the provider registry and adapter selection.
- [ ] RED: Add tests proving source recall output is capped, cited, and not silently injected as hidden context.
- [ ] GREEN: Render a visible tool result with provider, query, citations, and result snippets.
- [ ] REFACTOR: Keep source recall tool execution read-only and separate from filesystem mutation tools.

#### M8: Provider Selection and Config

- [ ] RED: Add tests for provider priority, disabled providers, multiple available providers, explicit provider selection, and fallback behavior.
- [ ] GREEN: Add config for source-recall providers under the approved Trevor settings root.
- [ ] RED: Add tests proving missing config degrades cleanly to "source recall unavailable" rather than failing ordinary turns.
- [ ] GREEN: Support `source-recall` and Aleutian provider entries with endpoint, project mapping, timeout, and enabled flag.
- [ ] REFACTOR: Keep provider selection deterministic and inspectable.

#### Gate 4->5

- [ ] Host source-recall tools pass provider and failure tests.
- [ ] Source recall results are visible, bounded, and cited.
- [ ] Provider configuration is deterministic and uses approved storage roots.

### Phase 5: UI, Detail Views, and Validation

#### M9: Transcript Rendering

- [ ] RED: Add web fixtures/tests for source-recall result rows with chunks, symbols, no results, stale index, refresh progress, and provider error.
- [ ] GREEN: Render source-recall results with file path, line range, symbol, snippet, provider, freshness, and open-in-editor affordance where available.
- [ ] RED: Add compact transcript tests for source-recall rows.
- [ ] GREEN: Add source-recall eligibility for the planned tool-detail takeover.
- [ ] REFACTOR: Keep source recall rendering separate from session recall rendering while sharing generic citation primitives where useful.

#### M10: End-to-End Validation

- [ ] RED: Add hermetic e2e with a fake source-recall provider for query/status/refresh.
- [ ] GREEN: Make the hermetic e2e pass without requiring external embedding downloads.
- [ ] RED: Add gated live-provider checks for `/Users/kevin/dev/source-recall` daemon and Aleutian Trace when configured.
- [ ] GREEN: Add manual EZE checklist: ask a conceptual code question, verify source recall is used, inspect citations, open file, refresh stale index, and compare against session recall behavior.
- [ ] REFACTOR: Document provider setup and troubleshooting in the plan or local developer docs if implementation needs it.

#### Gate 5

- [ ] Unit, web, integration, and hermetic e2e tests pass.
- [ ] Gated live checks skip with stated reasons when providers are absent.
- [ ] Manual EZE proves source recall retrieves indexed codebase context and session recall remains separate.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.

