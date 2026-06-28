# Video Inspect - Implementation Plan

## 0. Hard Dependencies

- [x] Existing V1 implementation found in `/Users/kevin/dev/trevor/packages/agent-host/src/tools/video-processor.ts`.
- [x] Existing V1 direct tool tests found in `/Users/kevin/dev/trevor/packages/agent-host/test/tools/core-video.test.ts`.
- [x] Existing V1 agent-loop finalization tests found in `/Users/kevin/dev/trevor/packages/agent-host/test/agent/loop-video-inspect.test.ts`.
- [x] Existing V1 provider continuation handling found in `/Users/kevin/dev/trevor/packages/agent-host/src/provider/provider-tool-results.ts`.
- [x] Existing V1 archive integration found in `media-processors.ts`, `core-archive.test.ts`, and the TUI archive/video history fixture.
- [x] `41-archive-tools` keeps archive media dispatch separate from direct `video_inspect` behavior.
- [x] `28-tool-detail-takeover` defines the transcript-detail pattern for inspecting richer tool output.

## 1. Architecture

`video_inspect` lets the model inspect a local video path by extracting a bounded set of frame artifacts and feeding those frames back into the provider as vision content. V2 should bring forward V1's proven behavior as a port/reference while adapting it to the current host, artifact, session, transcript, and provider boundaries. <!-- D-001 -->

The model-facing contract remains small:

- `video_inspect(path, maxFrames?, sampleEveryMs?)`
- local video path only in the first cut;
- output includes video metadata where available, sampled frame count, frame timestamps, artifact references, truncation, unavailable state, and warnings.

V1 used `ffprobe` and `ffmpeg`, configurable through `TREVOR_FFPROBE_PATH` and `TREVOR_FFMPEG_PATH`, to probe metadata and extract frames. V2 should preserve that operational model unless implementation discovery shows a better existing V2 media abstraction. Missing binaries are not fatal to the whole turn: the tool returns a structured unavailable result with warnings and no frames. <!-- D-002 -->

`video_inspect` is more than a visible transcript row. It must also convert extracted frame artifacts into provider continuation messages for vision-capable models, then force the provider into a direct answer pass instead of allowing another visible tool loop to chase the generated frames. <!-- D-003 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Local path first | No remote video download path in this plan; remote media can be fetched by other tools first. |
| Bounded sampling | Enforce `maxFrames`, `sampleEveryMs`, command timeouts, and artifact count caps. |
| Missing binaries degrade cleanly | Return structured unavailable output instead of failing the whole turn. |
| Provider vision feedback | Frame artifacts are added to tool-result continuation content for capable providers. |
| No follow-up tool churn | After frame artifacts are returned, the provider should answer directly rather than repeatedly reading frame files. |
| Artifact lifecycle | Frame files are run-scoped artifacts and are cleaned up with run disposal. |
| Archive integration is separate | Archives may detect video entries, but direct frame extraction remains owned by this tool. |
| Detail-ready output | Transcript rows stay concise while detail view can inspect frames, timestamps, warnings, and metadata. |

### Boundaries

- `apps/agent-host` owns video probing, frame extraction, artifact creation/cleanup, tool metadata, runtime normalization, provider continuation encoding, and observability.
- `packages/session` owns any protocol/read-model additions needed to represent video inspect results and frame artifacts in transcript events.
- `apps/web` owns transcript rows, compact rows, image/frame previews, and detail takeover views for video inspect results.
- `41-archive-tools` owns archive validation and archive entry dispatch. It can call or share the video processor, but it does not own direct `video_inspect` provider-loop semantics.
- `35-transcript-image-rendering` owns reusable image rendering for frame artifacts in transcript/detail surfaces.
- Provider adapters own capability-specific message formatting, but the host owns the normalized tool-result-to-provider-content contract.

### Observability

Video inspection touches external binaries, filesystem artifacts, provider continuation, and UI detail surfaces, so it needs structured observability:

- tool spans include video path label/hash, max frames, sample interval, duration, width, height, sampled frame count, truncation, unavailable state, binary paths, and duration;
- extraction command failures carry typed classes for missing binary, probe failure, frame extraction timeout, unsupported media, cancelled, artifact write failure, and provider-continuation failure;
- visible tool results include unavailable warnings, sampled frame count, truncation, and artifact metadata;
- provider continuation spans record how many frames were attached and whether the provider surface accepted images;
- cleanup diagnostics confirm frame artifacts are removed with run cleanup.

## 2. Current State

The V2 umbrella plan carries H-115 as `video_inspect`, described as frame extraction from video. This plan extracts that backlog item.

V1 has a real implementation. `video-processor.ts` checks for ffprobe/ffmpeg, probes duration and video dimensions, samples frames into deterministic artifact paths, and returns structured output. `core-video.test.ts` covers unavailable binaries, synthetic video frame extraction, and run cleanup. `loop-video-inspect.test.ts` covers the special agent-loop behavior after video inspection. `provider-tool-results.ts` reads extracted PNG/JPEG frame artifacts and adds them to provider tool-result messages as image content.

