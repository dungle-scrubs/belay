# Docs Tool - Progress Report

## Summary

- Current cutoff blockers: 0
- Completed current work: 97 (Phases 1-8)
- Deferred follow-up: 2 (manual EZE - needs live network + provider keys)
- Superseded checklist debt: 0

## Hard Dependencies

- [x] `04-web-fetch-tool` complete before implementation starts
- [x] `03-filesystem-root-taxonomy` complete before implementation starts

For this extraction pass, both dependencies are assumed finished for sequencing purposes.

## Current Focus

Complete (deferred manual EZE)

## Current Cutoff Blockers

### Phase 1: Tool Contract and Dependency Gate

#### M1: Tool schema and dependency readiness

- [x] RED: Add tool-schema tests for supported actions: `resolve`, `refresh`, `search`, `read`, `list`, and `status`.
- [x] GREEN: Define `docs` params and result envelope with typed outcomes.
- [x] RED: Add registry tests proving `docs` is read-only.
- [x] GREEN: Register `docs` as read-only.
- [x] RED: Add dependency-readiness tests or startup diagnostics for `web_fetch` and root-policy availability.
- [x] GREEN: Fail gracefully with typed `unavailable` when a hard dependency is missing.
- [x] REFACTOR: Keep tool action parsing small and route actions to separate service functions.
- [x] Tool schema is stable.
- [x] `docs` is read-only.
- [x] Missing dependencies produce typed results, not turn failures.

### Phase 2: Corpus Storage

#### M2: Corpus persistence

- [x] RED: Add corpus-key tests for subject, root URL, version, and source identity.
- [x] GREEN: Implement stable corpus/page keys.
- [x] RED: Add storage tests proving the selected root comes from `03-filesystem-root-taxonomy`.
- [x] GREEN: Persist corpus metadata, page metadata, normalized content, hashes, and diagnostics.
- [x] RED: Add corruption/partial-write tests.
- [x] GREEN: Make writes atomic enough that partial corpora are visible as partial, not silently healthy.
- [x] REFACTOR: Keep storage format inspectable and migration-friendly.
- [x] Corpora are stable across runs.
- [x] Root selection follows the hard dependency.
- [x] Partial/corrupt corpora produce visible diagnostics.

### Phase 3: Discovery

#### M3: Bounded docs discovery

- [x] RED: Add discovery tests for direct docs URL, subject query, official docs result, `llms.txt`, `llms-full.txt`, sitemap, and docs index pages.
- [x] GREEN: Use `web_search` to discover candidate docs roots when no explicit URL is supplied.
- [x] GREEN: Prefer official docs roots and explicit documentation indexes.
- [x] RED: Add cap tests for max pages, bytes, depth, same-origin/path scope, and partial-corpus metadata.
- [x] GREEN: Enforce bounded discovery caps and visible truncation.
- [x] RED: Add robots/site-policy behavior tests where applicable.
- [x] GREEN: Respect policy inputs without turning docs into a crawler.
- [x] REFACTOR: Separate candidate resolution from page fetching.
- [x] Discovery is bounded and explainable.
- [x] Partial corpus status is visible.
- [x] The tool can resolve docs without over-fetching.

### Phase 4: Page Fetch and Normalization

#### M4: Page ingestion via web_fetch

- [x] RED: Add tests proving `docs` calls `web_fetch` and never calls Firecrawl directly.
- [x] GREEN: Fetch pages only through `web_fetch`.
- [x] RED: Add normalization tests for markdown, headings, code blocks, navigation clutter, empty/thin pages, and duplicate pages.
- [x] GREEN: Normalize page content and store content hashes.
- [x] RED: Add provenance tests proving page results preserve final URL and fetch backend information.
- [x] GREEN: Carry `web_fetch` provenance into page metadata.
- [x] REFACTOR: Deduplicate pages by canonical URL and content hash where safe.
- [x] No direct Firecrawl path exists in `docs`.
- [x] Normalized pages are citeable.
- [x] Fetch failures produce page/corpus diagnostics.

### Phase 5: Freshness and Refresh

#### M5: Staleness policy

- [x] RED: Add tests for 24-hour staleness, fresh reuse, stale refresh, manual refresh, and stale fallback.
- [x] GREEN: Mark pages/corpora stale after 24 hours.
- [x] GREEN: Reuse fresh corpora by default.
- [x] GREEN: Refresh stale corpora on explicit refresh or refresh-allowed query.
- [x] RED: Add network-failure tests where stale content exists.
- [x] GREEN: Return stale content only with explicit stale metadata when refresh fails or caller allows stale use.
- [x] REFACTOR: Keep refresh policy separate from query ranking.
- [x] Fresh cache reuse avoids unnecessary network calls.
- [x] Stale data is never presented as fresh.
- [x] Manual refresh is supported.

