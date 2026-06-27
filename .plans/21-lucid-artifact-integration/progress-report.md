# Lucid Artifact Integration - Progress Report

> Current focus: Hard Dependencies

## Summary

- Current cutoff blockers: 46
- Deferred follow-up: 0
- Superseded checklist debt: 0

## Hard Dependencies

- [ ] `20-artifact-panel-ux` complete before Lucid native panel integration starts

## M1: Artifact Kind and Metadata

- [ ] RED: Add protocol/model tests for a Lucid artifact kind with HTML ref, version, title, provenance, and review status
- [ ] GREEN: Define Lucid artifact metadata and viewer registry entry
- [ ] RED: Add tests for old/plain HTML artifacts degrading to non-addressable HTML viewer
- [ ] GREEN: Distinguish Lucid-addressable HTML from generic HTML
- [ ] REFACTOR: Keep Lucid metadata separate from ordinary blob `ArtifactRef` fields

## M2: Generation and Open Path

- [ ] RED: Add tests for generated Lucid artifact event opening in the artifact panel
- [ ] GREEN: Publish/generated Lucid artifacts as panel-openable Trevor artifacts
- [ ] RED: Add tests proving no separate `lucid open` browser tab is required in the Trevor path
- [ ] GREEN: Mount artifact inside panel viewer and expose safe external-open fallback
- [ ] REFACTOR: Keep generation path compatible with existing Lucid CLI artifacts where possible

## M3: Overlay Mount and Isolation

- [ ] RED: Add browser tests for rendering a Lucid HTML artifact in an isolated iframe/panel surface
- [ ] GREEN: Mount Lucid overlay/addressability layer inside the panel's HTML viewer
- [ ] RED: Add tests for artifact CSS/JS not breaking Trevor panel chrome
- [ ] GREEN: Enforce sandbox/isolation and defensive overlay mounting
- [ ] REFACTOR: Share Lucid overlay code with `~/dev/lucid` where practical

## M4: Element and Text-Range Annotation

- [ ] RED: Add tests for element hover/click targeting and text-range selection inside the panel
- [ ] GREEN: Implement annotation composer flow in the panel
- [ ] RED: Add tests for anchors and duplicate id handling
- [ ] GREEN: Preserve anchor resolution behavior and orphan failed anchors safely
- [ ] REFACTOR: Keep annotation state independent from transcript message rendering

## M5: Feedback Events and Agent Consumption

- [ ] RED: Add protocol tests for located feedback events and cursor/order
- [ ] GREEN: Persist Lucid feedback in Trevor session events or a Lucid-compatible per-artifact event log
- [ ] RED: Add tests proving feedback is structured data, not blindly injected as instructions
- [ ] GREEN: Make located feedback available to the active agent/resume flow with provenance
- [ ] REFACTOR: Keep feedback folding deterministic across replay and reconnect

## M6: Versions, Revisions, and Review Status

- [ ] RED: Add tests for new versions, live reload, anchor re-resolution, orphan tray, review resolved, and review reopened
- [ ] GREEN: Track Lucid artifact versions and review lifecycle in Trevor
- [ ] RED: Add tests for stale annotation drafts when a new version arrives
- [ ] GREEN: Preserve or defer draft annotations safely during version swaps
- [ ] REFACTOR: Share version/review vocabulary with Lucid docs where possible

## M7: Panel UX and Transcript Relationship

- [ ] RED: Add Storybook states for Lucid artifact open, annotation drafting, queued annotations, orphaned annotations, review resolved, and narrow/wide panel
- [ ] GREEN: Build native Trevor panel UI around the Lucid surface
- [ ] RED: Add tests proving transcript stays readable and agent status remains visible while reviewing
- [ ] GREEN: Wire transcript artifact cards to focus the matching Lucid panel session
- [ ] REFACTOR: Avoid duplicating Lucid standalone chrome where Trevor panel chrome owns interaction

## M8: External Lucid Compatibility

- [ ] RED: Add compatibility tests for importing/opening an existing Lucid artifact/session from `~/dev/lucid` output
- [ ] GREEN: Support safe external-open or import for Lucid CLI artifacts
- [ ] RED: Add tests proving Trevor integration does not break standalone Lucid CLI contract
- [ ] GREEN: Keep shared protocol/library boundaries documented
- [ ] REFACTOR: Move reusable Lucid pieces to a stable package boundary if needed

## M9: End-to-End Review Loop

- [ ] RED: Add E2E test for generating a Lucid artifact, opening the panel, adding located feedback, and exposing it to the agent flow
- [ ] GREEN: Implement full happy path with deterministic fixtures
- [ ] RED: Add E2E tests for orphaned annotation, version reload, review resolved, and panel close/reopen
- [ ] GREEN: Verify resilience across refresh/replay and active turn boundaries
- [ ] REFACTOR: Document manual EZE repro steps and compatibility expectations
