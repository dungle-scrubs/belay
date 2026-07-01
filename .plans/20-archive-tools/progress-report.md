# Archive Tools - Progress Report

## Summary

- **Current focus:** Complete - archive tools implemented
- **Completed:** 77 / 77
- **Current cutoff blockers:** 0
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0

## 0. Hard Dependencies

- [x] Existing V1 implementation found in `/Users/kevin/dev/trevor/packages/agent-host/src/tools/archive-tool.ts`.
- [x] Existing V1 validators/processors found through `archive-validators.ts`, `media-processors.ts`, tool metadata, provider context, and runtime normalization.
- [x] Existing V1 archive tests found in `/Users/kevin/dev/trevor/packages/agent-host/test/tools/core-archive.test.ts`.
- [x] Existing V1 transcript/history fixture found in `/Users/kevin/dev/trevor/tui/test/fixtures/archive_tool_history_host.mjs`.
- [x] `03-filesystem-root-taxonomy` defines where scratch, durable state, debug output, and legacy shared service data belong.
- [x] `08-tool-detail-takeover` defines the transcript-detail pattern for inspecting richer tool output.

## Current Cutoff Blockers

### Phase 1: V1 Provenance and V2 Contract

#### M1: Provenance Snapshot

- [x] RED: Add a plan-era fixture or documentation test that captures the V1 `archive_read` and `archive_unpack` public contract.
- [x] GREEN: Summarize V1 behavior from `archive-tool.ts`, validators, processors, metadata, runtime normalization, and `core-archive.test.ts`.
- [x] RED: Add tests proving V2 contract examples cover local read, URL read, include filters, unpack, and validation failures.
- [x] GREEN: Define V2 tool input/output shapes and failure classes.
- [x] REFACTOR: Keep V1 provenance notes in the plan/docs so later implementers know what is parity and what is intentional divergence.

#### M2: Safety Model

- [x] RED: Add validator tests for absolute paths, parent traversal, unsafe normalized names, duplicate/conflicting names, symlinks, and writes outside destination.
- [x] GREEN: Implement V2 archive entry normalization and destination validation.
- [x] RED: Add limit tests for archive bytes, expanded bytes, entry count, text preview budget, compression ratio, and unsupported/encrypted archives.
- [x] GREEN: Implement bounded archive limit enforcement with typed errors and visible warnings.
- [x] REFACTOR: Keep validator code independent from host tool orchestration.

#### Gate 1->2

- [x] V2 has explicit tool schemas and typed failure classes for archive tools.
- [x] V1 parity targets and intentional divergences are documented.
- [x] Safety validators are unit-tested before tool execution wiring.

### Phase 2: `archive_read`

#### M3: Local Zip Reader

- [x] RED: Add tests for reading local zip paths without network access.
- [x] GREEN: Implement zip parsing over local files using a parser/library path, not shell `unzip`.
- [x] RED: Add tests for directory entries, nested paths, include filters, empty archives, large entry counts, and malformed zip input.
- [x] GREEN: Return bounded manifest entries with path, original path, compressed bytes, expanded bytes, processor result, and warnings.
- [x] REFACTOR: Separate source loading, zip parsing, selection, and result shaping.

#### M4: Processors and Artifacts

- [x] RED: Add tests for text previews, binary manifest fallback, image metadata/artifact refs where supported, and processor failure warnings.
- [x] GREEN: Port/adapt V1 media processor behavior to V2 artifact/session boundaries.
- [x] RED: Add tests for text preview budget exhaustion across many archive entries.
- [x] GREEN: Summarize or omit large previews while preserving manifest metadata.
- [x] REFACTOR: Keep rich media display concerns in transcript/artifact renderers rather than archive execution.

#### M5: Remote Archive Source

- [x] RED: Add tests for approved URL reads, invalid URLs, private/local network addresses, redirects, oversized downloads, timeout, and cancellation.
- [x] GREEN: Implement remote archive download through approved V2 network policy/fetch boundary.
- [x] RED: Add tests proving remote temporary bytes use OS temp/scratch behavior and never durable Trevor roots.
- [x] GREEN: Stage remote bytes safely and delete scratch data after execution.
- [x] REFACTOR: Share remote-fetch constraints with the web-fetch tool where practical.

