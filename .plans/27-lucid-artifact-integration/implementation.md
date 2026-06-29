# Lucid Artifact Integration - Implementation Plan

## 0. Hard Dependencies

- [ ] `18-artifact-panel-ux` - Lucid should render inside Trevor's reusable artifact panel rather than opening a separate Lucid browser workflow.

## 1. Architecture

Lucid currently works as an agent-agnostic CLI that serves addressable HTML artifacts in its own browser viewer. In Trevor, Lucid should work differently: generated Lucid artifacts should appear as first-class artifacts in Trevor's right-side artifact panel. The artifact panel owns the host application's layout, selection, resizing, and transcript relationship; Lucid owns addressability, annotation anchoring, versioning, and the feedback loop for HTML artifacts.

The integration should preserve Lucid's core value: a free-form HTML artifact becomes an addressable surface where the human can annotate elements and text ranges, and located feedback flows back to the agent. But Trevor should not require a separate `lucid open` browser tab for the ordinary path. Trevor already has HTML control, blob-backed artifacts, and a session transcript; this plan adapts Lucid's surface/overlay/event-log concepts into Trevor's artifact panel.

### Key Constraints

| Constraint | Impact |
|---|---|
| Artifact panel first | Lucid is a viewer/feedback mode inside `18-artifact-panel-ux`, not a separate primary UI. |
| Preserve addressability | Element and text-range annotations, anchor resolution, orphan handling, and version awareness remain core. |
| Trevor session is primary | Feedback appears in Trevor's session flow and can be consumed by the active agent turn/handoff model. |
| Avoid duplicated chrome | Trevor panel chrome replaces Lucid's standalone browser chrome where possible; Lucid overlay stays focused on addressability. |
| HTML isolation | Lucid artifacts render in a sandboxed/isolated viewer and cannot affect Trevor app chrome. |
| CLI remains valid | External `~/dev/lucid` CLI behavior can remain for non-Trevor harnesses; Trevor integration does not break it. |

### Boundaries

- **Trevor artifact panel:** layout, selection, toolbar, resizing, viewer mounting, transcript linkage.
- **Lucid renderer/overlay:** addressability, element/range targeting, annotation UI overlays, anchor capture/resolution, orphan states.
- **Lucid session state:** versions, feedback events, review resolved/reopened, cursors, and provenance. The first Trevor integration can map this into Trevor session events or a Lucid-compatible per-artifact state object.
- **Agent feedback loop:** located feedback becomes structured data available to Trevor's agent flow, not blind prompt text.
- **External Lucid CLI:** remains a separate harness-agnostic path; shared libraries/protocol are preferred over shelling out when practical.

### Observability

- Debug state includes artifact id, Lucid session id/path/ref, current version, annotation count, unresolved/orphaned count, review status, and last feedback cursor.
- Annotation ingestion logs redact note text by default in telemetry; structured tests can assert counts and ids.
- Viewer errors expose safe fallback: open external Lucid/HTML, copy artifact path/ref, or download raw HTML when allowed.

## 2. Phases

### Phase 1: Lucid Artifact Model in Trevor

**Goal:** Trevor can represent a Lucid HTML artifact as a durable artifact panel item.

**Gate from previous:** `18-artifact-panel-ux` viewer registry exists.

#### M1: Artifact Kind and Metadata

- **Dependencies:** `18-artifact-panel-ux`
- **Effort:** M
- **Tasks:**
  1. RED: Add protocol/model tests for a `lucid-html` or equivalent artifact kind with HTML ref, version, title, provenance, and review status.
  2. GREEN: Define Lucid artifact metadata and viewer registry entry.
  3. RED: Add tests for old/plain HTML artifacts degrading to non-addressable HTML viewer.
  4. GREEN: Distinguish Lucid-addressable HTML from generic HTML without breaking generic document rendering.
  5. REFACTOR: Keep Lucid metadata separate from ordinary blob `ArtifactRef` fields.

#### M2: Generation and Open Path

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for a generated Lucid artifact event opening in the artifact panel from a transcript/result card.
  2. GREEN: Publish/generated Lucid artifacts as panel-openable Trevor artifacts.
  3. RED: Add tests proving no separate `lucid open` browser tab is required in the Trevor path.
  4. GREEN: Mount the artifact inside the panel viewer and expose safe external-open fallback.
  5. REFACTOR: Keep generation path compatible with existing Lucid CLI artifacts where possible.

### Phase 2: Addressable Surface in the Panel

**Goal:** Lucid's addressability works inside Trevor's panel.

**Gate from previous:** Lucid artifacts open in the panel.

#### M3: Overlay Mount and Isolation

- **Dependencies:** M1, M2
- **Effort:** L
- **Tasks:**
  1. RED: Add browser tests for rendering a Lucid HTML artifact in an isolated iframe/panel surface.
  2. GREEN: Mount Lucid overlay/addressability layer inside the panel's HTML viewer.
  3. RED: Add tests for artifact CSS/JS not breaking Trevor panel chrome.
  4. GREEN: Enforce sandbox/isolation and defensive overlay mounting.
  5. REFACTOR: Share Lucid overlay code with `~/dev/lucid` where practical instead of forking behavior.

#### M4: Element and Text-Range Annotation

