# Web Browser-Test Suite - Implementation Plan

## 0. Hard Dependencies

- Existing Storybook 10.4.6 (`@storybook/react-vite`) with the `build-storybook` script, the 48 existing `*.stories.tsx`, and the global centering decorator (`apps/web/.storybook/preview.tsx`).
- Existing `@storybook/addon-a11y` (used for the optional, warn-only a11y pass).
- Existing transcript surfaces Lane B drives: `apps/web/src/components/chat/virtual-transcript.tsx`, `apps/web/src/hooks/use-scroll-follow.ts`, and `apps/web/src/components/panel/PanelHost.tsx` (whose wheel/touch/pointer -> intent -> unpin -> jump round-trip currently has no test).
- Existing **pre-built but unused** perf sink `e2e/virtualization-performance-artifacts.ts` (`VirtualizationPerformanceMetrics`: `bottomDeltaPx`, `keyToPaintSamplesMs`, `mountedRows`, `replayToInteractiveMs`, `totalRows`) - Lane B becomes its producer.
- Existing hermetic boot + deterministic fake provider (`@trevor/agent-host/testing`, `@trevor/test-kit/boot`, the node `e2e/` lane) reused for Lane B's streaming content.
- Existing CI (`.github/workflows/ci.yml`: `ubuntu-latest`, Node 24, pnpm) that the new browser job extends.
- **No hard dependency on plan `09` or `09.1`.** This plan only adds new test infrastructure and exercises already-existing components/stories, so its `09.2` number is ordering (run soon), not a dependency chain - it is startable independently of the in-flight `09` work.

## 1. Architecture

<!-- D-004 --> The suite is **two lanes over one shared Playwright foundation**, not one monolith. Both lanes run headless Chromium inside the pinned `mcr.microsoft.com/playwright` Docker container; they differ only in what they drive and what they assert.

