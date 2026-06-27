# Web Fetch Tool - Implementation Plan

## Architecture

`web_fetch` is a host-owned read-only tool for fetching one explicit public URL into bounded, attributable markdown/text. It is the source-reading companion to the shipped `web_search` tool, not a search tool, browser automation surface, crawler, or authenticated browsing path. <!-- D-001 -->

The fetch ladder is:

1. Static HTTP fetch and deterministic extraction first. <!-- D-003 -->
2. Jina Reader direct fallback when static extraction is empty, thin, blocked, or unusable. <!-- D-004 -->
3. Firecrawl as final rendered-page fallback only when configured and still needed. <!-- D-005 -->

Every backend is behind a Trevor-owned URL safety guard and result cap. <!-- D-002 --> Backend failures degrade to typed results and Doctor diagnostics rather than failing the agent turn. <!-- D-007 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Explicit public URL only | One URL input; no search, clicking, crawling, auth, cookies, or browser session reuse. <!-- D-001 --> |
| URL safety guard | Reject unsupported schemes, userinfo, local/private/link-local/cloud metadata targets, and unsafe redirects before backend execution. <!-- D-002 --> |
| Static first | Auto mode tries static fetch/extraction first; static mode never calls external rendered backends. <!-- D-003 --> |
| Jina first fallback | Jina Reader is the first external recovery path for thin or JS-blocked pages. <!-- D-004 --> |
| Firecrawl last fallback | Firecrawl runs only when configured and only after static plus Jina cannot produce usable content, unless explicit rendered mode requires it. <!-- D-005 --> |
| Bounded Firecrawl scope | First cut requests markdown/main content only and excludes search/crawl/map/extract/screenshots/actions/profiles/cookies/headers/proxies. <!-- D-006 --> |
| Graceful degradation | Backend errors, rate limits, missing config, SDK absence, and timeouts return typed results. <!-- D-007 --> |
| Read-only scheduling | `web_fetch` is a read-only tool and can run concurrently with read/glob/grep/web_search. <!-- D-008 --> |

### Boundaries

Owned by this plan:

- `web_fetch` tool schema, result envelope, and model guidance
- URL safety guard and redirect validation
- static fetch and extraction
- direct Jina Reader fallback
- optional Firecrawl SDK integration
- backend provenance, truncation metadata, caps, and typed failure results
- Doctor web/fetch diagnostics and web transcript renderer

Not owned by this plan:

- `web_search` provider changes
- `docs` corpus caching
- authenticated browsing
- browser cookie/session reuse
- general page interaction
- site crawl/map/search/extract workflows
- screenshots or visual inspection

### Result Envelope

The model-facing output should be JSON like `web_search`, with fields the web can render and the model can cite:

- original URL
- final URL
- title when known
- content type
- HTTP status where available
- fetched time
- byte count
- text length
- truncation metadata
- backend used
- backend attempts and sanitized failure summaries
- markdown/text content

### Observability

`/doctor` reports fetch/rendering readiness: static path available, Jina configured/reachable when known, Firecrawl configured/unconfigured, and last sanitized backend errors. Logs include backend, URL host, status, bytes, caps, duration, and sanitized error category without storing fetched content by default.

## Phases

### Phase 1: Contract and Safety

**Goal:** The tool contract and URL safety model are stable before any backend fetches run.

**Gate from previous:** none.

#### M1: Tool Contract and Read-Only Registration

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add tool schema tests for URL, mode, caps, and optional output preferences.
  2. GREEN: Define `web_fetch` params with explicit URL and bounded mode/cap fields. <!-- D-001 -->
  3. RED: Add result-envelope tests for metadata, content, backend, attempts, truncation, and errors.
  4. GREEN: Define the structured JSON result envelope.
  5. RED: Add registry tests proving `web_fetch` is read-only.
  6. GREEN: Register `web_fetch` with `readOnly: true` and shared read-only tool metadata. <!-- D-008 -->
  7. REFACTOR: Keep tool schema flat and provider-compatible.

#### M2: URL Safety Guard

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add URL guard tests for unsupported schemes, malformed URLs, userinfo, loopback, private ranges, link-local, IPv6 local, and cloud metadata targets.
  2. GREEN: Implement URL normalization and preflight rejection. <!-- D-002 -->
  3. RED: Add redirect-chain tests for safe redirect, private redirect, scheme downgrade where disallowed, and redirect loop.
  4. GREEN: Validate every redirect hop before following or sending the target URL to a backend.
  5. RED: Add tests for hostnames resolving to private or link-local addresses where the runtime can check DNS.
  6. GREEN: Add DNS/IP safety checks where feasible with graceful unknown handling.
  7. REFACTOR: Make URL guard reusable by Jina, Firecrawl, and future docs fetching.

