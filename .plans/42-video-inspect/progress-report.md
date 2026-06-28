# Video Inspect - Progress Report

## Summary

- **Current focus:** M1 - Provenance Snapshot
- **Completed:** 7 / 73
- **Current cutoff blockers:** 66
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0

## 0. Hard Dependencies

- [x] Existing V1 implementation found in `/Users/kevin/dev/trevor/packages/agent-host/src/tools/video-processor.ts`.
- [x] Existing V1 direct tool tests found in `/Users/kevin/dev/trevor/packages/agent-host/test/tools/core-video.test.ts`.
- [x] Existing V1 agent-loop finalization tests found in `/Users/kevin/dev/trevor/packages/agent-host/test/agent/loop-video-inspect.test.ts`.
- [x] Existing V1 provider continuation handling found in `/Users/kevin/dev/trevor/packages/agent-host/src/provider/provider-tool-results.ts`.
- [x] Existing V1 archive integration found in `media-processors.ts`, `core-archive.test.ts`, and the TUI archive/video history fixture.
- [x] `41-archive-tools` keeps archive media dispatch separate from direct `video_inspect` behavior.
- [x] `28-tool-detail-takeover` defines the transcript-detail pattern for inspecting richer tool output.

## Current Cutoff Blockers

### Phase 1: V1 Provenance and V2 Contract

#### M1: Provenance Snapshot

- [ ] RED: Add a contract/provenance test or fixture that captures V1 `video_inspect` input and output examples.
- [ ] GREEN: Document V1 behavior from `video-processor.ts`, `core-video.test.ts`, loop tests, provider tool-result encoding, and archive media dispatch.
- [ ] RED: Add V2 contract tests for normal output, unavailable output, malformed input, and bounded sampling parameters.
- [ ] GREEN: Define V2 input/output types and typed failure/unavailable result shapes.
- [ ] REFACTOR: Keep provenance notes separate from implementation so future differences are intentional.

#### M2: Metadata and Tool Policy

- [ ] RED: Add metadata tests for `video_inspect` effect, idempotence, persistence, approval, concurrency, child exposure, and context policy.
- [ ] GREEN: Register the direct tool schema and metadata in the V2 host surface.
- [ ] RED: Add prompt-guidance tests for when to use video inspection instead of shelling out or reading binary files.
- [ ] GREEN: Add concise guidance that `video_inspect` is for local video paths and bounded frame sampling.
- [ ] REFACTOR: Keep video guidance out of unrelated prompts unless the tool is available.

#### Gate 1->2

- [ ] V2 has explicit `video_inspect` schemas, result types, and unavailable/failure classes.
- [ ] V1 parity targets and intentional divergences are documented.
- [ ] Tool metadata makes the heavyweight/on-request nature of video inspection visible.

### Phase 2: Core Video Processor

#### M3: Binary Discovery and Metadata Probe

- [ ] RED: Add tests for missing ffmpeg, missing ffprobe, configured binary paths, and command discovery timeouts.
- [ ] GREEN: Implement binary discovery using default commands and `TREVOR_FFMPEG_PATH` / `TREVOR_FFPROBE_PATH`.
- [ ] RED: Add tests for metadata probe success, probe failure, no video stream, malformed probe JSON, cancellation, and timeout.
- [ ] GREEN: Implement metadata probing with typed degraded outputs where possible.
- [ ] REFACTOR: Keep command execution and result parsing isolated from tool orchestration.

#### M4: Frame Extraction

- [ ] RED: Add tests for synthetic video extraction with deterministic frame count, timestamps, dimensions, and truncation.
- [ ] GREEN: Implement bounded frame extraction into a run-scoped artifact directory.
- [ ] RED: Add tests for max frame caps, sample interval caps, extraction timeout, cancellation, unsupported media, and artifact write failure.
- [ ] GREEN: Return structured frame artifact refs and warnings/failures without leaking raw binary data into transcript text.
- [ ] REFACTOR: Keep artifact creation/cleanup reusable for archive media dispatch.

#### Gate 2->3

- [ ] Missing binaries return structured unavailable output.
- [ ] Local video inspection produces bounded frame artifacts.
- [ ] Command timeouts, cancellation, and artifact failures are typed and visible.

### Phase 3: Artifact Lifecycle and Archive Integration

