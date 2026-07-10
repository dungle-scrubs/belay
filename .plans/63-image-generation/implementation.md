# Image Generation - Implementation Plan (stub)

> **Status: intentionally light.** A parked capability to flesh out later. Almost
> nothing is decided. Resolve section 3 before committing milestones. <!-- D-001 -->

## 0. Hard Dependencies

- [ ] OPEN: the owner's **tool-proxy image-generation tool** is the intended generation
  backend. Its exact interface (invocation, models available - e.g. nano-banana /
  gpt-image - inputs/outputs, latency, auth) must be pinned when fleshing out. <!-- D-003 -->
- [x] Trevor already has image **display** surfaces to build on: `apps/web/src/artifact-thumb.tsx`,
  `apps/web/src/components/chat/image-carousel.tsx`, `apps/web/src/components/chat/message-images.tsx`,
  and the content-addressed blob store (`apps/web/src/blob.ts` + host artifacts).

## 1. Objective

Give Trevor an image-generation capability: an agent tool that produces an image from a
prompt, plus the UI to render it. Unblocks the 58.6 audit's deferred row D12, which is a
display pattern with no backend today. The shape is undecided. <!-- D-001 -->

## 2. Why this is deferred-until-now

Trevor has **no image-generation tool** - its agent can display existing images
(artifacts/attachments/blobs) but nothing generates one from a prompt, so there was
nothing for the D12 pending/zoom/regenerate UI to render. The owner's tool-proxy
image-gen tool supplies that missing backend, which is what makes this plan actionable
to flesh out. <!-- D-003 -->

## 3. The two halves (to flesh out - NOT committed milestones)

### Backend - the generation tool

- Wrap the tool-proxy image-generation tool as a Trevor agent tool (host-side), riding
  the normal tool boundary (tool.started/completed, redaction, cancellation).
- Persist generated images in the content-addressed blob store (reuse `blob.ts` + host
  artifacts), NOT base64 in the log.
- Open: model selection (which tool-proxy models to expose), prompt/args shape, cost/rate
  limits, whether it is a mutating/serial tool.

### Frontend - the D12 rendering pattern

- Adopt assistant-ui's `docs/guides/image-generation` pattern: a **pending -> complete**
  state machine (placeholder/skeleton while generating -> final image), **zoom**, and
  **regenerate**, built on the existing `artifact-thumb` / `image-carousel` /
  `message-images` surfaces.
- Open: does a generating image get its own tool-row renderer arm, or the artifact panel?
  How does regenerate map onto a re-run of the tool?

## 4. Open questions

- Tool-proxy interface + which image models to surface.
- Storage/lifecycle of generated images (blob retention, thumbnails).
- Rendering home: transcript tool row vs artifact panel vs carousel.
- Regenerate semantics (re-run the tool / new blob / variant history).
- Whether this depends on or interacts with any tool-proxy MCP wiring already in the host.

## 5. Non-Goals

- No implementation until the tool-proxy interface is pinned and section 3 is designed.
- No base64-in-log image storage (use the content-addressed blob path).
- No bespoke generation model integration if the tool-proxy tool already covers it.

## 6. Decisions

Canonical decisions are in `plan.db`.

- D-001: light stub; flesh out section 3 before committing milestones.
- D-002: fresh integer 63; own capability, only seeded by 58.6 audit D12.
- D-003: backend hooks the owner's tool-proxy image-gen tool + blob store; frontend adopts
  the assistant-ui D12 pending/zoom/regenerate pattern on existing image surfaces.
