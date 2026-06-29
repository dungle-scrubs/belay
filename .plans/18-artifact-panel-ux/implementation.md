# Artifact Panel UX - Implementation Plan

## 0. Hard Dependencies

- [x] `.plans/trevor-v2` D-028 blob-backed artifacts - Trevor already has durable `ArtifactRef` transport and blob storage for artifact bytes.

## 1. Architecture

Trevor needs a reusable artifact workspace in the web UI. The panel is a right-side surface for rendered artifacts: Lucid-style addressable HTML, generated documents, images, reports, diagnostics, previews, and future artifact types. It is not Lucid-specific. Lucid is a later consumer of this surface.

The intended feel is closer to Claude Desktop's artifact/document panel than to a chat attachment thumbnail. A selected artifact opens beside the transcript in a substantial right-side panel. The exact responsive layout is a design decision to validate in Storybook and live visual tests: it may fade-replace the current right panel content, resize left, partially overlap the transcript, or push/slide the transcript narrower like the provided Claude screenshot. The first implementation should make this a controlled layout mode rather than a hardcoded one-off.

### Key Constraints

| Constraint | Impact |
|---|---|
| Artifact-type agnostic | The panel must render through typed artifact viewers, not Lucid-specific branches. |
| Right-side workspace | The first-class artifact surface lives on the right side and can coexist with the transcript. |
| Layout mode is explicit | Overlap, push/narrow, and replace-current-panel behaviors are Storybook-visible states and not accidental CSS. |
| Resize is user-controlled | The panel can resize left within safe min/max bounds and persists only browser-local layout preference at first. |
| Transcript remains usable | Opening an artifact must not hide active turn status, composer controls, or current transcript context incoherently. |
| Existing artifact protocol stays | Reuse `ArtifactRef`, blob-store URLs, transcript artifact refs, and command/tool result artifacts where possible. |

### Boundaries

- **Artifact registry:** maps artifact kind/MIME/source metadata to a viewer component and safe capabilities.
- **Panel shell:** owns layout, resizing, open/close, focus, toolbar, title, source metadata, and error/loading states.
- **Viewers:** render content for each artifact kind. HTML/document/image/diagnostic viewers are isolated from panel chrome.
- **Transcript links:** artifact cards, command results, and assistant/user messages can open artifacts in the panel without duplicating renderer logic.
- **Persistence:** first cut stores UI layout preference in browser-local state only; durable artifact content remains in existing blob/session event storage.

### Observability

- UI state should expose selected artifact id, kind, source event/run, panel open/closed, layout mode, and load/error status for tests and `/doctor`-style debug when useful.
- Viewer failures degrade to a safe error state with copy/open/download affordances where allowed.
- Telemetry, if present, records artifact kind and status only, not artifact bytes or private content.

## 2. Phases

### Phase 1: Artifact Panel Shell

**Goal:** Trevor has a reusable right-side artifact panel with explicit layout modes.

**Gate from previous:** D-028 artifact transport exists.

#### M1: Panel State and Layout Contract

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add state/model tests for selected artifact id, open/closed state, layout mode, width, min/max, and reset behavior.
  2. GREEN: Define the artifact panel state contract and browser-local layout preference.
  3. RED: Add tests for switching artifacts, closing, reopening, and missing artifact state.
  4. GREEN: Implement panel state transitions without coupling to a specific viewer.
  5. REFACTOR: Keep panel state independent from transcript message state.

#### M2: Storybook Layout Exploration

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add Storybook stories for closed, replace-current-panel, push/narrow transcript, partial overlap, and resizable states.
  2. GREEN: Build the panel shell with toolbar, title, resize handle, close control, loading, empty, and error states.
  3. RED: Add visual tests or Storybook assertions for narrow, desktop, wide desktop, and active composer states.
  4. GREEN: Pick the first production layout mode from the reviewed stories and keep alternates as fixtures for later.
  5. REFACTOR: Keep layout CSS explicit and container-query driven.

#### M3: Resize, Focus, and Accessibility

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for keyboard focus when opening/closing the panel and returning to transcript/composer.
  2. GREEN: Implement accessible focus management, close controls, resize semantics, and panel landmarks.
  3. RED: Add tests for min/max resize, viewport changes, and no text/control overlap.
  4. GREEN: Implement responsive constraints so the transcript and panel remain usable.
  5. REFACTOR: Make the resize handle and toolbar reusable by future right-side surfaces.