#### M5: Artifact Lifecycle

- [ ] RED: Add tests proving direct video frame artifacts are run-scoped.
- [ ] GREEN: Store frame artifacts under the approved V2 run artifact/scratch location.
- [ ] RED: Add tests proving run cleanup removes generated frame artifacts.
- [ ] GREEN: Wire artifact cleanup into existing run disposal behavior.
- [ ] REFACTOR: Document what is durable transcript data versus ephemeral frame file data.

#### M6: Archive Media Dispatch

- [ ] RED: Add archive integration tests for video entries discovered inside zip archives.
- [ ] GREEN: Allow archive processors to delegate video entry frame extraction or summarize that extraction requires direct `video_inspect`, depending on V2 artifact constraints.
- [ ] RED: Add tests proving archive validation remains owned by archive tools and video extraction remains owned by video processor.
- [ ] GREEN: Preserve separate errors and warnings for archive safety versus video processor failures.
- [ ] REFACTOR: Keep direct `video_inspect` provider-loop semantics out of archive read unless explicitly invoked.

#### Gate 3->4

- [ ] Frame artifacts have a defined lifecycle and cleanup path.
- [ ] Archive video handling is integrated without merging archive and video responsibilities.
- [ ] Transcript/session data never depends on ephemeral frame files remaining forever.

### Phase 4: Provider Continuation and Host Loop

#### M7: Provider Tool-Result Encoding

- [ ] RED: Add provider continuation tests proving video tool results include serialized text plus frame image content.
- [ ] GREEN: Encode PNG/JPEG frame artifacts into provider-compatible image content with frame count caps.
- [ ] RED: Add tests for missing artifact files, unsupported frame MIME types, non-vision providers, and provider image-content limits.
- [ ] GREEN: Degrade to text-only result with warnings when images cannot be attached.
- [ ] REFACTOR: Keep provider-specific formatting behind provider adapters or a shared continuation codec.

#### M8: Agent Loop Finalization

- [ ] RED: Add loop tests proving the provider is forced into a direct answer pass after direct `video_inspect`.
- [ ] GREEN: Disable further visible tool use on the post-video continuation pass.
- [ ] RED: Add tests proving attempted follow-up tool calls after video inspection are suppressed or converted into hidden disabled feedback without visible churn.
- [ ] GREEN: Preserve final assistant response behavior and transcript event ordering.
- [ ] REFACTOR: Keep this special post-video behavior narrowly scoped to video frame artifact workflows.

#### Gate 4->5

- [ ] Video frames reach vision-capable provider continuations.
- [ ] Non-vision or frame-read failures degrade without blocking final text.
- [ ] Post-video loop behavior avoids repeated tool churn.

### Phase 5: UI, Detail View, and E2E

#### M9: Transcript Rendering

- [ ] RED: Add web fixtures/tests for video inspect success, unavailable, warning, extraction failure, and truncated rows.
- [ ] GREEN: Render concise video inspect rows with path label, sampled frame count, duration, dimensions, truncation, and warnings.
- [ ] RED: Add compact transcript tests for video inspect rows.
- [ ] GREEN: Add detail takeover for frames, timestamps, dimensions, warnings, and artifact availability.
- [ ] REFACTOR: Reuse transcript image rendering for frame thumbnails/previews.

#### M10: End-to-End Validation

- [ ] RED: Add hermetic e2e using a fake provider and synthetic video fixture when ffmpeg/ffprobe are available.
- [ ] GREEN: Make the e2e skip with a stated reason when ffmpeg/ffprobe are unavailable.
- [ ] RED: Add e2e coverage for unavailable binaries, provider frame feedback, final answer after video inspection, and transcript detail inspection.
- [ ] GREEN: Validate local video path inspection through the full model/tool/provider/transcript loop.
- [ ] REFACTOR: Add manual EZE checklist for local video, missing binaries, archive-contained video, compact row, and detail takeover.

#### Gate 5

- [ ] Unit, web, integration, and hermetic e2e tests pass.
- [ ] Local video inspection reaches a final assistant answer using frame artifacts when supported.
- [ ] Missing binaries and unsupported media fail or degrade visibly without breaking the whole turn.
- [ ] V1 parity is either achieved or documented as an intentional V2 divergence.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.

