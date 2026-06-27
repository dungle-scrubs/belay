# Docs Tool - Progress Report

## Summary

- Current cutoff blockers: 97
- Deferred follow-up: 0
- Superseded checklist debt: 0

## Hard Dependencies

- [x] `03-web-fetch-tool` complete before implementation starts
- [x] `02-filesystem-root-taxonomy` complete before implementation starts

For this extraction pass, both dependencies are assumed finished for sequencing purposes.

## Current Focus

Blockers

## Current Cutoff Blockers

### Phase 1: Tool Contract and Dependency Gate

#### M1: Tool schema and dependency readiness

- [ ] RED: Add tool-schema tests for supported actions: `resolve`, `refresh`, `search`, `read`, `list`, and `status`.
- [ ] GREEN: Define `docs` params and result envelope with typed outcomes.
- [ ] RED: Add registry tests proving `docs` is read-only.
- [ ] GREEN: Register `docs` as read-only.
- [ ] RED: Add dependency-readiness tests or startup diagnostics for `web_fetch` and root-policy availability.
- [ ] GREEN: Fail gracefully with typed `unavailable` when a hard dependency is missing.
- [ ] REFACTOR: Keep tool action parsing small and route actions to separate service functions.
- [ ] Tool schema is stable.
- [ ] `docs` is read-only.
- [ ] Missing dependencies produce typed results, not turn failures.

### Phase 2: Corpus Storage

#### M2: Corpus persistence

- [ ] RED: Add corpus-key tests for subject, root URL, version, and source identity.
- [ ] GREEN: Implement stable corpus/page keys.
- [ ] RED: Add storage tests proving the selected root comes from `02-filesystem-root-taxonomy`.
- [ ] GREEN: Persist corpus metadata, page metadata, normalized content, hashes, and diagnostics.
- [ ] RED: Add corruption/partial-write tests.
- [ ] GREEN: Make writes atomic enough that partial corpora are visible as partial, not silently healthy.
- [ ] REFACTOR: Keep storage format inspectable and migration-friendly.
- [ ] Corpora are stable across runs.
- [ ] Root selection follows the hard dependency.
- [ ] Partial/corrupt corpora produce visible diagnostics.

### Phase 3: Discovery

#### M3: Bounded docs discovery

- [ ] RED: Add discovery tests for direct docs URL, subject query, official docs result, `llms.txt`, `llms-full.txt`, sitemap, and docs index pages.
- [ ] GREEN: Use `web_search` to discover candidate docs roots when no explicit URL is supplied.
- [ ] GREEN: Prefer official docs roots and explicit documentation indexes.
- [ ] RED: Add cap tests for max pages, bytes, depth, same-origin/path scope, and partial-corpus metadata.
- [ ] GREEN: Enforce bounded discovery caps and visible truncation.
- [ ] RED: Add robots/site-policy behavior tests where applicable.
- [ ] GREEN: Respect policy inputs without turning docs into a crawler.
- [ ] REFACTOR: Separate candidate resolution from page fetching.
- [ ] Discovery is bounded and explainable.
- [ ] Partial corpus status is visible.
- [ ] The tool can resolve docs without over-fetching.

### Phase 4: Page Fetch and Normalization

#### M4: Page ingestion via web_fetch

- [ ] RED: Add tests proving `docs` calls `web_fetch` and never calls Firecrawl directly.
- [ ] GREEN: Fetch pages only through `web_fetch`.
- [ ] RED: Add normalization tests for markdown, headings, code blocks, navigation clutter, empty/thin pages, and duplicate pages.
- [ ] GREEN: Normalize page content and store content hashes.
- [ ] RED: Add provenance tests proving page results preserve final URL and fetch backend information.
- [ ] GREEN: Carry `web_fetch` provenance into page metadata.
- [ ] REFACTOR: Deduplicate pages by canonical URL and content hash where safe.
- [ ] No direct Firecrawl path exists in `docs`.
- [ ] Normalized pages are citeable.
- [ ] Fetch failures produce page/corpus diagnostics.