- **Dependencies:** M3
- **Effort:** L
- **Tasks:**
  1. RED: Add tests for element hover/click targeting and text-range selection inside the panel.
  2. GREEN: Implement annotation composer flow in the panel.
  3. RED: Add tests for `data-lucid-id`, fingerprint/domPath, quote/position range anchors, and duplicate id handling.
  4. GREEN: Preserve Lucid anchor resolution behavior and orphan failed anchors safely.
  5. REFACTOR: Keep annotation state independent from transcript message rendering.

### Phase 3: Feedback Loop and Versioning

**Goal:** Located Lucid feedback flows back into Trevor's agent workflow.

**Gate from previous:** Annotations can be authored in the panel.

#### M5: Feedback Events and Agent Consumption

- **Dependencies:** M4
- **Effort:** L
- **Tasks:**
  1. RED: Add protocol tests for located feedback events: annotation id, target anchor, snippet, note, artifact version, resolved/orphaned, and cursor/order.
  2. GREEN: Persist Lucid feedback in Trevor session events or a Lucid-compatible per-artifact event log.
  3. RED: Add tests proving feedback is structured data, not blindly injected as instructions.
  4. GREEN: Make located feedback available to the active agent/resume flow with clear provenance.
  5. REFACTOR: Keep feedback folding deterministic across replay and reconnect.

#### M6: Versions, Revisions, and Review Status

- **Dependencies:** M5
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for new artifact versions, live reload, anchor re-resolution, orphan tray, review resolved, and review reopened.
  2. GREEN: Track Lucid artifact versions and review lifecycle in Trevor.
  3. RED: Add tests for stale annotation drafts when a new version arrives.
  4. GREEN: Preserve or defer draft annotations safely during version swaps.
  5. REFACTOR: Share version/review vocabulary with Lucid docs where possible.

### Phase 4: Lucid/Trevor Product UX

**Goal:** Lucid feels native in Trevor while retaining its review loop.

**Gate from previous:** Feedback and versions are wired.

#### M7: Panel UX and Transcript Relationship

- **Dependencies:** M1-M6, `18-artifact-panel-ux`
- **Effort:** M
- **Tasks:**
  1. RED: Add Storybook states for Lucid artifact open, annotation drafting, queued annotations, orphaned annotations, review resolved, and narrow/wide panel.
  2. GREEN: Build native Trevor panel UI around the Lucid surface.
  3. RED: Add tests proving transcript stays readable and agent status remains visible while reviewing.
  4. GREEN: Wire transcript artifact cards to focus the matching Lucid panel session.
  5. REFACTOR: Avoid duplicating Lucid standalone chrome where Trevor panel chrome owns the interaction.

#### M8: External Lucid Compatibility

- **Dependencies:** M1-M7
- **Effort:** M
- **Tasks:**
  1. RED: Add compatibility tests for importing/opening an existing Lucid artifact/session from `~/dev/lucid` output.
  2. GREEN: Support safe external-open or import for Lucid CLI artifacts.
  3. RED: Add tests proving Trevor integration does not break the standalone Lucid CLI contract.
  4. GREEN: Keep shared protocol/library boundaries documented.
  5. REFACTOR: Move reusable Lucid pieces to a stable package boundary if needed.

### Phase 5: Verification

**Goal:** Trevor can generate, display, annotate, revise, and complete a Lucid artifact review loop.

**Gate from previous:** M1-M8 pass.

#### M9: End-to-End Review Loop

- **Dependencies:** M1-M8
- **Effort:** M
- **Tasks:**
  1. RED: Add E2E test for generating a Lucid artifact, opening the panel, adding located feedback, and exposing it to the agent flow.
  2. GREEN: Implement the full happy path with deterministic fixtures.
  3. RED: Add E2E tests for orphaned annotation, version reload, review resolved, and panel close/reopen.
  4. GREEN: Verify resilience across refresh/replay and active turn boundaries.
  5. REFACTOR: Document manual EZE repro steps and compatibility expectations.

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---:|---:|---|---|
| Lucid integration forks Lucid behavior | high | medium | Share overlay/protocol code or write compatibility tests against Lucid fixtures. | Web/Host |
| HTML artifacts escape panel isolation | high | medium | Sandbox iframe, strict viewer boundary, and security tests. | Web |
| Feedback becomes prompt injection | high | medium | Treat annotations as structured feedback data with provenance, not raw instructions. | Host |
| Panel UX becomes too crowded | medium | medium | Depend on artifact panel layout validation and Storybook states. | Web |

## 4. Escape Hatches

1. **If native overlay integration is too large:** open Lucid artifacts in the panel as generic HTML with an external-open-to-Lucid action, then add addressability later.
2. **If Trevor event mapping is uncertain:** store a Lucid-compatible per-artifact event log first and bridge to Trevor events after replay semantics are proven.
3. **If shared code boundary is not ready:** use fixture compatibility tests first, then extract shared Lucid packages later.

## 5. Progress Report Accounting

The progress report is `.plans/27-lucid-artifact-integration/progress-report.md`. It tracks Lucid as a consumer of the reusable artifact panel. It does not track the generic artifact panel UX itself.

Before implementation resumes, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "27-lucid-artifact-integration"
```

## 6. Validation Commands

```bash
pnpm test
pnpm --filter @trevor/web test
pnpm --filter @trevor/agent-host test
pnpm typecheck
```

## 7. Decisions

Canonical decisions are in `.plans/27-lucid-artifact-integration/plan.db`. Query them with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "27-lucid-artifact-integration"
```
