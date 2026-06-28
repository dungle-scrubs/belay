# Archive Tools - Implementation Plan

## 0. Hard Dependencies

- [x] Existing V1 implementation found in `/Users/kevin/dev/trevor/packages/agent-host/src/tools/archive-tool.ts`.
- [x] Existing V1 validators/processors found through `archive-validators.ts`, `media-processors.ts`, tool metadata, provider context, and runtime normalization.
- [x] Existing V1 archive tests found in `/Users/kevin/dev/trevor/packages/agent-host/test/tools/core-archive.test.ts`.
- [x] Existing V1 transcript/history fixture found in `/Users/kevin/dev/trevor/tui/test/fixtures/archive_tool_history_host.mjs`.
- [x] `03-filesystem-root-taxonomy` defines where scratch, durable state, debug output, and legacy shared service data belong.
- [x] `28-tool-detail-takeover` defines the transcript-detail pattern for inspecting richer tool output.

## 1. Architecture

Archive tools let the model inspect and selectively extract zip archives without shelling out to `unzip` as the first path. V2 should bring forward V1's `archive_read` and `archive_unpack` behavior as a port/reference, not a copy-paste obligation. The core contract remains:

- `archive_read(path|url, include?, processors?, video?)` inspects a local zip path or approved URL and returns a bounded manifest, safe previews, metadata, and artifact references without writing into the workspace.
- `archive_unpack(path, destination, include?)` extracts selected entries from a local zip archive into an explicit destination after validating destination and entry safety.

The first implementation target is zip parity with V1. Tar/tgz can stay outside the first cut unless V1 provenance or user demand proves it is required for this plan. <!-- D-001 -->

V1 already solved a useful slice: bounded download/read sizes, zip entry parsing, entry limits, expanded-byte limits, include filters, text preview budgets, entry normalization, explicit extraction destination checks, URL validation, private/local network guards, and media processors. V2 should preserve those safety ideas while adapting them to current host boundaries, storage taxonomy, Effect/runtime patterns, protocol events, transcript rendering, and e2e expectations. <!-- D-002 -->

`archive_read` is read-only from Trevor's perspective even when it downloads a remote archive into scratch. Remote reads must use approved web/network policy and explicit URL validation rather than arbitrary fetch behavior hidden inside the tool. `archive_unpack` is mutating and must remain explicit, visible, and constrained to a safe destination. <!-- D-003 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Zip first | Match the known V1 capability before expanding archive formats. |
| No shell-first implementation | Use a parser/library path so safety checks are owned by Trevor, not best-effort shell output parsing. |
| Read vs write separation | `archive_read` never writes to the workspace; `archive_unpack` writes only to the explicit validated destination. |
| Bounded inputs and outputs | Enforce archive byte caps, expanded byte caps, entry count caps, preview budgets, and result summarization. |
| Zip-slip hardening | Reject absolute paths, parent traversal, unsafe normalized names, unsafe symlinks, and writes outside destination. |
| Network policy | URL archive reads go through approved fetch/network rules and reject private/local addresses unless policy says otherwise. |
| Visible transcript result | Tool output appears as a visible result, supports compact rows, and can open a detail view for full manifest/process output. |
| Scratch policy | Temporary downloads/extraction staging use OS temp, not `TREVOR_HOME` or new dot-directories. |

### Boundaries

- `apps/agent-host` owns archive tool execution, validation, prompt/tool schema, safety policy, diagnostics, and conversion from V1 behavior to V2 runtime patterns.
- `packages/session` owns any protocol/read-model additions needed to represent archive tool calls/results in the transcript.
- `apps/web` owns visible transcript rows, compact rows, and tool-detail rendering for manifests, previews, warnings, and extracted entries.
- `03-filesystem-root-taxonomy` remains authoritative for scratch and durable path decisions.
- `04-web-fetch-tool` or the existing host network policy owns shared remote-fetch behavior; archive URL reads should not create a parallel ungoverned network stack.
- `35-transcript-image-rendering` and future video inspection own rich media display; archive tools may produce artifact refs and metadata that those surfaces can render.

### Observability

Archive tools should expose enough structured diagnostics to debug safety failures without dumping archive contents:

- tool spans include source kind, source hash/path label, archive byte count, expanded byte count, selected entry count, include pattern count, processor list, and duration;
- validation failures carry typed classes such as unsafe entry path, entry limit exceeded, expanded byte limit exceeded, download limit exceeded, unsupported compression, encrypted archive, private URL, and processor failure;
- visible tool results include warnings for preview truncation, skipped entries, unsupported files, and safety rejections;
- remote reads record URL host and policy decision without logging credentials or full sensitive query strings;
- extraction results list extracted relative paths and destination root, not hidden filesystem writes.

## 2. Current State

The V2 umbrella plan carries H-114 as "Archive tools" with `archive_read / archive_unpack + validators / media processors`. This plan extracts that backlog item.

V1 has a real implementation, not just a prompt stub. The main implementation is `/Users/kevin/dev/trevor/packages/agent-host/src/tools/archive-tool.ts`, with metadata and schema in V1 provider/tool files, runtime normalization in V1 tool runtime, and a large test suite in `core-archive.test.ts`. V1 also has a TUI fixture that emits deterministic `archive_read` and `video_inspect` rows for history rendering.