### Phase 2: Artifact Registry and Core Viewers

**Goal:** The panel can render multiple artifact kinds through one registry.

**Gate from previous:** Panel shell is Storybook-approved.

#### M4: Artifact Viewer Registry

- **Dependencies:** M1-M3
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for artifact kind/MIME/source metadata mapping to viewer components.
  2. GREEN: Implement a typed artifact viewer registry with unknown-kind fallback.
  3. RED: Add tests for viewer capabilities: copy, open external, download, inspect metadata, and safe disabled states.
  4. GREEN: Expose viewer capability metadata through the panel toolbar.
  5. REFACTOR: Keep registry entries data-driven and independent from transcript renderers.

#### M5: Document, HTML, Image, and Diagnostic Viewers

- **Dependencies:** M4
- **Effort:** L
- **Tasks:**
  1. RED: Add Storybook fixtures for generated document, HTML artifact, image, diagnostic/report, unknown, loading, and failed-load states.
  2. GREEN: Implement initial viewers with safe sizing and scroll behavior.
  3. RED: Add tests for large documents, wide images, tall reports, missing blobs, and non-renderable content.
  4. GREEN: Degrade to safe fallback rows with copy/open/download where available.
  5. REFACTOR: Share metadata, empty, and error chrome across viewers.

#### M6: Transcript and Command Integration

- **Dependencies:** M4, M5
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving transcript artifact cards and command/tool result artifacts open in the same panel.
  2. GREEN: Wire artifact open actions from transcript messages, command results, and generated document events.
  3. RED: Add tests proving panel selection does not mutate transcript, queue, or model-visible history.
  4. GREEN: Keep artifact viewing browser-local unless the artifact content itself is durable.
  5. REFACTOR: Remove duplicate artifact preview logic where the panel supersedes it.

### Phase 3: Verification

**Goal:** The artifact panel is production-ready for Lucid and other artifact types.

**Gate from previous:** Core viewers are wired.

#### M7: UX and E2E Verification

- **Dependencies:** M1-M6
- **Effort:** M
- **Tasks:**
  1. RED: Add end-to-end or component integration tests for opening an artifact, resizing the panel, switching artifacts, and closing.
  2. GREEN: Verify the selected production layout mode at mobile, desktop, and wide desktop widths.
  3. RED: Add regression tests for active streaming turn + open artifact panel.
  4. GREEN: Ensure transcript, composer, and task/tool status remain usable while the panel is open.
  5. REFACTOR: Document the artifact panel API for consumers, including Lucid.

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---:|---:|---|---|
| Panel becomes Lucid-specific | high | medium | Ship document/image/diagnostic fixtures before Lucid integration. | Web |
| Layout makes transcript unusable | high | medium | Storybook and visual tests for active composer, streaming, and narrow widths. | Web |
| HTML artifacts can affect Trevor UI | high | medium | Render HTML artifacts in an isolated iframe/sandbox with explicit capability metadata. | Web |
| Duplicated artifact renderers drift | medium | medium | Route transcript opens through registry-backed panel viewers. | Web |

## 4. Escape Hatches

1. **If push/narrow layout is too complex:** ship replace-current-panel first, keeping push/overlap as Storybook-only alternatives.
2. **If resize persistence creates state bugs:** keep width in memory for the first cut and defer persistence.
3. **If HTML viewer hardening is not ready:** ship non-HTML viewers first and leave Lucid gated behind `27-lucid-artifact-integration`.

## 5. Progress Report Accounting

The progress report is `.plans/18-artifact-panel-ux/progress-report.md`. It tracks only the reusable artifact panel UX, not Lucid-specific annotation/review behavior.

Before implementation resumes, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "18-artifact-panel-ux"
```

## 6. Validation Commands

```bash
pnpm test
pnpm --filter @trevor/web test
pnpm typecheck
```

## 7. Decisions

Canonical decisions are in `.plans/18-artifact-panel-ux/plan.db`. Query them with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "18-artifact-panel-ux"
```
