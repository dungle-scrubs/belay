# Transcript Image Rendering - Progress Report

## Summary

> Current focus: M1: Storybook Image States

- Total checklist items: 31
- Completed: 4
- Current cutoff blockers: 27

## 0. Hard Dependencies

- [x] Existing D-092 composer image-token model and submitted `ArtifactRef` flow
- [x] Existing `MessageAttachments` / `MessageImages` inline transcript rendering
- [x] Existing same-message `ImageCarousel` dialog behavior
- [x] Existing blob-store image URL resolution through `artifactSrc`

## M1: Storybook Image States

- [ ] RED: Add/extend Storybook states for loading, loaded, unavailable, tiny, wide, tall, large, transparent-background, and narrow transcript width
- [ ] GREEN: Add a transcript image tile presentation that can show loading and unavailable states without layout jump
- [ ] RED: Add stories for filename present, filename absent, long filename, and mixed image/document attachments
- [ ] GREEN: Surface filename/metadata only where it improves scanability and does not crowd the image
- [ ] REFACTOR: Keep the tile reusable inside `MessageImages` without changing the submitted artifact model

## M2: Inline Behavior and Accessibility

- [ ] RED: Extend `message-images.test.tsx` for loading state, broken fallback, filename labels, and long-name truncation
- [ ] GREEN: Implement accessible image tiles with stable `alt`, `aria-label`, focus, hover, and keyboard activation behavior
- [ ] RED: Verify single-image and multi-image sizing caps stay contained and responsive
- [ ] GREEN: Preserve the single-image taller cap and multi-image shorter cap unless Storybook proves a better tokenized rule
- [ ] RED: Verify non-image artifacts still render as file rows and never enter the image carousel
- [ ] REFACTOR: Keep `MessageImages` free of carousel state; `MessageAttachments` owns opening

## M3: Carousel Refinement

- [ ] RED: Extend `image-carousel.test.tsx` for filename display, loading/unavailable state, and long filename behavior
- [ ] GREEN: Align carousel inspection with the inline image primitive's unavailable and metadata states
- [ ] RED: Verify one-image mode has no previous/next controls and multi-image mode cycles in submitted order
- [ ] GREEN: Keep ArrowLeft/ArrowRight navigation and Escape close behavior unchanged
- [ ] RED: Verify the carousel is scoped to exactly the images from the clicked message
- [ ] REFACTOR: Share small helpers between inline tile and carousel only when it reduces real duplication

## M4: Transcript Integration and Regression

- [ ] RED: Add transcript-row or message integration coverage for user messages with text plus images, images only, and documents plus images
- [ ] GREEN: Ensure user prompts still show `[Image #N]` tokens in visible text while images render below
- [ ] RED: Verify queued/steered prompts preserve image artifacts through submit and render after replay
- [ ] GREEN: Preserve current `ArtifactRef` ordering so token #k maps to image artifact k
- [ ] REFACTOR: Keep upload intake and transcript rendering concerns separate

## M5: Responsive and Future-Surface Fit

- [ ] RED: Add Storybook coverage for narrow mobile viewport and transcript-width constraints
- [ ] GREEN: Ensure long filenames, controls, and metadata never overlap or resize the transcript unexpectedly
- [ ] RED: Document how the future compact transcript layout should summarize image attachments
- [ ] GREEN: Add a compact-mode integration note without implementing compact layout here
- [ ] REFACTOR: Keep visual tokens aligned with existing chat/card surfaces