### Phase 5: Freshness and Refresh

#### M5: Staleness policy

- [ ] RED: Add tests for 24-hour staleness, fresh reuse, stale refresh, manual refresh, and stale fallback.
- [ ] GREEN: Mark pages/corpora stale after 24 hours.
- [ ] GREEN: Reuse fresh corpora by default.
- [ ] GREEN: Refresh stale corpora on explicit refresh or refresh-allowed query.
- [ ] RED: Add network-failure tests where stale content exists.
- [ ] GREEN: Return stale content only with explicit stale metadata when refresh fails or caller allows stale use.
- [ ] REFACTOR: Keep refresh policy separate from query ranking.
- [ ] Fresh cache reuse avoids unnecessary network calls.
- [ ] Stale data is never presented as fresh.
- [ ] Manual refresh is supported.

### Phase 6: Query Actions

#### M6: Cached docs actions

- [ ] RED: Add action tests for `resolve`, `refresh`, `search`, `read`, `list`, and `status`.
- [ ] GREEN: Implement `resolve/fetch` returning corpus summary and selected excerpts.
- [ ] GREEN: Implement `search` over cached pages with ranked excerpts and citations.
- [ ] GREEN: Implement `read` for a specific cached page with bounded output.
- [ ] GREEN: Implement `list` and `status` for corpus inventory and freshness/provenance.
- [ ] RED: Add result-size cap tests.
- [ ] GREEN: Return truncation and continuation metadata.
- [ ] REFACTOR: Share citation formatting across actions.
- [ ] The model can find and cite relevant docs.
- [ ] Large corpora never dump wholesale into context.
- [ ] Users can inspect freshness/provenance.

### Phase 7: Prompt Guidance and UI Rendering

#### M7: Guidance and rendering

- [ ] RED: Add prompt-guidance tests for when to use `docs`.
- [ ] GREEN: Tell the model to use `docs` for current external documentation needs.
- [ ] GREEN: Tell the model not to use `docs` for active workspace source truth.
- [ ] RED: Add web renderer tests for corpus summaries, excerpts, citations, stale/partial status, and errors.
- [ ] GREEN: Render docs results as structured source-backed documentation snippets.
- [ ] RED: Add evals proving local repo questions use files/LSP/search/tests instead of docs.
- [ ] GREEN: Tune guidance until evals pass.
- [ ] Model guidance preserves the workspace-truth boundary.
- [ ] Docs output is readable and citeable in the UI.
- [ ] Stale/partial/error states are visible.

### Phase 8: End-to-End Verification

#### M8: Full workflow validation

- [ ] RED: Add integration tests for search-to-fetch-to-corpus-to-query workflow.
- [ ] GREEN: Pass with mocked `web_search` and `web_fetch`.
- [ ] RED: Add hermetic e2e-style tests for stale refresh and network failure fallback.
- [ ] GREEN: Make diagnostics and stale metadata visible.
- [ ] RED: Add no-direct-Firecrawl and no-workspace-substitution regression tests.
- [ ] GREEN: Ensure every validation item from D-009 is covered.
- [ ] Manual EZE: fetch docs for a public library, answer from cited cached docs, refresh after staleness, and confirm local repo facts still come from local files/search/tests.
- [ ] Unit, integration, web, and hermetic e2e-style tests pass.
- [ ] Manual EZE validates the full user-visible workflow.
- [ ] No dependency or storage policy is bypassed.

### Verification Checklist

- [ ] Corpus keying.
- [ ] 24-hour staleness.
- [ ] Fresh cache reuse.
- [ ] Stale refresh.
- [ ] Manual refresh.
- [ ] Bounded docs discovery.
- [ ] `llms.txt`, sitemap, and index handling.
- [ ] Partial-corpus metadata.
- [ ] Source citations.
- [ ] Search within cached docs.
- [ ] Cached page reads.
- [ ] Corpus listing/status.
- [ ] No direct Firecrawl calls from `docs`.
- [ ] No workspace-truth substitution.
- [ ] Graceful behavior when network fetches fail after a stale corpus exists.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.
