# Web Fetch Tool - Progress Report

## Summary

- Current focus: M1 - Tool Contract and Read-Only Registration
- Current cutoff blockers: 86
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0
- Completed current work: 0

## Current Cutoff Blockers

### Phase 1: Contract and Safety

#### M1: Tool Contract and Read-Only Registration

- [ ] RED: Add tool schema tests for URL, mode, caps, and optional output preferences.
- [ ] GREEN: Define `web_fetch` params with explicit URL and bounded mode/cap fields.
- [ ] RED: Add result-envelope tests for metadata, content, backend, attempts, truncation, and errors.
- [ ] GREEN: Define the structured JSON result envelope.
- [ ] RED: Add registry tests proving `web_fetch` is read-only.
- [ ] GREEN: Register `web_fetch` with `readOnly: true` and shared read-only tool metadata.
- [ ] REFACTOR: Keep tool schema flat and provider-compatible.

#### M2: URL Safety Guard

- [ ] RED: Add URL guard tests for unsupported schemes, malformed URLs, userinfo, loopback, private ranges, link-local, IPv6 local, and cloud metadata targets.
- [ ] GREEN: Implement URL normalization and preflight rejection.
- [ ] RED: Add redirect-chain tests for safe redirect, private redirect, scheme downgrade where disallowed, and redirect loop.
- [ ] GREEN: Validate every redirect hop before following or sending the target URL to a backend.
- [ ] RED: Add tests for hostnames resolving to private or link-local addresses where the runtime can check DNS.
- [ ] GREEN: Add DNS/IP safety checks where feasible with graceful unknown handling.
- [ ] REFACTOR: Make URL guard reusable by Jina, Firecrawl, and future docs fetching.

### Gate 1 -> 2

- [ ] `web_fetch` has a stable schema and result envelope.
- [ ] `web_fetch` is registered read-only.
- [ ] Unsafe direct URLs and unsafe redirects are blocked before any backend runs.
- [ ] URL guard is reusable by every backend path.

### Phase 2: Static Fetch and Extraction

#### M3: Static HTTP Fetch

- [ ] RED: Add static fetch tests for HTML, plain text, JSON, redirects, 404, 5xx, timeout, and oversized response.
- [ ] GREEN: Implement static fetch with short timeout, byte cap, redirect cap, and response metadata.
- [ ] RED: Add content-type handling tests for HTML, text/plain, application/json, and unknown content type.
- [ ] GREEN: Return bounded text for text/plain and JSON with truncation metadata.
- [ ] RED: Add tests proving auth headers/cookies are not sent.
- [ ] GREEN: Ensure no browser/user cookies or authenticated sessions are used.
- [ ] REFACTOR: Keep static fetch IO injectable for deterministic tests.

#### M4: HTML Extraction and Thinness Detection

- [ ] RED: Add extraction tests for title, main article content, boilerplate removal, links, code blocks, and malformed HTML.
- [ ] GREEN: Convert static HTML into readable bounded markdown/text.
- [ ] RED: Add thin-page detection tests for JS shell, empty body, blocker page, and low-content extraction.
- [ ] GREEN: Classify static results as usable, thin, blocked, or failed.
- [ ] RED: Add truncation tests for long pages.
- [ ] GREEN: Apply text-length caps with visible truncation metadata.
- [ ] REFACTOR: Keep extraction deterministic and independent of rendered backends.

### Gate 2 -> 3

- [ ] Static mode works without Jina or Firecrawl.
- [ ] Auto mode returns usable static content without spending external rendering calls.
- [ ] Thin/blocked pages are classified for fallback.
- [ ] Metadata includes final URL, status, content type, byte/text counts, backend, and truncation.

### Phase 3: Jina and Firecrawl Fallbacks

#### M5: Jina Reader Fallback

- [ ] RED: Add tests proving Jina is attempted only after static extraction is unusable in auto mode.
- [ ] GREEN: Implement direct Jina Reader request against the target URL after URL safety validation.
- [ ] RED: Add tests for Jina success, empty output, blocker output, rate limit, timeout, and error.
- [ ] GREEN: Normalize Jina results and errors into the result envelope.
- [ ] RED: Add cap/provenance tests for Jina output.
- [ ] GREEN: Apply byte/time/text caps and record Jina provenance.
- [ ] REFACTOR: Keep optional Jina API key support isolated if introduced.

#### M6: Firecrawl Final Fallback

- [ ] RED: Add tests proving Firecrawl is not called when static or Jina content is usable.
- [ ] GREEN: Gate Firecrawl behind `FIRECRAWL_API_KEY` and final-fallback conditions.
- [ ] RED: Add tests for missing key, SDK unavailable, rate limit, provider error, timeout, and success.
- [ ] GREEN: Return structured unavailable/error results when Firecrawl cannot run.
- [ ] RED: Add tests proving only markdown/main-content request shape is used.
- [ ] GREEN: Exclude search, crawl, map, extract/JSON, screenshots, actions, profiles, cookies, custom headers, enhanced proxy, and broad crawling.
- [ ] REFACTOR: Keep Firecrawl dependency optional and isolated.

### Gate 3 -> 4

- [ ] Auto ladder is static, then Jina, then Firecrawl.
- [ ] Firecrawl is not accidentally spent on ordinary pages.
- [ ] Missing or failing external backends return typed results.
- [ ] Backend attempts and provenance are visible in the result envelope.

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
