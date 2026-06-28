# Indexed Source Recall - Implementation Plan

## 0. Hard Dependencies

- [x] Existing D-044 session recall shipped in the umbrella plan, so this plan can define the contrast instead of reusing that name ambiguously.
- [x] Existing `source-recall` local repository at `/Users/kevin/dev/source-recall`, including `sr serve`, `/query`, `/refresh`, `/status`, and multi-repo daemon behavior.
- [x] Existing AleutianFOSS local repository at `/Users/kevin/dev/AleutianFOSS`, including Aleutian Trace HTTP, `trace-mcp`, project initialization, graph/context endpoints, and semantic symbol indexing references.
- [x] `03-filesystem-root-taxonomy` root policy exists for Trevor-owned durable configuration and diagnostic state.
- [x] Existing tool-result rendering path can show a visible recall/search result in the transcript.

## 1. Architecture

Indexed source recall is Trevor's provider-neutral interface for fast codebase lookup over prebuilt indexes. It is not session recall. Session recall searches Trevor conversation/session history. Indexed source recall searches source files, symbols, chunks, graph relationships, and provider-owned code indexes for the current project or explicitly selected repositories. <!-- D-001 -->

The Trevor-facing boundary should be one `SourceRecallProvider` contract with normalized capability discovery, health/status, indexing/refresh, and query operations. The first-class backend adapters are:

- `source-recall` HTTP daemon: hybrid BM25/vector code/document chunks over `/query`, repo status over `/repos`/`/status`, and refresh over `/refresh`.
- Aleutian Trace: structural graph/context/code intelligence over `/v1/trace/*` or `trace-mcp`, including project initialization, symbol/call graph lookups, semantic symbol indexing where available, and tool-style code intelligence.

Other services can be added later by implementing the same contract. Trevor should not bake either service's response model into the model-facing tool schema. <!-- D-002 -->

The model-facing surface should expose a small set of source-recall tools rather than every provider endpoint directly. The first cut should provide conceptual code search/retrieval, index status/readiness, and refresh/request-index operations. Provider-specific advanced capabilities, such as Aleutian graph callers/callees or source-recall chunk match reasons, should appear as normalized result metadata and optional capability-specific tools only after the base contract is stable. <!-- D-003 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Not session recall | Never query conversation/session logs through this feature. |
| Provider-neutral contract | Trevor tools depend on normalized capabilities and results, not one backend schema. |
| `source-recall` first adapter | The local Python/FastAPI daemon is the first concrete indexed-source backend. |
| Aleutian Trace first-class | Aleutian gets a real adapter, but capability discovery decides which endpoints/tools are available. |
| Visible tool result | Source recall output is visible in the transcript and eligible for compact/detail rendering. |
| Index lifecycle is explicit | Status, stale index, missing repo, indexing progress, and refresh failures are user-visible. |
| No hidden prompt flooding | Retrieved chunks are bounded and cited; full files are read through normal file tools when needed. |

### Boundaries

- `apps/agent-host` owns provider configuration, health checks, adapter selection, tool execution, normalized result shaping, prompt guidance, and structured diagnostics.
- `packages/session` owns any protocol/read-model additions needed to represent source-recall tool calls/results in the transcript.
- `apps/web` owns transcript rendering for source-recall results, compact row summaries, and future tool detail views.
- `source-recall` remains an external service. Trevor integrates with its HTTP daemon; it does not vendor or reimplement its indexer.
- AleutianFOSS remains an external service. Trevor integrates with Trace HTTP and/or `trace-mcp`; it does not embed the Aleutian agent loop by default.
- Normal filesystem tools still own exact reads, edits, grep, and file writes. Source recall provides retrieval candidates and citations, not mutation.

### Observability

Source recall should be debuggable because it crosses process/service boundaries:

- provider selection logs include provider id, project root, configured endpoint, detected capabilities, and readiness;
- query spans include query text hash, top_k, repo/project scope, provider id, latency, result count, freshness, and failure class;
- index/refresh spans include provider id, repo name/root, index state, files updated where available, and progress/failure details;
- tool results expose provider, repo, query latency, freshness/readiness, and truncation/capping in the visible transcript;
- `/doctor` or the future health surface can report configured source-recall providers and last failure without adding this feature to the doctor plan itself.