V1 behavior worth preserving:

- missing ffprobe/ffmpeg returns `unavailable: true`, `missingBinaries`, warnings, and empty frames;
- default `maxFrames` is 5 and default `sampleEveryMs` is 1000;
- extracted frame artifacts include frame index, timestamp, width, height, and artifact path;
- output reports duration, dimensions, sampled frame count, and `truncated`;
- run cleanup removes generated frame artifacts;
- provider continuation includes the serialized tool result plus up to 8 frame images;
- after direct `video_inspect`, the next provider pass disables further visible tool use and asks for a direct answer.

V2 has not yet extracted this as its own implementation plan. It should remain later-sequenced after the archive tooling plan and before any broader media tooling expansion.

## 3. Phases

### Phase 1: V1 Provenance and V2 Contract

**Goal:** Define the exact V2 tool contract and parity target from V1 without importing stale architecture.

**Gate from previous:** H-115 has been extracted from the umbrella plan.

#### M1: Provenance Snapshot

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add a contract/provenance test or fixture that captures V1 `video_inspect` input and output examples.
  2. GREEN: Document V1 behavior from `video-processor.ts`, `core-video.test.ts`, loop tests, provider tool-result encoding, and archive media dispatch.
  3. RED: Add V2 contract tests for normal output, unavailable output, malformed input, and bounded sampling parameters.
  4. GREEN: Define V2 input/output types and typed failure/unavailable result shapes.
  5. REFACTOR: Keep provenance notes separate from implementation so future differences are intentional.

#### M2: Metadata and Tool Policy

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add metadata tests for `video_inspect` effect, idempotence, persistence, approval, concurrency, child exposure, and context policy.
  2. GREEN: Register the direct tool schema and metadata in the V2 host surface.
  3. RED: Add prompt-guidance tests for when to use video inspection instead of shelling out or reading binary files.
  4. GREEN: Add concise guidance that `video_inspect` is for local video paths and bounded frame sampling.
  5. REFACTOR: Keep video guidance out of unrelated prompts unless the tool is available.

### Gate 1->2

- [ ] V2 has explicit `video_inspect` schemas, result types, and unavailable/failure classes.
- [ ] V1 parity targets and intentional divergences are documented.
- [ ] Tool metadata makes the heavyweight/on-request nature of video inspection visible.

### Phase 2: Core Video Processor

**Goal:** V2 can inspect a local video path and produce bounded frame artifacts.

**Gate from previous:** Tool contract and metadata are defined.

#### M3: Binary Discovery and Metadata Probe

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for missing ffmpeg, missing ffprobe, configured binary paths, and command discovery timeouts.
  2. GREEN: Implement binary discovery using default commands and `TREVOR_FFMPEG_PATH` / `TREVOR_FFPROBE_PATH`.
  3. RED: Add tests for metadata probe success, probe failure, no video stream, malformed probe JSON, cancellation, and timeout.
  4. GREEN: Implement metadata probing with typed degraded outputs where possible.
  5. REFACTOR: Keep command execution and result parsing isolated from tool orchestration.

#### M4: Frame Extraction

- **Dependencies:** M3
- **Effort:** L
- **Tasks:**
  1. RED: Add tests for synthetic video extraction with deterministic frame count, timestamps, dimensions, and truncation.
  2. GREEN: Implement bounded frame extraction into a run-scoped artifact directory.
  3. RED: Add tests for max frame caps, sample interval caps, extraction timeout, cancellation, unsupported media, and artifact write failure.
  4. GREEN: Return structured frame artifact refs and warnings/failures without leaking raw binary data into transcript text.
  5. REFACTOR: Keep artifact creation/cleanup reusable for archive media dispatch.

### Gate 2->3

- [ ] Missing binaries return structured unavailable output.
- [ ] Local video inspection produces bounded frame artifacts.
- [ ] Command timeouts, cancellation, and artifact failures are typed and visible.

### Phase 3: Artifact Lifecycle and Archive Integration

**Goal:** Video frame artifacts live long enough for provider/UI use and are cleaned up predictably.

**Gate from previous:** Core processor returns artifact refs.

#### M5: Artifact Lifecycle

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving direct video frame artifacts are run-scoped.
  2. GREEN: Store frame artifacts under the approved V2 run artifact/scratch location.
  3. RED: Add tests proving run cleanup removes generated frame artifacts.
  4. GREEN: Wire artifact cleanup into existing run disposal behavior.
  5. REFACTOR: Document what is durable transcript data versus ephemeral frame file data.

#### M6: Archive Media Dispatch

- **Dependencies:** M4, `41-archive-tools`
- **Effort:** M
- **Tasks:**
  1. RED: Add archive integration tests for video entries discovered inside zip archives.
  2. GREEN: Allow archive processors to delegate video entry frame extraction or summarize that extraction requires direct `video_inspect`, depending on V2 artifact constraints.
  3. RED: Add tests proving archive validation remains owned by archive tools and video extraction remains owned by video processor.
  4. GREEN: Preserve separate errors and warnings for archive safety versus video processor failures.
  5. REFACTOR: Keep direct `video_inspect` provider-loop semantics out of archive read unless explicitly invoked.