### Gate 1 -> 2

- [ ] `web_fetch` has a stable schema and result envelope.
- [ ] `web_fetch` is registered read-only.
- [ ] Unsafe direct URLs and unsafe redirects are blocked before any backend runs.
- [ ] URL guard is reusable by every backend path.

### Phase 2: Static Fetch and Extraction

**Goal:** Most pages are fetched through cheap static HTTP and deterministic extraction.

**Gate from previous:** Gate 1 passes.

#### M3: Static HTTP Fetch

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add static fetch tests for HTML, plain text, JSON, redirects, 404, 5xx, timeout, and oversized response.
  2. GREEN: Implement static fetch with short timeout, byte cap, redirect cap, and response metadata. <!-- D-003 -->
  3. RED: Add content-type handling tests for HTML, text/plain, application/json, and unknown content type.
  4. GREEN: Return bounded text for text/plain and JSON with truncation metadata.
  5. RED: Add tests proving auth headers/cookies are not sent.
  6. GREEN: Ensure no browser/user cookies or authenticated sessions are used. <!-- D-001 -->
  7. REFACTOR: Keep static fetch IO injectable for deterministic tests.

#### M4: HTML Extraction and Thinness Detection

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Add extraction tests for title, main article content, boilerplate removal, links, code blocks, and malformed HTML.
  2. GREEN: Convert static HTML into readable bounded markdown/text.
  3. RED: Add thin-page detection tests for JS shell, empty body, blocker page, and low-content extraction.
  4. GREEN: Classify static results as usable, thin, blocked, or failed.
  5. RED: Add truncation tests for long pages.
  6. GREEN: Apply text-length caps with visible truncation metadata.
  7. REFACTOR: Keep extraction deterministic and independent of rendered backends.

### Gate 2 -> 3

- [ ] Static mode works without Jina or Firecrawl.
- [ ] Auto mode returns usable static content without spending external rendering calls.
- [ ] Thin/blocked pages are classified for fallback.
- [ ] Metadata includes final URL, status, content type, byte/text counts, backend, and truncation.

### Phase 3: Jina and Firecrawl Fallbacks

**Goal:** Render-blocked or thin pages degrade through Jina first and Firecrawl last.

**Gate from previous:** Gate 2 passes.

#### M5: Jina Reader Fallback

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving Jina is attempted only after static extraction is unusable in auto mode.
  2. GREEN: Implement direct Jina Reader request against the target URL after URL safety validation. <!-- D-004 -->
  3. RED: Add tests for Jina success, empty output, blocker output, rate limit, timeout, and error.
  4. GREEN: Normalize Jina results and errors into the result envelope.
  5. RED: Add cap/provenance tests for Jina output.
  6. GREEN: Apply byte/time/text caps and record Jina provenance. <!-- D-004 -->
  7. REFACTOR: Keep optional Jina API key support isolated if introduced.

#### M6: Firecrawl Final Fallback

- **Dependencies:** M5
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving Firecrawl is not called when static or Jina content is usable.
  2. GREEN: Gate Firecrawl behind `FIRECRAWL_API_KEY` and final-fallback conditions. <!-- D-005 -->
  3. RED: Add tests for missing key, SDK unavailable, rate limit, provider error, timeout, and success.
  4. GREEN: Return structured unavailable/error results when Firecrawl cannot run. <!-- D-007 -->
  5. RED: Add tests proving only markdown/main-content request shape is used.
  6. GREEN: Exclude search, crawl, map, extract/JSON, screenshots, actions, profiles, cookies, custom headers, enhanced proxy, and broad crawling. <!-- D-006 -->
  7. REFACTOR: Keep Firecrawl dependency optional and isolated.

### Gate 3 -> 4

- [ ] Auto ladder is static, then Jina, then Firecrawl.
- [ ] Firecrawl is not accidentally spent on ordinary pages.
- [ ] Missing or failing external backends return typed results.
- [ ] Backend attempts and provenance are visible in the result envelope.

### Phase 4: Tool UX, Doctor, and Guidance

**Goal:** The model and web UI use `web_fetch` correctly and users can diagnose backend availability.

**Gate from previous:** Gate 3 passes.

#### M7: Prompt Guidance and Web Rendering

