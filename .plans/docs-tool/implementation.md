# Docs Tool - Implementation Plan

## 0. Hard Dependencies

Implementation must not start until these plans are complete:

- [x] `web-fetch-tool` - `docs` uses `web_fetch` for all page reads, URL safety, static/Jina/Firecrawl fallback, caps, and provenance. <!-- D-001 -->
- [x] `filesystem-root-taxonomy` - `docs` stores corpora under the approved Trevor root policy and must not invent a new storage root. <!-- D-001 -->

For this extraction pass, both dependencies are assumed finished for sequencing purposes. <!-- D-001 -->

## 1. Outcome

`docs` is a model-facing documentation lookup/cache tool for external documentation: products, APIs, libraries, services, SaaS platforms, SDKs, provider setup, admin workflows, limits, and operational references. <!-- D-002 --> It is not a general web crawler, not browser automation, and not a source-code truth mechanism for the active workspace.

The tool reuses `web_search` for discovery and `web_fetch` for source page reads. <!-- D-003 --> It stores normalized documentation corpora under the root policy selected by `filesystem-root-taxonomy`. <!-- D-004 -->

## 2. Architecture

| Area | Decision |
|---|---|
| Hard dependencies | `web-fetch-tool` and `filesystem-root-taxonomy` must be completed first. <!-- D-001 --> |
| Tool purpose | `docs` handles external documentation lookup/cache, not workspace code search. <!-- D-002 --> |
| Fetch stack | Discovery uses `web_search`; page reads use `web_fetch`; `docs` never calls Firecrawl directly. <!-- D-003 --> |
| Corpus storage | Store stable-keyed corpora with source metadata, content hashes, freshness metadata, and crawl/discovery metadata under the approved root. <!-- D-004 --> |
| Freshness | Entries go stale after 24 hours; fresh corpora are reused by default; stale refresh is intentional; stale fallback is explicit and metadata-visible. <!-- D-005 --> |
| Bounded discovery | Discovery is capped by docs roots, `llms.txt`, sitemap/index handling, same-origin/path scope, max pages, max bytes, max depth, and visible partial metadata. <!-- D-006 --> |
| Query behavior | Support resolve/fetch, refresh, search cached corpus, read cached page, list corpora, and report freshness/provenance. <!-- D-007 --> |
| Workspace truth | Prompt guidance keeps local repo truth on files, LSP, `rg`, `ast_grep`, tests, compiler output, and local plans. <!-- D-008 --> |
| Validation | Tests/evals cover keying, staleness, bounded discovery, citations, cached query behavior, no direct Firecrawl calls, workspace-truth boundary, and network failures. <!-- D-009 --> |

## 3. Non-Goals

- No direct Firecrawl integration inside `docs`.
- No broad unlimited crawler.
- No authenticated browsing or cookie/session reuse.
- No replacement for local code search, LSP, tests, or compiler output.
- No docs corpus prompt dump.
- No new storage root.
- No automatic refresh of every stale corpus at startup.

## 4. Data Model

### Corpus

Each corpus has:

- stable `corpusId`
- subject/name
- source identity
- root URL and optional version/channel
- created/updated timestamps
- stale-after timestamp
- fetch/discovery policy
- page count, byte count, truncation flags
- provenance summary
- diagnostics for skipped/failed pages

### Page

Each page has:

- stable `pageId`
- source URL and final URL
- title
- content type
- normalized markdown/text
- content hash
- fetched time and stale-after time
- fetch backend/provenance from `web_fetch`
- page-level diagnostics
- outgoing doc links discovered, when relevant

### Query Result

Results return compact ranked excerpts with citations, not full corpora. <!-- D-007 -->

## 5. Implementation Sequence

### Phase 1: Tool Contract and Dependency Gate

**Goal:** Define the `docs` tool surface and enforce hard dependency assumptions.