- **Lane A - Storybook visual regression** drives the static `build-storybook` output. For every story it runs a **smoke** check (renders without throwing or going blank) plus a **screenshot diff** against a committed baseline. <!-- D-001 --> The driver is the self-hosted `@storybook/test-runner` (Playwright-based) - **not Chromatic** (no SaaS upload; local-first) and **not** the `addon-vitest` browser mode (kept separate from the jsdom `web` Vitest project; test-runner is the proven screenshot-every-story path). Stories are auto-discovered from the same glob Storybook uses, so **anything added to Storybook is covered with no per-story wiring** - the "required pass over anything added" property.
- **Lane B - app transcript-scroll e2e** drives the **real web app** (`vite preview` against a build, started via Playwright's `webServer`) wired to a booted store + host on ephemeral ports with the deterministic fake provider. It asserts real-layout scroll behavior the jsdom `web` project cannot: pin / stick-to-bottom / mid-stream-no-yank / scroll-up-unpins / jump-to-bottom-re-pins.

<!-- D-005 --> **Lane A ships first.** It needs the least plumbing (`build-storybook` already exists; no app boot to stand up), de-risks the shared Playwright + Docker + CI foundation cheaply, and directly addresses the recurring "open Storybook, it's obviously broken" pain. Smoke alone is insufficient for that pain: the motivating regression (commit `df8d7fe`, a command-menu story whose row list collapsed to zero height) **renders without throwing**, so only a screenshot diff catches it.

**Prior art (V1, `~/dev/trevor`):** V1 has no web UI (it is a Rust TUI), so there is no browser suite to copy - but its TUI test rig informs this design: stories must render the **real production component** (V1 ADR-0001), determinism comes from **fixed geometry + disabled-animation + deterministic artifacts** rather than raw rasters, content is made reproducible by **fixture/fake providers**, the real-app suite is **serialized** under a suite mutex, and waits are **settle-don't-sleep**. V1's missing piece - committed baseline diffing - is exactly Lane A.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| <!-- D-002 --> Baselines are generated in the Playwright Docker container, committed to the repo | macOS-local and ubuntu-CI render fonts differently; container baselines make local == CI. Host-generated baselines would fail every story on ubuntu. |
| <!-- D-003 --> Screenshot diffs use a tolerance threshold (`maxDiffPixelRatio`) | "Looks remotely right", not pixel-perfect: antialiasing noise passes, collapsed/overlapping layouts fail. |
| <!-- D-003 --> Animations/transitions disabled, timestamps/`Math.random` frozen | The 600ms treemap transition and `tw-shimmer` would otherwise capture mid-flight and flake. |
| <!-- D-006 --> Functional assertions gate per-PR; perf metrics are nightly/artifact-only | Machine-variable perf numbers must never turn a PR red/green. |
| <!-- D-007 --> The automated suite never uses tool-proxy `browser-tools` | That integration is single-user interactive; a shared CI suite cannot depend on it. |
| <!-- D-009 --> Lane B is serial (`workers:1`), ephemeral-port, fake-provider, temp-state | Real app + store + host contend for ports/CPU and must stay deterministic. |
| Chromium-only, headless, to start | Keeps CI time and flake surface bounded; a multi-browser matrix is a non-goal. |

### Boundaries

- A **shared Playwright config** owns the container, viewport sizes, and the animations-disabled global; both lanes import it. New browser deps and scripts are additive - the jsdom `web` Vitest project and the node `e2e/` lane are untouched.
- **Lane A** owns story discovery, smoke, screenshot capture/compare, committed baselines, and the optional a11y pass. It does not import app-boot code.
- **Lane B** owns the app `webServer` + hermetic store/host boot, the transcript-scroll assertions, and (nightly) the perf-metric producer that feeds `e2e/virtualization-performance-artifacts.ts`. It does not own the artifact sink itself (that already exists).
- **CI** gets a new browser job separate from the existing `test:unit|integration|web|e2e` steps: it runs the lanes in the pinned container and uploads diff/trace artifacts on failure. The perf producer runs in a separate nightly workflow.

### Observability

- On any Lane A failure, the expected/actual/diff PNGs are uploaded as CI artifacts so a regression is eyeballable without re-running locally.
- On Lane B failure, Playwright trace + screenshot are uploaded; the nightly perf run always emits `summary.json`/`metrics.json`/`screenshot.png`/`performance-trace.json` via the existing artifact writer on budget failure.
- The baseline-update workflow (`--update-snapshots` in-container) is documented so intentional visual changes are a deliberate, reviewable step.

---

## 2. Phases

### Phase 1: Shared foundation + Storybook visual lane (Lane A)

**Goal:** Every Storybook story has a required smoke + threshold-screenshot pass that runs green in CI on ubuntu, with committed container baselines, and any newly added story is auto-covered.

#### M0: Shared Playwright + Docker + CI foundation

- **Dependencies:** hard dependencies
- **Effort:** M
- **Tasks:**
  1. RED: Add a smoke Playwright test that fails until headless Chromium runs in the pinned `mcr.microsoft.com/playwright` container.
  2. GREEN: Add `@playwright/test`, a shared Playwright config (container, viewport, `animations: 'disabled'` global), pin the Docker image, and a pnpm script entry point.
  3. RED: Add a CI assertion that fails if the browser lane does not run in the container on `ubuntu-latest`.
  4. GREEN: Add the browser CI job to `.github/workflows/ci.yml` - install browsers `--with-deps`, run in the pinned container, upload diff/trace artifacts on failure - kept separate from the existing `test:*` steps.
  5. REFACTOR: Factor the shared config so Lane A and Lane B both reuse the container/viewport/animations settings rather than duplicating them.

#### M1: Storybook visual-regression lane

- **Dependencies:** M0
- **Effort:** M
- **Tasks:**
  1. RED: Add a `@storybook/test-runner` smoke pass over `build-storybook` that fails when a story throws or renders blank (characterize against the current build).
  2. GREEN: Add `@storybook/test-runner`, a `test-storybook` pnpm script, and the smoke pass across all 48 stories.
  3. RED: Add a `postVisit` screenshot-diff with a tolerance threshold; commit container-generated baselines for all stories; prove a deliberately broken story (zero-height collapse, the `df8d7fe` class) fails the diff while a no-op change passes.
  4. GREEN: Implement the `postVisit` capture + compare; disable animations/transitions globally and freeze timestamps/`Math.random` in the test-runner preview.
  5. RED: Add a "new story must have a baseline" check - a newly added story with no committed baseline fails the required pass rather than silently passing.
  6. GREEN: Wire baseline-missing as a hard failure so every added story requires a committed baseline.
  7. REFACTOR: Add the optional axe a11y pass via `addon-a11y` in the same `postVisit`, warn-only; document the in-container `--update-snapshots` baseline-update workflow.

### Gate 1 -> 2

- [ ] Lane A green in CI on ubuntu with committed container baselines; the lane is required.
- [ ] A deliberately broken story is caught by the screenshot diff (smoke alone would pass it).
- [ ] A new story with no baseline fails the required pass.
- [ ] The optional a11y pass runs warn-only and does not gate.

### Phase 2: App transcript-scroll e2e lane (Lane B)

**Goal:** The real app's transcript pin/stick-to-bottom/no-yank/jump behavior is asserted against real layout, and the pre-built perf sink has a nightly producer.

#### M2: App boot harness

- **Dependencies:** M0
- **Effort:** M
- **Tasks:**
  1. RED: Add a Playwright test that fails until the real web app serves and loads against a booted store/host with the fake provider.
  2. GREEN: Add a Playwright `webServer` running `vite preview` against a build, booting store + host on ephemeral ports (reuse `@trevor/test-kit/boot` + the fake provider); run serial (`workers:1`).
  3. REFACTOR: Share the hermetic boot (temp state root, ephemeral ports) with the node `e2e/` helpers; rely on Playwright auto-wait + `data-transcript-ready` for settle-don't-sleep.

#### M3: Transcript scroll/pin behavioral assertions

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Failing test - appending while pinned lands the last row at the live edge (assert against real layout via `data-transcript-row-count` / `data-index`).
  2. GREEN: Confirm pinned-append stick-to-bottom (assertions only; behavior already exists in `virtual-transcript.tsx`).
  3. RED: Failing test - scrolling up unpins, a subsequent append does NOT yank the viewport, and the jump-to-bottom affordance appears (the `PanelHost` wheel/touch/pointer intent path).
  4. GREEN: Cover the unpin + jump-button round-trip.
  5. RED: Failing test - a mid-stream growing row keeps `bottomDelta` under threshold while pinned (streaming auto-scroll, no yank).
  6. GREEN: Cover the streaming live-edge follow.
  7. RED: Failing test - explicit jump-to-bottom re-pins and returns to the live edge.
  8. REFACTOR: Extract reusable transcript-driving fixtures (fake-provider streaming scripts) for later app-e2e plans to build on.

#### M4: Perf-artifact producer (nightly/artifact-only)

- **Dependencies:** M3
- **Effort:** S
- **Tasks:**
  1. RED: Add a nightly-only test that produces `VirtualizationPerformanceMetrics` from the real browser run and feeds `e2e/virtualization-performance-artifacts.ts`.
  2. GREEN: Instrument the Playwright run to capture `bottomDeltaPx`/`keyToPaintSamplesMs`/`mountedRows`/`replayToInteractiveMs`/`totalRows` and call `writeVirtualizationPerformanceArtifacts` on budget failure.
  3. REFACTOR: Keep perf metrics OFF the per-PR gate (separate nightly workflow + artifact upload only); document the budget-tuning workflow.

### Gate 2 (done)

- [ ] Transcript pin / stick-to-bottom / no-yank / jump-re-pins assertions are green against the real app.
- [ ] The perf producer runs nightly/artifact-only and never gates a PR.

---

## 3. Non-Goals

- **Pixel-perfect visual matching** - the threshold is deliberate (D-003).
- **Chromatic or any hosted visual SaaS** (D-001).
- **Replacing the jsdom `web` Vitest project or the node `e2e/` lane** - this is additive.
- **tool-proxy `browser-tools` in CI** (D-007) - it stays the single-user interactive/manual path.
- **A multi-browser matrix** - chromium-only headless to start.
- **`addon-vitest` browser mode** - the visual lane is a separate test-runner process (D-001).
- **Broad app-e2e coverage beyond the transcript-scroll target** - other app flows are later plans built on this foundation.

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Screenshot flake across OS/fonts | high | high | Container baselines (D-002), tolerance threshold (D-003), animations disabled | impl |
| Baseline churn becomes a chore | medium | medium | Diff PNG artifacts on failure; documented in-container `--update-snapshots` workflow | impl |
| Lane B port/CPU contention or nondeterminism | medium | medium | Serial `workers:1`, ephemeral ports, hermetic temp state, fake provider (D-009) | impl |
| Perf metrics falsely gating PRs | medium | low | Nightly/artifact-only, never red/green on PRs (D-006) | impl |
| CI wall-clock growth | low | medium | Chromium-only, reuse `build-storybook`, shard test-runner if needed | impl |

---

## Escape Hatches

1. **If container baselines still flake on ubuntu:** raise `maxDiffPixelRatio` per-story and/or mask the noisy region before falling back to smoke-only for that story (logged, not silent).
2. **If Lane B boot proves too heavy for per-PR:** keep Lane B nightly and gate only Lane A per-PR, until the boot is hardened.
3. **If test-runner screenshotting underperforms at 48+ stories:** shard the run across CI workers before considering `addon-vitest`.

---

## Progress Report Accounting

The progress report (`progress-report.md`) is the implementation resume state. Current cutoff blockers count only active unchecked work; the lanes are sequenced (Lane A / Phase 1 first per D-005). Run `plan-db check-progress --plan "09.2-web-browser-test-suite"` before resuming or declaring convergence.

---

## Validation Commands

```bash
# Lane A (in the pinned Playwright container)
pnpm build-storybook && pnpm test-storybook
pnpm test-storybook --update-snapshots   # regenerate baselines after an intentional change

# Lane B
pnpm test:e2e:browser

# existing lanes remain unchanged
pnpm test:unit && pnpm test:integration && pnpm test:web && pnpm test:e2e
```

---

## Decisions

Canonical decisions are in the plan database (`.plans/09.2-web-browser-test-suite/plan.db`). Query with:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "09.2-web-browser-test-suite"
```

Key decisions referenced in this document use `<!-- D-NNN -->` markers (D-001 tool, D-002 baselines, D-003 tolerance, D-004 two lanes, D-005 lane order, D-006 perf gating, D-007 tool-proxy exclusion, D-008 a11y, D-009 Lane B boot).