- **Dependencies:** M6
- **Effort:** S
- **Tasks:**
  1. RED: Add system-prompt/tool-guidance tests for web_search vs web_fetch selection.
  2. GREEN: Tell the model to use `web_search` for discovery and `web_fetch` for selected source reading. <!-- D-009 -->
  3. RED: Add prompt tests proving Firecrawl is described as scarce final fallback.
  4. GREEN: Add backend ladder guidance: static default, Jina for unusable static pages, Firecrawl last. <!-- D-009 -->
  5. RED: Add web renderer tests for `web_fetch` result envelope, truncation, backend attempts, and errors.
  6. GREEN: Render `web_fetch` results as flat source content, not as generic opaque JSON.
  7. REFACTOR: Reuse web_search visual patterns where they fit.

#### M8: Doctor and Diagnostics

- **Dependencies:** M7
- **Effort:** S
- **Tasks:**
  1. RED: Add Doctor tests for static available, Jina configured/unconfigured/error, Firecrawl configured/unconfigured/error, and last sanitized failures.
  2. GREEN: Wire web/fetch diagnostics into Doctor. <!-- D-007 -->
  3. RED: Add logging/redaction tests proving URLs, keys, headers, and response bodies are not leaked.
  4. GREEN: Log backend, host, status, duration, caps, and sanitized error categories only.
  5. RED: Add tests proving fetched content is not stored in debug logs by default.
  6. GREEN: Keep content only in tool result/session events.

### Gate 4 -> 5

- [ ] Prompt guidance distinguishes discovery from source reading.
- [ ] Web renders `web_fetch` results clearly.
- [ ] Doctor reports backend availability and sanitized failures.
- [ ] Logs redact secrets and avoid storing fetched content.

### Phase 5: Verification

**Goal:** `web_fetch` is fully covered across unit, integration, web, and e2e-style workflows.

**Gate from previous:** Gate 4 passes.

#### M9: Full Test and E2E Coverage

- **Dependencies:** M8
- **Effort:** M
- **Tasks:**
  1. RED: Add integration tests for `web_search` followed by `web_fetch` on a selected result.
  2. GREEN: Verify result content and provenance are model-visible and web-renderable.
  3. RED: Add tests for explicit rendered mode and Firecrawl absence.
  4. GREEN: Return graceful unavailable results when rendered content is required but Firecrawl is unavailable. <!-- D-007 -->
  5. RED: Add prompt regression tests proving ordinary static pages do not call Firecrawl.
  6. GREEN: Tune guidance and backend selection accordingly. <!-- D-009 -->
  7. GREEN: Run lint, typecheck, unit, integration, web, and hermetic e2e lanes.
  8. GREEN: Manual EZE repro: search for a source, fetch a selected URL, verify static content; fetch a thin page with Jina fallback; verify Firecrawl absence is graceful.
  9. REFACTOR: Record exact verification commands and backend config in the progress report.

### Done Gate

- [ ] `web_fetch` reads one explicit safe public URL.
- [ ] Static fetch succeeds for ordinary pages.
- [ ] Jina fallback runs only when static is unusable.
- [ ] Firecrawl is last, optional, bounded, and not accidentally spent.
- [ ] Results include attribution, metadata, backend provenance, and truncation.
- [ ] Full verification passes.

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| SSRF/local metadata fetch | high | medium | URL safety guard before fetch and every redirect/backend call. <!-- D-002 --> | implementer |
| Accidental Firecrawl cost | medium | medium | Static first, Jina second, Firecrawl final only with tests proving call order. <!-- D-005 --> | implementer |
| Third-party URL leakage | medium | medium | Jina/Firecrawl only after safety guard, with provenance and guidance. <!-- D-004 --> | implementer |
| Tool result context bloat | medium | high | Byte/text/time caps and truncation metadata. | implementer |
| Authenticated/private browsing expectations | medium | medium | Explicitly reject cookies/auth/session reuse and document public URL-only scope. <!-- D-001 --> | implementer |
| Backend failures collapse turns | medium | medium | Typed degraded results and Doctor diagnostics. <!-- D-007 --> | implementer |

## Escape Hatches

1. **If Firecrawl SDK integration is unstable:** ship static plus Jina and report Firecrawl unavailable until the optional integration is ready.
2. **If HTML extraction quality is weak:** return bounded raw text with metadata and classify low confidence, then let Jina handle thin/blocked pages.
3. **If DNS safety checks are unreliable in tests:** keep deterministic URL/IP literal blocking and isolate DNS checks behind injectable IO.

## Progress Report Accounting

The progress report is the implementation resume state. It must distinguish current cutoff blockers from deferred follow-up and superseded checklist debt.

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "web-fetch-tool"
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

Canonical decisions are in `.plans/web-fetch-tool/plan.db`. Query them with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "web-fetch-tool"
```