### Gate 3->4

- [ ] Frame artifacts have a defined lifecycle and cleanup path.
- [ ] Archive video handling is integrated without merging archive and video responsibilities.
- [ ] Transcript/session data never depends on ephemeral frame files remaining forever.

### Phase 4: Provider Continuation and Host Loop

**Goal:** Extracted frames are fed back to vision-capable provider paths and the model answers directly.

**Gate from previous:** Frame artifacts and metadata are available.

#### M7: Provider Tool-Result Encoding

- **Dependencies:** M4, M5
- **Effort:** L
- **Tasks:**
  1. RED: Add provider continuation tests proving video tool results include serialized text plus frame image content.
  2. GREEN: Encode PNG/JPEG frame artifacts into provider-compatible image content with frame count caps.
  3. RED: Add tests for missing artifact files, unsupported frame MIME types, non-vision providers, and provider image-content limits.
  4. GREEN: Degrade to text-only result with warnings when images cannot be attached.
  5. REFACTOR: Keep provider-specific formatting behind provider adapters or a shared continuation codec.

#### M8: Agent Loop Finalization

- **Dependencies:** M7
- **Effort:** M
- **Tasks:**
  1. RED: Add loop tests proving the provider is forced into a direct answer pass after direct `video_inspect`.
  2. GREEN: Disable further visible tool use on the post-video continuation pass.
  3. RED: Add tests proving attempted follow-up tool calls after video inspection are suppressed or converted into hidden disabled feedback without visible churn.
  4. GREEN: Preserve final assistant response behavior and transcript event ordering.
  5. REFACTOR: Keep this special post-video behavior narrowly scoped to video frame artifact workflows.

### Gate 4->5

- [ ] Video frames reach vision-capable provider continuations.
- [ ] Non-vision or frame-read failures degrade without blocking final text.
- [ ] Post-video loop behavior avoids repeated tool churn.

### Phase 5: UI, Detail View, and E2E

**Goal:** Users can understand video inspection in transcript rows, compact layout, detail view, and full EZE flows.

**Gate from previous:** Host loop emits complete video inspect events.

#### M9: Transcript Rendering

- **Dependencies:** M4, `28-tool-detail-takeover`, `35-transcript-image-rendering`
- **Effort:** M
- **Tasks:**
  1. RED: Add web fixtures/tests for video inspect success, unavailable, warning, extraction failure, and truncated rows.
  2. GREEN: Render concise video inspect rows with path label, sampled frame count, duration, dimensions, truncation, and warnings.
  3. RED: Add compact transcript tests for video inspect rows.
  4. GREEN: Add detail takeover for frames, timestamps, dimensions, warnings, and artifact availability.
  5. REFACTOR: Reuse transcript image rendering for frame thumbnails/previews.

#### M10: End-to-End Validation

- **Dependencies:** M8, M9
- **Effort:** L
- **Tasks:**
  1. RED: Add hermetic e2e using a fake provider and synthetic video fixture when ffmpeg/ffprobe are available.
  2. GREEN: Make the e2e skip with a stated reason when ffmpeg/ffprobe are unavailable.
  3. RED: Add e2e coverage for unavailable binaries, provider frame feedback, final answer after video inspection, and transcript detail inspection.
  4. GREEN: Validate local video path inspection through the full model/tool/provider/transcript loop.
  5. REFACTOR: Add manual EZE checklist for local video, missing binaries, archive-contained video, compact row, and detail takeover.

### Gate 5

- [ ] Unit, web, integration, and hermetic e2e tests pass.
- [ ] Local video inspection reaches a final assistant answer using frame artifacts when supported.
- [ ] Missing binaries and unsupported media fail or degrade visibly without breaking the whole turn.
- [ ] V1 parity is either achieved or documented as an intentional V2 divergence.

## 4. Validation Matrix

| Scenario | Expected |
|----------|----------|
| Missing ffmpeg/ffprobe | Structured unavailable output with warnings and empty frames. |
| Synthetic local video | Bounded frame artifacts with timestamps, dimensions, and sampled count. |
| Long video | `truncated: true` when duration/sample interval exceeds `maxFrames`. |
| Probe failure | Typed degraded result or failure without raw command spam. |
| Extraction timeout/cancel | Tool stops cleanly with visible typed failure. |
| Provider continuation | Tool result includes serialized text plus capped frame images when supported. |
| Post-video loop | Provider answers directly; visible follow-up tool churn is suppressed. |
| Run cleanup | Generated frame artifacts are removed with run disposal. |
| Archive video entry | Archive safety remains separate from video processing. |
| Detail takeover | Frames, timestamps, dimensions, warnings, and artifact availability are inspectable. |

## 5. Non-Goals

- Remote video downloading or streaming inspection.
- General media library/catalog management.
- Permanent storage of extracted frames outside run artifact policy.
- Replacing `archive_read` media detection or archive validation.
- Allowing arbitrary follow-up filesystem reads of generated frame files when provider image feedback already has the frames.

