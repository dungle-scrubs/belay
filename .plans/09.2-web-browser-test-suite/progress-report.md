# Web Browser-Test Suite - Progress Report

## Summary

> Current focus: M0: Shared Playwright + Docker + CI foundation

- Total checklist items: 39
- Completed: 7
- Current cutoff blockers: 32

## 0. Hard Dependencies

- [x] Existing Storybook 10.4.6 (`@storybook/react-vite`), `build-storybook`, 48 stories, global centering decorator
- [x] Existing `@storybook/addon-a11y` (optional warn-only a11y pass)
- [x] Existing `virtual-transcript.tsx` + `use-scroll-follow.ts` + `PanelHost.tsx` (Lane B targets)
- [x] Existing `e2e/virtualization-performance-artifacts.ts` perf sink (Lane B becomes its producer)
- [x] Existing fake provider + hermetic store/host boot (`@trevor/agent-host/testing`, `@trevor/test-kit/boot`)
- [x] Existing CI (`.github/workflows/ci.yml`: ubuntu-latest, Node 24, pnpm)
- [x] No hard dependency on plan `09` / `09.1` (additive test infra over existing surfaces)

## Phase 1: Shared foundation + Storybook visual lane (Lane A)

### M0: Shared Playwright + Docker + CI foundation

- [ ] RED: Add a smoke Playwright test that fails until headless Chromium runs in the pinned `mcr.microsoft.com/playwright` container
- [ ] GREEN: Add `@playwright/test`, a shared Playwright config (container, viewport, `animations: 'disabled'`), pin the Docker image, add a pnpm script
- [ ] RED: Add a CI assertion that fails if the browser lane does not run in the container on `ubuntu-latest`
- [ ] GREEN: Add the browser CI job to `.github/workflows/ci.yml` (install browsers `--with-deps`, run in container, upload diff/trace artifacts on failure), separate from existing `test:*` steps
- [ ] REFACTOR: Factor the shared config so Lane A and Lane B reuse container/viewport/animations settings

### M1: Storybook visual-regression lane

- [ ] RED: Add a `@storybook/test-runner` smoke pass over `build-storybook` that fails when a story throws or renders blank
- [ ] GREEN: Add `@storybook/test-runner`, a `test-storybook` pnpm script, and the smoke pass across all 48 stories
- [ ] RED: Add a `postVisit` screenshot-diff with a tolerance threshold; commit container-generated baselines; prove a deliberately broken story (zero-height collapse) fails the diff
- [ ] GREEN: Implement `postVisit` capture + compare; disable animations/transitions globally; freeze timestamps/`Math.random`
- [ ] RED: Add a "new story must have a baseline" check - a new story with no baseline fails the required pass
- [ ] GREEN: Wire baseline-missing as a hard failure
- [ ] REFACTOR: Add the optional axe a11y pass via `addon-a11y` (warn-only); document the in-container `--update-snapshots` workflow

### Gate 1 -> 2

- [ ] Lane A green in CI on ubuntu with committed container baselines; lane required
- [ ] A deliberately broken story is caught by the screenshot diff
- [ ] A new story with no baseline fails the required pass
- [ ] The optional a11y pass runs warn-only and does not gate

## Phase 2: App transcript-scroll e2e lane (Lane B)

### M2: App boot harness

- [ ] RED: Add a Playwright test that fails until the real app serves and loads against a booted store/host with the fake provider
- [ ] GREEN: Add a Playwright `webServer` running `vite preview`, booting store + host on ephemeral ports (reuse `@trevor/test-kit/boot` + fake provider), serial `workers:1`
- [ ] REFACTOR: Share hermetic boot (temp state root, ephemeral ports) with node `e2e/` helpers; settle via Playwright auto-wait + `data-transcript-ready`

### M3: Transcript scroll/pin behavioral assertions

- [ ] RED: Failing test - append while pinned lands the last row at the live edge (real layout via `data-transcript-row-count`/`data-index`)
- [ ] GREEN: Confirm pinned-append stick-to-bottom (assertions only; behavior exists)
- [ ] RED: Failing test - scroll up unpins, a subsequent append does NOT yank, jump-to-bottom appears (`PanelHost` intent path)
- [ ] GREEN: Cover the unpin + jump-button round-trip
- [ ] RED: Failing test - mid-stream growing row keeps `bottomDelta` under threshold while pinned
- [ ] GREEN: Cover the streaming live-edge follow
- [ ] RED: Failing test - explicit jump-to-bottom re-pins and returns to the live edge
- [ ] REFACTOR: Extract reusable transcript-driving fixtures for later app-e2e plans

### M4: Perf-artifact producer (nightly/artifact-only)

- [ ] RED: Add a nightly-only test that produces `VirtualizationPerformanceMetrics` from the real browser run and feeds the artifact sink
- [ ] GREEN: Capture `bottomDeltaPx`/`keyToPaintSamplesMs`/`mountedRows`/`replayToInteractiveMs`/`totalRows` and call `writeVirtualizationPerformanceArtifacts` on budget failure
- [ ] REFACTOR: Keep perf metrics off the per-PR gate (nightly workflow + artifact upload); document budget tuning

### Gate 2 (done)

- [ ] Transcript pin / stick-to-bottom / no-yank / jump-re-pins assertions green against the real app
- [ ] Perf producer runs nightly/artifact-only, never gates a PR