1. RED: Add tool-schema tests for supported actions: `resolve`, `refresh`, `search`, `read`, `list`, and `status`.
2. GREEN: Define `docs` params and result envelope with typed outcomes.
3. RED: Add registry tests proving `docs` is read-only.
4. GREEN: Register `docs` as read-only.
5. RED: Add dependency-readiness tests or startup diagnostics for `web_fetch` and root-policy availability.
6. GREEN: Fail gracefully with typed `unavailable` when a hard dependency is missing. <!-- D-001 -->
7. REFACTOR: Keep tool action parsing small and route actions to separate service functions.

**Acceptance:**

- [ ] Tool schema is stable.
- [ ] `docs` is read-only.
- [ ] Missing dependencies produce typed results, not turn failures.

### Phase 2: Corpus Storage

**Goal:** Persist normalized docs corpora under the approved root policy.

1. RED: Add corpus-key tests for subject, root URL, version, and source identity.
2. GREEN: Implement stable corpus/page keys.
3. RED: Add storage tests proving the selected root comes from `filesystem-root-taxonomy`.
4. GREEN: Persist corpus metadata, page metadata, normalized content, hashes, and diagnostics. <!-- D-004 -->
5. RED: Add corruption/partial-write tests.
6. GREEN: Make writes atomic enough that partial corpora are visible as partial, not silently healthy.
7. REFACTOR: Keep storage format inspectable and migration-friendly.

**Acceptance:**

- [ ] Corpora are stable across runs.
- [ ] Root selection follows the hard dependency.
- [ ] Partial/corrupt corpora produce visible diagnostics.

### Phase 3: Discovery

**Goal:** Resolve bounded documentation roots without crawling the open web.

1. RED: Add discovery tests for direct docs URL, subject query, official docs result, `llms.txt`, `llms-full.txt`, sitemap, and docs index pages.
2. GREEN: Use `web_search` to discover candidate docs roots when no explicit URL is supplied. <!-- D-003 -->
3. GREEN: Prefer official docs roots and explicit documentation indexes.
4. RED: Add cap tests for max pages, bytes, depth, same-origin/path scope, and partial-corpus metadata.
5. GREEN: Enforce bounded discovery caps and visible truncation. <!-- D-006 -->
6. RED: Add robots/site-policy behavior tests where applicable.
7. GREEN: Respect policy inputs without turning docs into a crawler.
8. REFACTOR: Separate candidate resolution from page fetching.

**Acceptance:**

- [ ] Discovery is bounded and explainable.
- [ ] Partial corpus status is visible.
- [ ] The tool can resolve docs without over-fetching.

### Phase 4: Page Fetch and Normalization

**Goal:** Read pages through `web_fetch` and normalize them into a searchable corpus.

1. RED: Add tests proving `docs` calls `web_fetch` and never calls Firecrawl directly.
2. GREEN: Fetch pages only through `web_fetch`. <!-- D-003 -->
3. RED: Add normalization tests for markdown, headings, code blocks, navigation clutter, empty/thin pages, and duplicate pages.
4. GREEN: Normalize page content and store content hashes.
5. RED: Add provenance tests proving page results preserve final URL and fetch backend information.
6. GREEN: Carry `web_fetch` provenance into page metadata.
7. REFACTOR: Deduplicate pages by canonical URL and content hash where safe.

**Acceptance:**

- [ ] No direct Firecrawl path exists in `docs`.
- [ ] Normalized pages are citeable.
- [ ] Fetch failures produce page/corpus diagnostics.

### Phase 5: Freshness and Refresh

**Goal:** Reuse fresh corpora and refresh stale corpora intentionally.

1. RED: Add tests for 24-hour staleness, fresh reuse, stale refresh, manual refresh, and stale fallback.
2. GREEN: Mark pages/corpora stale after 24 hours. <!-- D-005 -->
3. GREEN: Reuse fresh corpora by default.
4. GREEN: Refresh stale corpora on explicit refresh or refresh-allowed query.
5. RED: Add network-failure tests where stale content exists.
6. GREEN: Return stale content only with explicit stale metadata when refresh fails or caller allows stale use.
7. REFACTOR: Keep refresh policy separate from query ranking.

**Acceptance:**

- [ ] Fresh cache reuse avoids unnecessary network calls.
- [ ] Stale data is never presented as fresh.
- [ ] Manual refresh is supported.