## 2. Current State

Trevor has session recall. That shipped scope is the current project's durable session corpus: compacted-away and sibling session history. It is visible in the transcript and model-driven, but it does not index source files.

The backlog still carries `code_search`, `code_index`, `project_retrieve`, `source_recall`, and retrieval daemon as H-112/H-138/H-139. That backlog item should now become this plan.

`/Users/kevin/dev/source-recall` provides a Python/FastAPI indexed source service. Its README describes tree-sitter parsing, local embeddings, hybrid BM25 plus vector search, reciprocal-rank fusion, optional reranking, graph expansion, `sr serve`, `/query`, `/refresh`, `/status`, and multi-repo daemon behavior.

`/Users/kevin/dev/AleutianFOSS` provides Aleutian Trace. It parses code into call graphs and symbol indexes, can use Weaviate-backed semantic symbol search, exposes `/v1/trace/*` HTTP endpoints, and includes a `trace-mcp` binary with graph/code intelligence tools. It is broader than source-recall, so the adapter should map its available capabilities rather than pretending it is only a chunk search API.

## 3. Phases

### Phase 1: Domain Contract and Provider Shape

**Goal:** Trevor has one source-recall vocabulary and contract that cleanly separates session recall, indexed source recall, grep, and LSP.

**Gate from previous:** External service surfaces have been inspected enough to define a stable first adapter contract.

#### M1: Contract Types

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for `SourceRecallProvider` capability discovery, status, query, refresh, and error result shapes.
  2. GREEN: Define normalized provider ids, capabilities, health/readiness states, query inputs, result items, citations, freshness metadata, and failure classes.
  3. RED: Add tests proving session recall result types cannot be passed as source-recall results.
  4. GREEN: Keep source-recall models separate from existing session recall engine types.
  5. REFACTOR: Add module-level ownership comments for the source-recall provider boundary.

#### M2: Tool Surface Definition

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for model-facing tool schemas covering conceptual search, index status, and refresh/request-index.
  2. GREEN: Define first-cut tools such as `source_recall`, `source_index_status`, and `source_index_refresh` over the normalized provider contract.
  3. RED: Add prompt-guidance tests distinguishing source recall from session recall, grep, file mention autocomplete, and LSP/editor lookup.
  4. GREEN: Add guidance that source recall is for conceptual indexed codebase lookup and cited retrieval candidates.
  5. REFACTOR: Keep provider-specific features out of the base schema until the adapter capability layer lands.

### Gate 1->2

- [ ] Source recall has a normalized contract independent of `source-recall` and Aleutian response models.
- [ ] Tool guidance clearly separates indexed source recall from session recall.
- [ ] Base tools are bounded and citation-oriented.

### Phase 2: `source-recall` Adapter

**Goal:** Trevor can query the local `source-recall` HTTP daemon through the normalized provider interface.

**Gate from previous:** Provider contract and tool schemas are defined.

#### M3: HTTP Client and Mapping

- **Dependencies:** M1
- **Effort:** L
- **Tasks:**
  1. RED: Add adapter tests for `/health`, `/repos`, `/status`, `/query`, and `/refresh` using a fake HTTP server.
  2. GREEN: Implement `source-recall` client configuration, health/status checks, query request mapping, and refresh mapping.
  3. RED: Add tests for single-repo, multi-repo, repo-not-found, repo-not-ready, no-repos-ready, timeout, and malformed response.
  4. GREEN: Normalize chunk results to file path, start/end lines, symbol name/type, content, score, match reason, search quality, repo name, provider id, and latency.
  5. REFACTOR: Keep service URL/config parsing separate from request execution.

