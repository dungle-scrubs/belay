# Transcript Image Rendering - Implementation Plan

## 0. Hard Dependencies

- Existing D-092 composer image-token model and submitted `ArtifactRef` flow.
- Existing `MessageAttachments` / `MessageImages` inline transcript rendering.
- Existing same-message `ImageCarousel` dialog behavior.
- Existing blob-store image URL resolution through `artifactSrc`.

## 1. Architecture

Trevor already accepts uploaded images, inserts `[Image #N]` tokens into the composer, submits image `ArtifactRef`s with the user message, renders attached images inline through `MessageAttachments`, and opens a same-message `ImageCarousel` when an image is clicked. This plan does not replace that model.

The implementation target is to make transcript image rendering feel like a first-class assistant-ui image surface: image tiles should have clear loading and unavailable states, useful filename/metadata affordances where they help scanning, responsive contained sizing, accessible labels, and an inspection path that keeps the existing carousel when multiple images belong to the same prompt.

The assistant-ui image component is reference material for the interaction shape, not a mandate to adopt assistant-ui runtime message parts. Trevor's source of truth remains the submitted `ArtifactRef` list attached to each user message.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Same-prompt images remain one scoped set | Existing carousel behavior stays message-local |
| Image artifacts are still `ArtifactRef`s | No transcript schema migration is required for this plan |
| Images are contained, never cropped | Screenshots and generated images remain inspectable |
| Broken/unavailable images degrade quietly | No broken image icon appears in transcript |
| Storybook-first | Visual states are designed before implementation expands behavior |

### Boundaries

- `useComposer` and image-token parsing remain outside this plan except for regression coverage.
- `MessageAttachments` remains the user-message attachment boundary.
- `MessageImages` owns inline tile presentation.
- `ImageCarousel` owns same-message inspection for one or many images.
- Future tool-detail or artifact-panel views may reuse the same image primitive, but this plan does not require those plans to be implemented first.

### Observability

No host/runtime observability is required. Browser-side image load/error state should be visible through DOM states and Storybook stories. If a later implementation adds download/copy actions, failures should be local UI states rather than transcript events.

## 2. Phases

### Phase 1: Inline Image Surface

**Goal:** Inline transcript images have assistant-ui-inspired loading, error, metadata, and responsive states while preserving D-092 behavior.

#### M1: Storybook Image States

- **Dependencies:** hard dependencies
- **Effort:** S
- **Tasks:**
  1. RED: Add/extend Storybook states for loading, loaded, unavailable, tiny, wide, tall, large, transparent-background, and narrow transcript width.
  2. GREEN: Add a transcript image tile presentation that can show loading and unavailable states without layout jump.
  3. RED: Add stories for filename present, filename absent, long filename, and mixed image/document attachments.
  4. GREEN: Surface filename/metadata only where it improves scanability and does not crowd the image.
  5. REFACTOR: Keep the tile reusable inside `MessageImages` without changing the submitted artifact model.

#### M2: Inline Behavior and Accessibility

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Extend `message-images.test.tsx` for loading state, broken fallback, filename labels, and long-name truncation.
  2. GREEN: Implement accessible image tiles with stable `alt`, `aria-label`, focus, hover, and keyboard activation behavior.
  3. RED: Verify single-image and multi-image sizing caps stay contained and responsive.
  4. GREEN: Preserve the single-image taller cap and multi-image shorter cap unless Storybook proves a better tokenized rule.
  5. RED: Verify non-image artifacts still render as file rows and never enter the image carousel.
  6. REFACTOR: Keep `MessageImages` free of carousel state; `MessageAttachments` owns opening.

### Phase 2: Same-Prompt Inspection

**Goal:** Clicking an inline image opens a polished same-message inspection surface that keeps the existing carousel semantics.

#### M3: Carousel Refinement

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Extend `image-carousel.test.tsx` for filename display, loading/unavailable state, and long filename behavior.
  2. GREEN: Align carousel inspection with the inline image primitive's unavailable and metadata states.
  3. RED: Verify one-image mode has no previous/next controls and multi-image mode cycles in submitted order.
  4. GREEN: Keep ArrowLeft/ArrowRight navigation and Escape close behavior unchanged.
  5. RED: Verify the carousel is scoped to exactly the images from the clicked message.
  6. REFACTOR: Share small helpers between inline tile and carousel only when it reduces real duplication.

#### M4: Transcript Integration and Regression

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Add transcript-row or message integration coverage for user messages with text plus images, images only, and documents plus images.
  2. GREEN: Ensure user prompts still show `[Image #N]` tokens in visible text while images render below.
  3. RED: Verify queued/steered prompts preserve image artifacts through submit and render after replay.
  4. GREEN: Preserve current `ArtifactRef` ordering so token #k maps to image artifact k.
  5. REFACTOR: Keep upload intake and transcript rendering concerns separate.

### Phase 3: Responsive Polish

**Goal:** Transcript image rendering is polished across desktop, narrow, compact, and future detail surfaces.

#### M5: Responsive and Future-Surface Fit

- **Dependencies:** M4
- **Effort:** S
- **Tasks:**
  1. RED: Add Storybook coverage for narrow mobile viewport and transcript-width constraints.
  2. GREEN: Ensure long filenames, controls, and metadata never overlap or resize the transcript unexpectedly.
  3. RED: Document how the future compact transcript layout should summarize image attachments.
  4. GREEN: Add a compact-mode integration note without implementing compact layout here.
  5. REFACTOR: Keep visual tokens aligned with existing chat/card surfaces.

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Metadata makes image rows noisy | medium | medium | Keep filename/metadata subtle and hide optional details on narrow widths | web |
| Inline image changes break same-message carousel indexing | high | low | Test click index and message-local image set | web |
| Long filenames overflow transcript | medium | medium | Storybook and tests for truncation | web |
| Assistant-ui component shape conflicts with Trevor artifacts | medium | low | Use assistant-ui as interaction reference, not runtime data model | web |

## 4. Escape Hatches

1. **If metadata crowds the transcript:** keep metadata in tooltips/accessible labels and only show filename in carousel title.
2. **If inline loading state creates layout shift:** reserve aspect-ratio boxes only when dimensions are known; otherwise use fixed max-height skeletons.
3. **If download/copy actions are distracting:** defer those actions to carousel/detail views and keep inline tiles open-only.

## 5. Progress Report Accounting

Progress lives in `.plans/34-transcript-image-rendering/progress-report.md`. Count only active unchecked implementation tasks as blockers. Do not mark a milestone complete unless the matching Storybook/test state exists.

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "34-transcript-image-rendering"
```

## 6. Validation Commands

```bash
pnpm --filter @trevor/web test -- --project web apps/web/src/components/chat/message-images.test.tsx
pnpm --filter @trevor/web test -- --project web apps/web/src/components/chat/image-carousel.test.tsx
pnpm --filter @trevor/web test -- --project web apps/web/src/hooks/use-composer.test.tsx
pnpm --filter @trevor/web storybook
pnpm test -- --project web
```

## 7. Decisions

Canonical decisions live in `.plans/34-transcript-image-rendering/plan.db`.