#### Gate 2->3

- [x] `archive_read` handles local zip paths safely.
- [x] Remote archive reads are policy-governed and bounded.
- [x] Processor output is visible, capped, and artifact-aware.

### Phase 3: `archive_unpack`

#### M6: Destination Extraction

- [x] RED: Add tests for extracting selected entries into a destination directory.
- [x] GREEN: Implement `archive_unpack` for local zip paths with include filters.
- [x] RED: Add tests for overwrite behavior, existing directories, nested directories, unsafe paths, and writes outside destination.
- [x] GREEN: Enforce destination containment and return extracted relative paths plus absolute destination root.
- [x] REFACTOR: Keep extraction separate from read-only manifest processing.

#### M7: Approval and Mutation Semantics

- [x] RED: Add tests proving `archive_unpack` is classified as a mutating filesystem tool and `archive_read` is not.
- [x] GREEN: Wire metadata, approval policy, concurrency policy, and child-tool exposure rules.
- [x] RED: Add tests for cancellation before and during extraction.
- [x] GREEN: Make partial extraction behavior explicit and observable.
- [x] REFACTOR: Ensure failed extraction never reports success and exposes enough detail to recover manually.

#### Gate 3->4

- [x] `archive_unpack` writes only to explicit validated destinations.
- [x] Mutation/approval metadata is correct.
- [x] Partial failures and cancellation are typed and visible.

### Phase 4: Host, Prompt, and Protocol Integration

#### M8: Tool Runtime Integration

- [x] RED: Add host tool runtime tests for normalizing `archive_read` and `archive_unpack` calls.
- [x] GREEN: Register archive tools in the V2 host tool registry.
- [x] RED: Add loop tests for provider-issued archive tool calls, success, typed failure, and cancellation.
- [x] GREEN: Emit normal tool started/progress/completed/failed events.
- [x] REFACTOR: Keep archive tool execution consistent with other host-owned tools.

#### M9: Prompt Guidance and Tool Metadata

- [x] RED: Add prompt/context tests for archive tool descriptions and usage guidance.
- [x] GREEN: Teach the model to use `archive_read` for local zip inspection before shell fallback.
- [x] RED: Add tests that `archive_unpack` guidance requires explicit destination and selected extraction intent.
- [x] GREEN: Add metadata for effect, idempotence, persistence, concurrency, approval, and context policy.
- [x] REFACTOR: Keep archive guidance concise so it does not bloat every prompt.

#### Gate 4->5

- [x] Provider-issued archive tool calls run through the V2 host loop.
- [x] Prompt/tool metadata guides local zip reads and explicit extraction correctly.
- [x] Tool events and failures match existing transcript expectations.

### Phase 5: UI, Detail View, and E2E

#### M10: Transcript Rendering

- [x] RED: Add web fixtures/tests for archive read success, read warning, read failure, unpack success, and unpack failure rows.
- [x] GREEN: Render concise archive result rows with source, entry count, byte counts, warnings, and selected entries.
- [x] RED: Add compact transcript tests for archive rows.
- [x] GREEN: Add archive tool detail views for manifest entries, previews, processor results, warnings, and extracted entries.
- [x] REFACTOR: Reuse existing transcript/tool-detail primitives instead of bespoke archive panels.

#### M11: End-to-End Validation

- [x] RED: Add hermetic e2e for asking the model what is inside a local zip and verifying `archive_read` is used.
- [x] GREEN: Make the hermetic e2e pass with a deterministic fake provider and temp zip fixture.
- [x] RED: Add hermetic e2e for extracting selected entries to a temp destination via `archive_unpack`.
- [x] GREEN: Verify files land in the destination and unsafe entries are rejected.
- [x] REFACTOR: Add manual EZE checklist for local zip, remote approved zip, failed unsafe zip, transcript compact row, and detail view.

#### Gate 5

- [x] Unit, web, integration, and hermetic e2e tests pass.
- [x] Local zip read and selected unpack work through the full model/tool/transcript loop.
- [x] Unsafe archives fail closed with visible typed errors.
- [x] V1 parity is either achieved or documented as an intentional V2 divergence.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.
