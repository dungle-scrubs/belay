# Action Shimmer Status - Implementation Plan

## 0. Hard Dependencies

- [x] Existing web transcript `WorkingIndicator` and tool rendering in `apps/web/src/components/chat/message.tsx`.
- [x] Existing assistant-ui Tailwind shimmer pattern already present in `apps/web/src/components/assistant-ui/tool-group.tsx` and documented at https://www.assistant-ui.com/tw-shimmer.
- [x] Existing V1 action vocabulary references in `~/dev/trevor`: `Working...`, `Exploring...`, `Classifying with ...`, `applying steering`, and tool progress labels such as archive unpacking/summarizing.

## 1. Architecture

Replace generic `working...`/pulse-dot placeholders with a reusable shimmer text indicator whose label reflects the current action. The shimmer is a visual treatment; the important product change is the action label projection. Users should see "thinking", "applying steering", "reading apps/web/src/App.tsx", "searching useSlashMenu", "running pnpm test", "classifying with …", or "summarizing archive" when the event stream gives enough evidence.

The label source should be deterministic and host/web owned. Do not infer free-form user intent with fuzzy prose matching. Derive labels from structured events already in the transcript: active turn status, tool name/input, tool progress events, provider/reconnect/recovery events, shell lane status, compaction progress, and future background-process/subagent snapshots.

### Boundaries

| Boundary | Owns | Does not own |
|---|---|---|
| Action label projection | Maps typed transcript/session events to short present-progress text | Styling or animation |
| Shimmer indicator component | Tailwind shimmer rendering, reduced-motion fallback, elapsed/interruptible meta | Event interpretation |
| Tool renderers | Pass structured tool name/input/status into projection | Reimplement shimmer |
| Host progress events | Emit structured labels where the host has exclusive knowledge | UI animation |

### Key Decisions

- Use assistant-ui's Tailwind shimmer approach rather than pulse dots for active textual status.
- Preserve the elapsed timer and `esc to interrupt` metadata for interruptible turns.
- Prefer structured labels from events over guessing from assistant text.
- Pull V1 labels as a vocabulary guide, not as a direct port: `Working...` becomes the fallback only when no better structured action is available.
- Storybook-first: visual and label states are proven before live transcript integration.

## 2. Phases

### Phase 1: Shimmer Primitive and Stories

**Goal:** A production-ready shimmer status component exists with all important visual states.

#### M1: Shimmer Component

- **Dependencies:** hard dependencies
- **Effort:** S
- **Tasks:**
  1. RED: Add Storybook states for fallback working, thinking, applying steering, reading file, searching text, running shell, classifying, reconnecting, and reduced motion.
  2. GREEN: Build a reusable `ActionShimmer`/`WorkingIndicator` replacement using assistant-ui's `shimmer` class pattern.
  3. RED: Component tests verify label text, elapsed meta, interruptible meta, reduced-motion fallback, and stable layout width behavior.
  4. GREEN: Preserve existing `WorkingIndicator` public call sites through a compatibility wrapper or controlled migration.
  5. REFACTOR: Remove pulse-dot-only assumptions from the component API.

### Phase 2: Action Label Projection

**Goal:** The UI can derive useful present-progress labels from structured session/transcript state.

#### M2: Projection Rules

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Unit-test label projection for active turn status, steering, assistant reconnect/recovery, silent streaming, and fallback working.
  2. GREEN: Add pure projection helpers for turn-level action labels.
  3. RED: Unit-test tool labels for read, glob, grep, bash, write/edit/multi_edit, web search, docs, skill, process, and unknown tool fallback.
  4. GREEN: Add tool-label helpers using structured tool name/input and V1 vocabulary as reference.
  5. REFACTOR: Keep projection pure and shared by compact transcript rows and full transcript rows.

#### M3: Host Progress Labels

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Protocol tests cover `assistant.progress`, `tool.progress`, reconnecting, recovery, and compaction progress label fields.
  2. GREEN: Preserve existing protocol labels and add missing structured labels only where host-owned context is required.
  3. RED: Host tests verify archive read/unpack labels, steering labels, provider reconnect labels, and no raw/debug-only text leaks into user status.
  4. GREEN: Route host-owned labels into transcript projection without making the web parse prose output.
  5. RED: Regression tests ensure labels remain short and do not include secrets, huge command lines, or multiline payloads.
  6. GREEN: Add truncation/redaction rules for label fragments.
  7. REFACTOR: Deduplicate any V1-derived keyword tables into a small V2 label map.

### Phase 3: Transcript Integration

**Goal:** All current "working" surfaces use shimmer and context-specific action text.

#### M4: Live UI Wiring

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Web transcript tests cover initial silent turn, running tool body, shell running, concurrent tool batch, compaction, reconnect, and cancellation.
  2. GREEN: Replace `WorkingIndicator` rendering in transcript rows and status-aware tool renderers.
  3. RED: Storybook interaction/visual tests verify shimmer in message rows, running tool rows, and compact row candidates.
  4. GREEN: Apply shimmer consistently across transcript status rows without animating settled rows.
  5. RED: Accessibility tests verify the label is readable text and animation is hidden from screen-reader duplication.
  6. REFACTOR: Keep active state data available to the future tool-detail takeover and compact transcript layout.

#### M5: Validation and E2E

- **Dependencies:** M4
- **Effort:** S
- **Tasks:**
  1. RED: Add live EZE test notes for a silent model delay, a running read/search tool, a long bash command, and a reconnect/recovery event.
  2. GREEN: Run Storybook and web tests; inspect desktop and narrow viewport screenshots.
  3. RED: Add reduced-motion test coverage.
  4. GREEN: Confirm no remaining user-facing literal `working...` placeholders except fallback copy.
  5. REFACTOR: Document the label vocabulary and source priority.

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation |
|---|---:|---:|---|
| Labels become misleading when derived from stale events | high | medium | Projection should use newest active run/tool state and stop at completion events |
| Shimmer creates accessibility or motion problems | medium | medium | Reduced-motion fallback, no duplicated screen-reader text, no layout shift |
| Tool inputs leak sensitive or huge text into labels | high | low | Redact/truncate labels and prefer path/query summaries over raw JSON |
| Label projection duplicates future compact transcript logic | medium | medium | Keep projection pure and shared by compact/full transcript rows |

## 4. Progress Report Accounting

Use `.plans/32-action-shimmer-status/progress-report.md` as the implementation resume state. Before resuming implementation, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "32-action-shimmer-status"
```

## 5. Validation Commands

```bash
pnpm --filter @trevor/web test -- --project web apps/web/src/components/chat/message.test.tsx
pnpm --filter @trevor/web test -- --project web apps/web/src/transcript.test.ts
pnpm --filter @trevor/agent-host test -- --project unit apps/agent-host/src/turn.test.ts
pnpm --filter @trevor/web storybook
pnpm test -- --project e2e
```

## 6. Decisions

Canonical decisions are in `.plans/32-action-shimmer-status/plan.db`. Query with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "32-action-shimmer-status"
```
