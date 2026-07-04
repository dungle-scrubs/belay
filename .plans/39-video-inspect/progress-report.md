# Video Inspect - Progress Report

## Summary

- **Current focus:** Done - all milestones landed
- **Completed:** 73 / 73
- **Current cutoff blockers:** 0
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0

## 0. Hard Dependencies

- [x] Existing V1 implementation found in `/Users/kevin/dev/trevor/packages/agent-host/src/tools/video-processor.ts`.
- [x] Existing V1 direct tool tests found in `/Users/kevin/dev/trevor/packages/agent-host/test/tools/core-video.test.ts`.
- [x] Existing V1 agent-loop finalization tests found in `/Users/kevin/dev/trevor/packages/agent-host/test/agent/loop-video-inspect.test.ts`.
- [x] Existing V1 provider continuation handling found in `/Users/kevin/dev/trevor/packages/agent-host/src/provider/provider-tool-results.ts`.
- [x] Existing V1 archive integration found in `media-processors.ts`, `core-archive.test.ts`, and the TUI archive/video history fixture.
- [x] `20-archive-tools` keeps archive media dispatch separate from direct `video_inspect` behavior.
- [x] `08-tool-detail-takeover` defines the transcript-detail pattern for inspecting richer tool output.

## Current Cutoff Blockers

None - all milestones complete.

### Phase 1: V1 Provenance and V2 Contract

#### M1: Provenance Snapshot

- [x] RED: Add a contract/provenance test or fixture that captures V1 `video_inspect` input and output examples.
- [x] GREEN: Document V1 behavior from `video-processor.ts`, `core-video.test.ts`, loop tests, provider tool-result encoding, and archive media dispatch.
- [x] RED: Add V2 contract tests for normal output, unavailable output, malformed input, and bounded sampling parameters.
- [x] GREEN: Define V2 input/output types and typed failure/unavailable result shapes.
- [x] REFACTOR: Keep provenance notes separate from implementation so future differences are intentional.

#### M2: Metadata and Tool Policy

- [x] RED: Add metadata tests for `video_inspect` effect, idempotence, persistence, approval, concurrency, child exposure, and context policy.
- [x] GREEN: Register the direct tool schema and metadata in the V2 host surface.
- [x] RED: Add prompt-guidance tests for when to use video inspection instead of shelling out or reading binary files.
- [x] GREEN: Add concise guidance that `video_inspect` is for local video paths and bounded frame sampling.
- [x] REFACTOR: Keep video guidance out of unrelated prompts unless the tool is available.

#### Gate 1->2

- [x] V2 has explicit `video_inspect` schemas, result types, and unavailable/failure classes.
- [x] V1 parity targets and intentional divergences are documented.
- [x] Tool metadata makes the heavyweight/on-request nature of video inspection visible.

### Phase 2: Core Video Processor

#### M3: Binary Discovery and Metadata Probe

- [x] RED: Add tests for missing ffmpeg, missing ffprobe, configured binary paths, and command discovery timeouts.
- [x] GREEN: Implement binary discovery using default commands and `TREVOR_FFMPEG_PATH` / `TREVOR_FFPROBE_PATH`.
- [x] RED: Add tests for metadata probe success, probe failure, no video stream, malformed probe JSON, cancellation, and timeout.
- [x] GREEN: Implement metadata probing with typed degraded outputs where possible.
- [x] REFACTOR: Keep command execution and result parsing isolated from tool orchestration.

#### M4: Frame Extraction

- [x] RED: Add tests for synthetic video extraction with deterministic frame count, timestamps, dimensions, and truncation.
- [x] GREEN: Implement bounded frame extraction into a run-scoped artifact directory.
- [x] RED: Add tests for max frame caps, sample interval caps, extraction timeout, cancellation, unsupported media, and artifact write failure.
- [x] GREEN: Return structured frame artifact refs and warnings/failures without leaking raw binary data into transcript text.
- [x] REFACTOR: Keep artifact creation/cleanup reusable for archive media dispatch.

#### Gate 2->3

- [x] Missing binaries return structured unavailable output.
- [x] Local video inspection produces bounded frame artifacts.
- [x] Command timeouts, cancellation, and artifact failures are typed and visible.

### Phase 3: Artifact Lifecycle and Archive Integration

#### M5: Artifact Lifecycle

- [x] RED: Add tests proving direct video frame artifacts are run-scoped.
- [x] GREEN: Store frame artifacts under the approved V2 run artifact/scratch location.
- [x] RED: Add tests proving run cleanup removes generated frame artifacts.
- [x] GREEN: Wire artifact cleanup into existing run disposal behavior.
- [x] REFACTOR: Document what is durable transcript data versus ephemeral frame file data.

#### M6: Archive Media Dispatch