### Phase 6: Query Actions

**Goal:** Make cached docs useful without flooding the prompt.

1. RED: Add action tests for `resolve`, `refresh`, `search`, `read`, `list`, and `status`.
2. GREEN: Implement `resolve/fetch` returning corpus summary and selected excerpts.
3. GREEN: Implement `search` over cached pages with ranked excerpts and citations.
4. GREEN: Implement `read` for a specific cached page with bounded output.
5. GREEN: Implement `list` and `status` for corpus inventory and freshness/provenance. <!-- D-007 -->
6. RED: Add result-size cap tests.
7. GREEN: Return truncation and continuation metadata.
8. REFACTOR: Share citation formatting across actions.

**Acceptance:**

- [ ] The model can find and cite relevant docs.
- [ ] Large corpora never dump wholesale into context.
- [ ] Users can inspect freshness/provenance.

### Phase 7: Prompt Guidance and UI Rendering

**Goal:** Help the model and user understand when docs results are appropriate.

1. RED: Add prompt-guidance tests for when to use `docs`.
2. GREEN: Tell the model to use `docs` for current external documentation needs. <!-- D-008 -->
3. GREEN: Tell the model not to use `docs` for active workspace source truth.
4. RED: Add web renderer tests for corpus summaries, excerpts, citations, stale/partial status, and errors.
5. GREEN: Render docs results as structured source-backed documentation snippets.
6. RED: Add evals proving local repo questions use files/LSP/search/tests instead of docs.
7. GREEN: Tune guidance until evals pass.

**Acceptance:**

- [ ] Model guidance preserves the workspace-truth boundary.
- [ ] Docs output is readable and citeable in the UI.
- [ ] Stale/partial/error states are visible.

### Phase 8: End-to-End Verification

**Goal:** Prove the full docs workflow behaves safely and usefully.

1. RED: Add integration tests for search-to-fetch-to-corpus-to-query workflow.
2. GREEN: Pass with mocked `web_search` and `web_fetch`.
3. RED: Add hermetic e2e-style tests for stale refresh and network failure fallback.
4. GREEN: Make diagnostics and stale metadata visible.
5. RED: Add no-direct-Firecrawl and no-workspace-substitution regression tests. <!-- D-009 -->
6. GREEN: Ensure every validation item from D-009 is covered.
7. Manual EZE: fetch docs for a public library, answer from cited cached docs, refresh after staleness, and confirm local repo facts still come from local files/search/tests.

**Acceptance:**

- [ ] Unit, integration, web, and hermetic e2e-style tests pass.
- [ ] Manual EZE validates the full user-visible workflow.
- [ ] No dependency or storage policy is bypassed.

## 6. Verification Checklist

- [ ] Corpus keying. <!-- D-009 -->
- [ ] 24-hour staleness. <!-- D-009 -->
- [ ] Fresh cache reuse. <!-- D-009 -->
- [ ] Stale refresh. <!-- D-009 -->
- [ ] Manual refresh. <!-- D-009 -->
- [ ] Bounded docs discovery. <!-- D-009 -->
- [ ] `llms.txt`, sitemap, and index handling. <!-- D-009 -->
- [ ] Partial-corpus metadata. <!-- D-009 -->
- [ ] Source citations. <!-- D-009 -->
- [ ] Search within cached docs. <!-- D-009 -->
- [ ] Cached page reads. <!-- D-009 -->
- [ ] Corpus listing/status. <!-- D-009 -->
- [ ] No direct Firecrawl calls from `docs`. <!-- D-009 -->
- [ ] No workspace-truth substitution. <!-- D-009 -->
- [ ] Graceful behavior when network fetches fail after a stale corpus exists. <!-- D-009 -->

## 7. Progress Accounting

The progress report is the implementation resume state. It must distinguish current cutoff blockers from deferred follow-up and superseded checklist debt.

Run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "docs-tool"
```

## 8. Decision Ledger

Canonical decisions are in `.plans/docs-tool/plan.db`. Query them with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "docs-tool"
```