#### M4: Index Lifecycle and Project Registration

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for missing index, stale index, refresh success, refresh failure, and targeted file refresh where available.
  2. GREEN: Add explicit status/readiness handling and refresh actions for the active project.
  3. RED: Add tests proving Trevor does not auto-index huge repos without an explicit enabled/configured provider path.
  4. GREEN: Use configured provider endpoint and project/repo mapping from Trevor-owned settings; do not invent a new storage root.
  5. REFACTOR: Keep index lifecycle visible and user-directed rather than silently blocking a normal prompt.

### Gate 2->3

- [ ] `source-recall` adapter can query and refresh through fake HTTP tests.
- [ ] Missing/stale/unready indexes produce typed visible failures.
- [ ] Multi-repo behavior is scoped and predictable.

### Phase 3: Aleutian Trace Adapter

**Goal:** Trevor can use Aleutian Trace as a source-recall provider without exposing all Aleutian internals directly to the model.

**Gate from previous:** Base provider contract is stable and `source-recall` adapter proves the shape.

#### M5: Capability Discovery

- **Dependencies:** M1
- **Effort:** L
- **Tasks:**
  1. RED: Add adapter tests for Aleutian Trace health/ready, tool discovery, project init requirement, and unavailable service states.
  2. GREEN: Implement Aleutian capability discovery over Trace HTTP and/or `trace-mcp` configuration.
  3. RED: Add tests for graph-only, context-enabled, semantic-index-enabled, MCP-only, and unavailable capability sets.
  4. GREEN: Normalize discovered capabilities into the shared provider model.
  5. REFACTOR: Keep Trace HTTP and MCP transport concerns behind the Aleutian adapter.

#### M6: Query and Context Mapping

- **Dependencies:** M5
- **Effort:** L
- **Tasks:**
  1. RED: Add tests for mapping conceptual source queries to Aleutian context/semantic/graph endpoints where capabilities allow.
  2. GREEN: Implement initial query mapping using project initialization plus context or semantic source retrieval when available.
  3. RED: Add tests for symbol/call-graph result normalization with file/line citations.
  4. GREEN: Normalize Aleutian results to the same source-recall result items, preserving provider-specific metadata for detail views.
  5. REFACTOR: Do not route Trevor's main model through Aleutian's OpenAI-compatible proxy in the first cut; use Aleutian as a retrieval provider.

### Gate 3->4

- [ ] Aleutian adapter can discover capabilities and report readiness.
- [ ] Aleutian query/context results normalize into Trevor source-recall results.
- [ ] Trevor does not surrender the whole model turn to Aleutian proxy by default.

### Phase 4: Host Tool Integration

**Goal:** The host exposes source recall as a reliable model tool with visible, bounded transcript results.

**Gate from previous:** At least one provider adapter passes contract tests.

#### M7: Tool Execution

- **Dependencies:** M2, M3
- **Effort:** L
- **Tasks:**
  1. RED: Add host tool tests for source recall query, index status, refresh, provider unavailable, timeout, and no results.
  2. GREEN: Wire model-facing source-recall tools through the provider registry and adapter selection.
  3. RED: Add tests proving source recall output is capped, cited, and not silently injected as hidden context.
  4. GREEN: Render a visible tool result with provider, query, citations, and result snippets.
  5. REFACTOR: Keep source recall tool execution read-only and separate from filesystem mutation tools.

#### M8: Provider Selection and Config

- **Dependencies:** M7
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for provider priority, disabled providers, multiple available providers, explicit provider selection, and fallback behavior.
  2. GREEN: Add config for source-recall providers under the approved Trevor settings root.
  3. RED: Add tests proving missing config degrades cleanly to "source recall unavailable" rather than failing ordinary turns.
  4. GREEN: Support `source-recall` and Aleutian provider entries with endpoint, project mapping, timeout, and enabled flag.
  5. REFACTOR: Keep provider selection deterministic and inspectable.

### Gate 4->5

- [ ] Host source-recall tools pass provider and failure tests.
- [ ] Source recall results are visible, bounded, and cited.
- [ ] Provider configuration is deterministic and uses approved storage roots.

### Phase 5: UI, Detail Views, and Validation