V1 implementation details worth preserving:

- `archive_read` accepts either `path` or `url`.
- `archive_unpack` accepts a local `path`, explicit `destination`, and optional include/limit controls.
- default caps exist for download bytes, expanded bytes, entry count, and text preview budget.
- local archive reads avoid network fetches.
- include patterns can select subsets of archive entries.
- read output includes source, archive bytes, expanded bytes, entries, and warnings.
- unpack output includes source, destination, archive bytes, expanded bytes, and extracted entries.
- media processors can summarize text and produce media artifacts.

V2 currently does not have this extracted as an active implementation plan. The feature should remain later-sequenced until dependencies and higher-priority transcript/tool plans are implemented.

## 3. Phases

### Phase 1: V1 Provenance and V2 Contract

**Goal:** Convert V1's archive behavior into a V2 contract and test target without importing stale assumptions.

**Gate from previous:** H-114 has been extracted from the umbrella plan.

#### M1: Provenance Snapshot

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add a plan-era fixture or documentation test that captures the V1 `archive_read` and `archive_unpack` public contract.
  2. GREEN: Summarize V1 behavior from `archive-tool.ts`, validators, processors, metadata, runtime normalization, and `core-archive.test.ts`.
  3. RED: Add tests proving V2 contract examples cover local read, URL read, include filters, unpack, and validation failures.
  4. GREEN: Define V2 tool input/output shapes and failure classes.
  5. REFACTOR: Keep V1 provenance notes in the plan/docs so later implementers know what is parity and what is intentional divergence.

#### M2: Safety Model

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add validator tests for absolute paths, parent traversal, unsafe normalized names, duplicate/conflicting names, symlinks, and writes outside destination.
  2. GREEN: Implement V2 archive entry normalization and destination validation.
  3. RED: Add limit tests for archive bytes, expanded bytes, entry count, text preview budget, compression ratio, and unsupported/encrypted archives.
  4. GREEN: Implement bounded archive limit enforcement with typed errors and visible warnings.
  5. REFACTOR: Keep validator code independent from host tool orchestration.

### Gate 1->2

- [ ] V2 has explicit tool schemas and typed failure classes for archive tools.
- [ ] V1 parity targets and intentional divergences are documented.
- [ ] Safety validators are unit-tested before tool execution wiring.

### Phase 2: `archive_read`

**Goal:** V2 can inspect local zip archives and approved remote zip archives without writing into the workspace.

**Gate from previous:** Safety model and contract are defined.

#### M3: Local Zip Reader

- **Dependencies:** M2
- **Effort:** L
- **Tasks:**
  1. RED: Add tests for reading local zip paths without network access.
  2. GREEN: Implement zip parsing over local files using a parser/library path, not shell `unzip`.
  3. RED: Add tests for directory entries, nested paths, include filters, empty archives, large entry counts, and malformed zip input.
  4. GREEN: Return bounded manifest entries with path, original path, compressed bytes, expanded bytes, processor result, and warnings.
  5. REFACTOR: Separate source loading, zip parsing, selection, and result shaping.

#### M4: Processors and Artifacts

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for text previews, binary manifest fallback, image metadata/artifact refs where supported, and processor failure warnings.
  2. GREEN: Port/adapt V1 media processor behavior to V2 artifact/session boundaries.
  3. RED: Add tests for text preview budget exhaustion across many archive entries.
  4. GREEN: Summarize or omit large previews while preserving manifest metadata.
  5. REFACTOR: Keep rich media display concerns in transcript/artifact renderers rather than archive execution.

#### M5: Remote Archive Source

- **Dependencies:** M2, M3
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for approved URL reads, invalid URLs, private/local network addresses, redirects, oversized downloads, timeout, and cancellation.
  2. GREEN: Implement remote archive download through approved V2 network policy/fetch boundary.
  3. RED: Add tests proving remote temporary bytes use OS temp/scratch behavior and never durable Trevor roots.
  4. GREEN: Stage remote bytes safely and delete scratch data after execution.
  5. REFACTOR: Share remote-fetch constraints with the web-fetch tool where practical.

### Gate 2->3

- [ ] `archive_read` handles local zip paths safely.
- [ ] Remote archive reads are policy-governed and bounded.
- [ ] Processor output is visible, capped, and artifact-aware.

### Phase 3: `archive_unpack`

**Goal:** V2 can extract selected local zip entries into an explicit destination without unsafe writes.

**Gate from previous:** Zip parsing and validators are stable.

#### M6: Destination Extraction

- **Dependencies:** M2, M3
- **Effort:** L
- **Tasks:**
  1. RED: Add tests for extracting selected entries into a destination directory.
  2. GREEN: Implement `archive_unpack` for local zip paths with include filters.
  3. RED: Add tests for overwrite behavior, existing directories, nested directories, unsafe paths, and writes outside destination.
  4. GREEN: Enforce destination containment and return extracted relative paths plus absolute destination root.
  5. REFACTOR: Keep extraction separate from read-only manifest processing.

