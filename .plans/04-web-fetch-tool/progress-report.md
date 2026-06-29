# Web Fetch Tool - Progress Report

## Summary

- Current focus: M7 - Prompt Guidance and Web Rendering
- Current cutoff blockers: 32
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0
- Completed current work: 54 (M1-M6 + Gates 1->2, 2->3, 3->4)

## Current Cutoff Blockers

### Phase 1: Contract and Safety

#### M1: Tool Contract and Read-Only Registration

- [x] RED: Add tool schema tests for URL, mode, caps, and optional output preferences.
- [x] GREEN: Define `web_fetch` params with explicit URL and bounded mode/cap fields.
- [x] RED: Add result-envelope tests for metadata, content, backend, attempts, truncation, and errors.
- [x] GREEN: Define the structured JSON result envelope.
- [x] RED: Add registry tests proving `web_fetch` is read-only.
- [x] GREEN: Register `web_fetch` with `readOnly: true` and shared read-only tool metadata.
- [x] REFACTOR: Keep tool schema flat and provider-compatible.

#### M2: URL Safety Guard

- [x] RED: Add URL guard tests for unsupported schemes, malformed URLs, userinfo, loopback, private ranges, link-local, IPv6 local, and cloud metadata targets.
- [x] GREEN: Implement URL normalization and preflight rejection.
- [x] RED: Add redirect-chain tests for safe redirect, private redirect, scheme downgrade where disallowed, and redirect loop.
- [x] GREEN: Validate every redirect hop before following or sending the target URL to a backend.
- [x] RED: Add tests for hostnames resolving to private or link-local addresses where the runtime can check DNS.
- [x] GREEN: Add DNS/IP safety checks where feasible with graceful unknown handling.
- [x] REFACTOR: Make URL guard reusable by Jina, Firecrawl, and future docs fetching.

### Gate 1 -> 2

- [x] `web_fetch` has a stable schema and result envelope.
- [x] `web_fetch` is registered read-only.
- [x] Unsafe direct URLs and unsafe redirects are blocked before any backend runs.
- [x] URL guard is reusable by every backend path.

### Phase 2: Static Fetch and Extraction

#### M3: Static HTTP Fetch

- [x] RED: Add static fetch tests for HTML, plain text, JSON, redirects, 404, 5xx, timeout, and oversized response.
- [x] GREEN: Implement static fetch with short timeout, byte cap, redirect cap, and response metadata.
- [x] RED: Add content-type handling tests for HTML, text/plain, application/json, and unknown content type.
- [x] GREEN: Return bounded text for text/plain and JSON with truncation metadata.
- [x] RED: Add tests proving auth headers/cookies are not sent.
- [x] GREEN: Ensure no browser/user cookies or authenticated sessions are used.
- [x] REFACTOR: Keep static fetch IO injectable for deterministic tests.

#### M4: HTML Extraction and Thinness Detection

- [x] RED: Add extraction tests for title, main article content, boilerplate removal, links, code blocks, and malformed HTML.
- [x] GREEN: Convert static HTML into readable bounded markdown/text.
- [x] RED: Add thin-page detection tests for JS shell, empty body, blocker page, and low-content extraction.
- [x] GREEN: Classify static results as usable, thin, blocked, or failed.
- [x] RED: Add truncation tests for long pages.
- [x] GREEN: Apply text-length caps with visible truncation metadata.
- [x] REFACTOR: Keep extraction deterministic and independent of rendered backends.

### Gate 2 -> 3

- [x] Static mode works without Jina or Firecrawl.
- [x] Auto mode returns usable static content without spending external rendering calls.
- [x] Thin/blocked pages are classified for fallback.
- [x] Metadata includes final URL, status, content type, byte/text counts, backend, and truncation.

### Phase 3: Jina and Firecrawl Fallbacks

#### M5: Jina Reader Fallback

- [x] RED: Add tests proving Jina is attempted only after static extraction is unusable in auto mode.
- [x] GREEN: Implement direct Jina Reader request against the target URL after URL safety validation.
- [x] RED: Add tests for Jina success, empty output, blocker output, rate limit, timeout, and error.
- [x] GREEN: Normalize Jina results and errors into the result envelope.
- [x] RED: Add cap/provenance tests for Jina output.
- [x] GREEN: Apply byte/time/text caps and record Jina provenance.
- [x] REFACTOR: Keep optional Jina API key support isolated if introduced.