- [x] RED: Add archive integration tests for video entries discovered inside zip archives.
- [x] GREEN: Allow archive processors to delegate video entry frame extraction or summarize that extraction requires direct `video_inspect`, depending on V2 artifact constraints.
- [x] RED: Add tests proving archive validation remains owned by archive tools and video extraction remains owned by video processor.
- [x] GREEN: Preserve separate errors and warnings for archive safety versus video processor failures.
- [x] REFACTOR: Keep direct `video_inspect` provider-loop semantics out of archive read unless explicitly invoked.

#### Gate 3->4

- [x] Frame artifacts have a defined lifecycle and cleanup path.
- [x] Archive video handling is integrated without merging archive and video responsibilities.
- [x] Transcript/session data never depends on ephemeral frame files remaining forever.

### Phase 4: Provider Continuation and Host Loop

#### M7: Provider Tool-Result Encoding

- [x] RED: Add provider continuation tests proving video tool results include serialized text plus frame image content.
- [x] GREEN: Encode PNG/JPEG frame artifacts into provider-compatible image content with frame count caps.
- [x] RED: Add tests for missing artifact files, unsupported frame MIME types, non-vision providers, and provider image-content limits.
- [x] GREEN: Degrade to text-only result with warnings when images cannot be attached.
- [x] REFACTOR: Keep provider-specific formatting behind provider adapters or a shared continuation codec.

#### M8: Agent Loop Finalization

- [x] RED: Add loop tests proving the provider is forced into a direct answer pass after direct `video_inspect`.
- [x] GREEN: Disable further visible tool use on the post-video continuation pass.
- [x] RED: Add tests proving attempted follow-up tool calls after video inspection are suppressed or converted into hidden disabled feedback without visible churn.
- [x] GREEN: Preserve final assistant response behavior and transcript event ordering.
- [x] REFACTOR: Keep this special post-video behavior narrowly scoped to video frame artifact workflows.

#### Gate 4->5

- [x] Video frames reach vision-capable provider continuations.
- [x] Non-vision or frame-read failures degrade without blocking final text.
- [x] Post-video loop behavior avoids repeated tool churn.

### Phase 5: UI, Detail View, and E2E

#### M9: Transcript Rendering

- [x] RED: Add web fixtures/tests for video inspect success, unavailable, warning, extraction failure, and truncated rows.
- [x] GREEN: Render concise video inspect rows with path label, sampled frame count, duration, dimensions, truncation, and warnings.
- [x] RED: Add compact transcript tests for video inspect rows.
- [x] GREEN: Add detail takeover for frames, timestamps, dimensions, warnings, and artifact availability.
- [x] REFACTOR: Reuse transcript image rendering for frame thumbnails/previews.

#### M10: End-to-End Validation

- [x] RED: Add hermetic e2e using a fake provider and synthetic video fixture when ffmpeg/ffprobe are available.
- [x] GREEN: Make the e2e skip with a stated reason when ffmpeg/ffprobe are unavailable.
- [x] RED: Add e2e coverage for unavailable binaries, provider frame feedback, final answer after video inspection, and transcript detail inspection.
- [x] GREEN: Validate local video path inspection through the full model/tool/provider/transcript loop.
- [x] REFACTOR: Add manual EZE checklist for local video, missing binaries, archive-contained video, compact row, and detail takeover.

#### Gate 5

- [x] Unit, web, integration, and hermetic e2e tests pass.
- [x] Local video inspection reaches a final assistant answer using frame artifacts when supported.
- [x] Missing binaries and unsupported media fail or degrade visibly without breaking the whole turn.
- [x] V1 parity is either achieved or documented as an intentional V2 divergence.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.

## Intentional V2 Divergences from V1

- **Frame storage is content-addressed blobs, not a run-scoped disk directory.** V1 wrote frame
  PNGs into a per-run artifact directory and returned a disk `artifactPath`, cleaned up on run
  disposal. V2 stores each frame in the content-addressed blob store (durable, deduped, shareable
  by hash) and returns an `ArtifactRef`; ffmpeg's raw PNG output lives only briefly in a `tmpdir`
  transcode dir that is removed immediately after upload. So "run cleanup" (M5) means the ephemeral
  transcode dir is torn down per call, while the durable transcript data is the immutable
  ArtifactRef - the transcript never depends on a frame file remaining on disk.
- **Cancellation is surfaced through a typed `VideoCancelledError` on the core function's signal
  seam.** V2 tools receive no `AbortSignal` through `ToolContext` (cancellation is fiber
  interruption), so the tool passes no signal; the core `inspectVideoFile` still accepts one for
  hermetic cancellation tests. Per-frame extraction timeouts bound each ffmpeg call regardless.
- **Archive video entries are summarized as `manifest`, not frame-extracted in-archive** (M6). The
  archive processor never shells out to ffmpeg; a video entry is left as a manifest summary so
  direct `video_inspect` stays the sole owner of frame extraction and the two responsibilities never
  merge. This is the plan-sanctioned "summarize ... depending on V2 artifact constraints" option.