**Goal:** Source recall is understandable in the transcript and tested end to end.

**Gate from previous:** Host tools work against fake and at least one real/local provider.

#### M9: Transcript Rendering

- **Dependencies:** M7
- **Effort:** M
- **Tasks:**
  1. RED: Add web fixtures/tests for source-recall result rows with chunks, symbols, no results, stale index, refresh progress, and provider error.
  2. GREEN: Render source-recall results with file path, line range, symbol, snippet, provider, freshness, and open-in-editor affordance where available.
  3. RED: Add compact transcript tests for source-recall rows.
  4. GREEN: Add source-recall eligibility for the planned tool-detail takeover.
  5. REFACTOR: Keep source recall rendering separate from session recall rendering while sharing generic citation primitives where useful.

#### M10: End-to-End Validation

- **Dependencies:** M8, M9
- **Effort:** L
- **Tasks:**
  1. RED: Add hermetic e2e with a fake source-recall provider for query/status/refresh.
  2. GREEN: Make the hermetic e2e pass without requiring external embedding downloads.
  3. RED: Add gated live-provider checks for `/Users/kevin/dev/source-recall` daemon and Aleutian Trace when configured.
  4. GREEN: Add manual EZE checklist: ask a conceptual code question, verify source recall is used, inspect citations, open file, refresh stale index, and compare against session recall behavior.
  5. REFACTOR: Document provider setup and troubleshooting in the plan or local developer docs if implementation needs it.

### Gate 5

- [ ] Unit, web, integration, and hermetic e2e tests pass.
- [ ] Gated live checks skip with stated reasons when providers are absent.
- [ ] Manual EZE proves source recall retrieves indexed codebase context and session recall remains separate.

## 4. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Source recall and session recall blur again | high | medium | Separate types, tool names, transcript labels, and prompt guidance tests. | Host/Session |
| Provider schemas leak into Trevor tools | medium | high | Normalize through `SourceRecallProvider` and keep provider metadata optional. | Host |
| Aleutian adapter scope grows too broad | high | medium | Start with capability discovery and retrieval/context mapping; do not route whole model turns through Aleutian proxy by default. | Host |
| External services are unavailable or heavy | medium | high | Feature degrades cleanly, live checks are gated, fake-provider e2e remains hermetic. | Host/Test |
| Retrieved chunks flood context | high | medium | Cap results/snippets, cite files/lines, use normal read tools for full files. | Host |
| Index freshness is misleading | medium | medium | Surface status/freshness, commit/index time where available, and refresh failures. | Host/Web |

## 5. Escape Hatches

1. **If provider interface design stalls:** ship `source-recall` adapter behind the same normalized contract and leave Aleutian capability mapping disabled until it is understood.
2. **If Aleutian Trace needs its own interaction model:** keep Aleutian as a provider-specific future capability while the base source-recall tools use `source-recall`.
3. **If indexing is too heavy for default local use:** keep source recall opt-in through config and make status/tool guidance explain that no indexed provider is configured.
4. **If provider output is too large:** return citations and short snippets only, then require normal file-read tools for full context.

## 6. Progress Report Accounting

The progress report is `.plans/40-indexed-source-recall/progress-report.md`. It tracks only indexed source/codebase recall: provider contract, `source-recall` adapter, Aleutian Trace adapter, host tools, transcript rendering, and validation. It does not track D-044 session recall, file mention autocomplete, LSP, ordinary grep/read tools, or Aleutian proxy-as-main-model routing except as explicit boundaries.

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "40-indexed-source-recall"
```

## 7. Validation Commands

```bash
pnpm --filter @trevor/agent-host test -- source-recall
pnpm --filter @trevor/session test
pnpm --filter @trevor/web test -- source-recall
pnpm test -- --project e2e
pnpm typecheck
pnpm biome check
```

Live provider checks are gated and should skip with stated reasons when the `source-recall` daemon, Aleutian Trace server, required models, or external vector services are unavailable.

## 8. Decisions

Canonical decisions are in `.plans/40-indexed-source-recall/plan.db`.