#### M6: Firecrawl Final Fallback

- [x] RED: Add tests proving Firecrawl is not called when static or Jina content is usable.
- [x] GREEN: Gate Firecrawl behind `FIRECRAWL_API_KEY` and final-fallback conditions.
- [x] RED: Add tests for missing key, SDK unavailable, rate limit, provider error, timeout, and success.
- [x] GREEN: Return structured unavailable/error results when Firecrawl cannot run.
- [x] RED: Add tests proving only markdown/main-content request shape is used.
- [x] GREEN: Exclude search, crawl, map, extract/JSON, screenshots, actions, profiles, cookies, custom headers, enhanced proxy, and broad crawling.
- [x] REFACTOR: Keep Firecrawl dependency optional and isolated.

### Gate 3 -> 4

- [x] Auto ladder is static, then Jina, then Firecrawl.
- [x] Firecrawl is not accidentally spent on ordinary pages.
- [x] Missing or failing external backends return typed results.
- [x] Backend attempts and provenance are visible in the result envelope.

### Phase 4: Tool UX, Doctor, and Guidance

#### M7: Prompt Guidance and Web Rendering

- [ ] RED: Add system-prompt/tool-guidance tests for web_search vs web_fetch selection.
- [ ] GREEN: Tell the model to use `web_search` for discovery and `web_fetch` for selected source reading.
- [ ] RED: Add prompt tests proving Firecrawl is described as scarce final fallback.
- [ ] GREEN: Add backend ladder guidance: static default, Jina for unusable static pages, Firecrawl last.
- [ ] RED: Add web renderer tests for `web_fetch` result envelope, truncation, backend attempts, and errors.
- [ ] GREEN: Render `web_fetch` results as flat source content, not as generic opaque JSON.
- [ ] REFACTOR: Reuse web_search visual patterns where they fit.

#### M8: Doctor and Diagnostics

- [ ] RED: Add Doctor tests for static available, Jina configured/unconfigured/error, Firecrawl configured/unconfigured/error, and last sanitized failures.
- [ ] GREEN: Wire web/fetch diagnostics into Doctor.
- [ ] RED: Add logging/redaction tests proving URLs, keys, headers, and response bodies are not leaked.
- [ ] GREEN: Log backend, host, status, duration, caps, and sanitized error categories only.
- [ ] RED: Add tests proving fetched content is not stored in debug logs by default.
- [ ] GREEN: Keep content only in tool result/session events.

### Gate 4 -> 5

- [ ] Prompt guidance distinguishes discovery from source reading.
- [ ] Web renders `web_fetch` results clearly.
- [ ] Doctor reports backend availability and sanitized failures.
- [ ] Logs redact secrets and avoid storing fetched content.

### Phase 5: Verification

#### M9: Full Test and E2E Coverage

- [ ] RED: Add integration tests for `web_search` followed by `web_fetch` on a selected result.
- [ ] GREEN: Verify result content and provenance are model-visible and web-renderable.
- [ ] RED: Add tests for explicit rendered mode and Firecrawl absence.
- [ ] GREEN: Return graceful unavailable results when rendered content is required but Firecrawl is unavailable.
- [ ] RED: Add prompt regression tests proving ordinary static pages do not call Firecrawl.
- [ ] GREEN: Tune guidance and backend selection accordingly.
- [ ] GREEN: Run lint, typecheck, unit, integration, web, and hermetic e2e lanes.
- [ ] GREEN: Manual EZE repro: search for a source, fetch a selected URL, verify static content; fetch a thin page with Jina fallback; verify Firecrawl absence is graceful.
- [ ] REFACTOR: Record exact verification commands and backend config in the progress report.

### Done Gate

- [ ] `web_fetch` reads one explicit safe public URL.
- [ ] Static fetch succeeds for ordinary pages.
- [ ] Jina fallback runs only when static is unusable.
- [ ] Firecrawl is last, optional, bounded, and not accidentally spent.
- [ ] Results include attribution, metadata, backend provenance, and truncation.
- [ ] Full verification passes.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.