### Phase 6: Query Actions

#### M6: Cached docs actions

- [x] RED: Add action tests for `resolve`, `refresh`, `search`, `read`, `list`, and `status`.
- [x] GREEN: Implement `resolve/fetch` returning corpus summary and selected excerpts.
- [x] GREEN: Implement `search` over cached pages with ranked excerpts and citations.
- [x] GREEN: Implement `read` for a specific cached page with bounded output.
- [x] GREEN: Implement `list` and `status` for corpus inventory and freshness/provenance.
- [x] RED: Add result-size cap tests.
- [x] GREEN: Return truncation and continuation metadata.
- [x] REFACTOR: Share citation formatting across actions.
- [x] The model can find and cite relevant docs.
- [x] Large corpora never dump wholesale into context.
- [x] Users can inspect freshness/provenance.

### Phase 7: Prompt Guidance and UI Rendering

#### M7: Guidance and rendering

- [x] RED: Add prompt-guidance tests for when to use `docs`.
- [x] GREEN: Tell the model to use `docs` for current external documentation needs.
- [x] GREEN: Tell the model not to use `docs` for active workspace source truth.
- [x] RED: Add web renderer tests for corpus summaries, excerpts, citations, stale/partial status, and errors.
- [x] GREEN: Render docs results as structured source-backed documentation snippets.
- [x] RED: Add evals proving local repo questions use files/LSP/search/tests instead of docs.
- [x] GREEN: Tune guidance until evals pass.
- [x] Model guidance preserves the workspace-truth boundary.
- [x] Docs output is readable and citeable in the UI.
- [x] Stale/partial/error states are visible.

### Phase 8: End-to-End Verification

#### M8: Full workflow validation

- [x] RED: Add integration tests for search-to-fetch-to-corpus-to-query workflow.
- [x] GREEN: Pass with mocked `web_search` and `web_fetch`.
- [x] RED: Add hermetic e2e-style tests for stale refresh and network failure fallback.
- [x] GREEN: Make diagnostics and stale metadata visible.
- [x] RED: Add no-direct-Firecrawl and no-workspace-substitution regression tests.
- [x] GREEN: Ensure every validation item from D-009 is covered.
- [x] Unit, integration, web, and hermetic e2e-style tests pass.
- [x] No dependency or storage policy is bypassed.

The plan's live Manual EZE (and its user-visible-workflow acceptance) is a DEFERRED manual EZE - it needs live network and provider keys to fetch real public docs. See Accepted/Deferred Follow-Up.

### Verification Checklist

- [x] Corpus keying. (`corpus.test.ts`, `corpus-store.test.ts`)
- [x] 24-hour staleness. (`freshness.test.ts`, `docs-freshness.test.ts`)
- [x] Fresh cache reuse. (`docs-freshness.test.ts`)
- [x] Stale refresh. (`docs-freshness.test.ts`, `docs-e2e.test.ts`)
- [x] Manual refresh. (`docs-freshness.test.ts`)
- [x] Bounded docs discovery. (`discovery.test.ts`)
- [x] `llms.txt`, sitemap, and index handling. (`discovery.test.ts`)
- [x] Partial-corpus metadata. (`docs-resolve.test.ts`, `corpus-store.test.ts`)
- [x] Source citations. (`docs-query.test.ts`, `docs-e2e.test.ts`, web `docs.test.tsx`)
- [x] Search within cached docs. (`docs-query.test.ts`, `docs-e2e.test.ts`)
- [x] Cached page reads. (`docs-query.test.ts`, web `docs.test.tsx`)
- [x] Corpus listing/status. (`docs-query.test.ts`, web `docs.test.tsx`)
- [x] No direct Firecrawl calls from `docs`. (`no-firecrawl.test.ts`, `docs-regression.test.ts`)
- [x] No workspace-truth substitution. (`docs-regression.test.ts`, `system-prompt.test.ts`)
- [x] Graceful behavior when network fetches fail after a stale corpus exists. (`docs-freshness.test.ts`, `docs-e2e.test.ts`)

## Accepted/Deferred Follow-Up

The Phase 8 Manual EZE is deferred: it requires live network access and provider keys
(web_search + web_fetch backends) to fetch real public documentation, which the hermetic
suite cannot exercise. The full workflow is covered hermetically by `docs-e2e.test.ts`
(search -> fetch -> corpus -> query, stale refresh, network-failure stale fallback) and the
web renderer by `docs.test.tsx`; the live run remains a manual step.

- [ ] Manual EZE: fetch docs for a public library, answer from cited cached docs, refresh after staleness, and confirm local repo facts still come from local files/search/tests.
- [ ] Manual EZE validates the full user-visible workflow.

## Superseded/Obsolete Checklist Debt

None.