#### M7: Approval and Mutation Semantics

- **Dependencies:** M6
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving `archive_unpack` is classified as a mutating filesystem tool and `archive_read` is not.
  2. GREEN: Wire metadata, approval policy, concurrency policy, and child-tool exposure rules.
  3. RED: Add tests for cancellation before and during extraction.
  4. GREEN: Make partial extraction behavior explicit and observable.
  5. REFACTOR: Ensure failed extraction never reports success and exposes enough detail to recover manually.

### Gate 3->4

- [ ] `archive_unpack` writes only to explicit validated destinations.
- [ ] Mutation/approval metadata is correct.
- [ ] Partial failures and cancellation are typed and visible.

### Phase 4: Host, Prompt, and Protocol Integration

**Goal:** The model can call archive tools through the normal V2 tool loop and users can see what happened.

**Gate from previous:** Core read/unpack behavior works in isolation.

#### M8: Tool Runtime Integration

- **Dependencies:** M3, M6
- **Effort:** L
- **Tasks:**
  1. RED: Add host tool runtime tests for normalizing `archive_read` and `archive_unpack` calls.
  2. GREEN: Register archive tools in the V2 host tool registry.
  3. RED: Add loop tests for provider-issued archive tool calls, success, typed failure, and cancellation.
  4. GREEN: Emit normal tool started/progress/completed/failed events.
  5. REFACTOR: Keep archive tool execution consistent with other host-owned tools.

#### M9: Prompt Guidance and Tool Metadata

- **Dependencies:** M8
- **Effort:** S
- **Tasks:**
  1. RED: Add prompt/context tests for archive tool descriptions and usage guidance.
  2. GREEN: Teach the model to use `archive_read` for local zip inspection before shell fallback.
  3. RED: Add tests that `archive_unpack` guidance requires explicit destination and selected extraction intent.
  4. GREEN: Add metadata for effect, idempotence, persistence, concurrency, approval, and context policy.
  5. REFACTOR: Keep archive guidance concise so it does not bloat every prompt.

### Gate 4->5

- [ ] Provider-issued archive tool calls run through the V2 host loop.
- [ ] Prompt/tool metadata guides local zip reads and explicit extraction correctly.
- [ ] Tool events and failures match existing transcript expectations.

### Phase 5: UI, Detail View, and E2E

**Goal:** Archive results are inspectable, compactable, and validated end to end.

**Gate from previous:** Host tool events exist and carry bounded result data.

#### M10: Transcript Rendering

- **Dependencies:** M8, `28-tool-detail-takeover`
- **Effort:** M
- **Tasks:**
  1. RED: Add web fixtures/tests for archive read success, read warning, read failure, unpack success, and unpack failure rows.
  2. GREEN: Render concise archive result rows with source, entry count, byte counts, warnings, and selected entries.
  3. RED: Add compact transcript tests for archive rows.
  4. GREEN: Add archive tool detail views for manifest entries, previews, processor results, warnings, and extracted entries.
  5. REFACTOR: Reuse existing transcript/tool-detail primitives instead of bespoke archive panels.

#### M11: End-to-End Validation

- **Dependencies:** M8, M10
- **Effort:** L
- **Tasks:**
  1. RED: Add hermetic e2e for asking the model what is inside a local zip and verifying `archive_read` is used.
  2. GREEN: Make the hermetic e2e pass with a deterministic fake provider and temp zip fixture.
  3. RED: Add hermetic e2e for extracting selected entries to a temp destination via `archive_unpack`.
  4. GREEN: Verify files land in the destination and unsafe entries are rejected.
  5. REFACTOR: Add manual EZE checklist for local zip, remote approved zip, failed unsafe zip, transcript compact row, and detail view.

### Gate 5

- [ ] Unit, web, integration, and hermetic e2e tests pass.
- [ ] Local zip read and selected unpack work through the full model/tool/transcript loop.
- [ ] Unsafe archives fail closed with visible typed errors.
- [ ] V1 parity is either achieved or documented as an intentional V2 divergence.

## 4. Validation Matrix

| Scenario | Expected |
|----------|----------|
| Local zip read | No network access; manifest and previews returned. |
| URL zip read | Approved network path only; bounded download; private/local targets rejected. |
| Include filter | Only matching entries are processed or extracted. |
| Large archive | Entry/byte/preview caps trigger typed warnings or failures. |
| Zip slip | Unsafe entries fail closed before workspace writes. |
| Unpack selected entries | Only requested safe entries land under destination. |
| Processor failure | Tool returns safe manifest plus warning when possible. |
| Transcript compact mode | Archive tool row collapses to one informative line. |
| Detail takeover | Manifest, warnings, previews, and extracted entries are inspectable. |

## 5. Non-Goals

- General archive format support beyond zip in the first cut.
- Hidden output caching for archive tool results.
- Replacing `video_inspect`; archive tools may expose media artifacts, but video frame inspection remains a separate capability.
- Extracting archives without an explicit destination.
- Adding new Trevor-owned storage roots.

