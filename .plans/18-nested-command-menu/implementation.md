# Nested Command Menu - Implementation Plan

## 0. Hard Dependencies

- [ ] `03-filesystem-root-taxonomy` - `/style` selection persistence must use the approved Trevor user/settings root.

## 1. Architecture

Trevor needs a reusable hierarchical command menu pattern, not a one-off output-style UI. The shared pattern lets a host-owned command family expose parent choices, child choices, actions, disabled states, and metadata through a structured contract. Trevor web renders that contract with one command-menu component instead of hardcoding custom UI for every command family.

The first consumer is `/style`: a nested command menu for selecting assistant output style. This replaces the old deferred "output-style registry" shape from the umbrella plan. Styles are user-selected command choices, not prompt overlays, not routing hints, and not a permission system.

### Key Constraints

| Constraint | Impact |
|---|---|
| Reusable pattern first | `/style` must not ship as a bespoke picker that cannot be reused by other command families. |
| Host-owned command metadata | Web renders structured menu state; it does not invent command hierarchy or style lists locally. |
| Nested command choices | Parent rows, child rows, breadcrumbs/back, search, keyboard navigation, disabled states, and empty states are first-class. |
| No model turn for menu actions | Opening the menu and selecting host-owned immediate actions must not create a model-visible turn. |
| Output style is presentation-only | Style selection can influence answer shape, but never model selection, tools, permissions, agents, execution mode, routing, or validation policy. |
| No prompt overlay concept | User-facing and plan vocabulary is command-menu choice, active style preference, and response-shape guidance. |

### Boundaries

- **Host command contract:** owns command-family descriptors, nested menu nodes, action ids, disabled reasons, and result payloads.
- **Trevor web:** renders generic nested command menus from host data and sends selected actions back through the command path.
- **`/style` command family:** first consumer. It exposes list/select/reset/default choices and returns structured results.
- **Preference storage:** persists explicit style selection only through the root policy from `03-filesystem-root-taxonomy`.
- **Model/run context:** receives only the active style facts needed to shape the next answer; it must not infer tool, model, or routing changes from style.

### Observability

This is UI and command-contract work, not provider/transport recovery work. Observability should stay lightweight:

- command result payloads include command family, action id, selected style id when relevant, and success/failure status
- `/doctor` or debug output can report active style id/source and invalid persisted style fallback
- tests prove menu actions do not create model turns or conversation-memory events unless a future command explicitly defines that behavior

## 2. Phases

### Phase 1: Generic Nested Command Menu Contract

**Goal:** A command family can describe hierarchical choices without bespoke web code.

**Gate from previous:** `03-filesystem-root-taxonomy` is complete or accepted as the persistence contract for later `/style` storage.

#### M1: Command Menu Data Model

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add protocol/contract tests for a nested command-menu payload with parent rows, child rows, action ids, disabled reasons, breadcrumbs, and search metadata.
  2. GREEN: Define the shared structured payload and decode/encode helpers.
  3. RED: Add tests for invalid/missing fields and backward-compatible command-result handling.
  4. GREEN: Make command results tolerate nested-menu payloads without breaking existing slash command results.
  5. REFACTOR: Centralize command-family/menu types so future command families do not duplicate shape definitions.

#### M2: Generic Web Renderer

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add Storybook states for root menu, child menu, breadcrumb/back, search, disabled rows, empty state, long labels, narrow viewport, and keyboard navigation.
  2. GREEN: Build the reusable nested command-menu component using the existing shared command modal foundation.
  3. RED: Add web tests for keyboard navigation, back behavior, selection, disabled row behavior, search, and accessible labels.
  4. GREEN: Wire the generic renderer to structured command-menu payloads.
  5. REFACTOR: Keep command-specific label/icon/action mapping in data, not component branches.

#### M3: Command Execution Semantics

- **Dependencies:** M1, M2
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving opening a nested menu and selecting an immediate host action does not start a model turn.
  2. GREEN: Route menu action selection through the host command action path with stable action ids.
  3. RED: Add tests for stale/unknown action ids, disabled actions, and command-family errors.
  4. GREEN: Return structured success/error results that the transcript can render without exposing raw internals.
  5. REFACTOR: Share the action dispatch path with existing immediate slash command behavior where practical.

### Phase 2: `/style` as First Consumer

**Goal:** Output style selection uses the nested command-menu pattern and persists as a presentation preference.

**Gate from previous:** Phase 1 gate passes and the approved user/settings root is available.

#### M4: Style Metadata and Menu Choices

- **Dependencies:** M1, M2
- **Effort:** M
- **Tasks:**
  1. RED: Add host tests for style metadata: stable id, label, description, active state, default marker, and source.
  2. GREEN: Define built-in styles as host-owned metadata for `/style` choices.
  3. RED: Add tests proving styles are exposed through nested command-menu rows and not hardcoded in web.
  4. GREEN: Implement bare `/style` as a menu payload with select/reset/default actions.
  5. REFACTOR: Keep style metadata reusable by settings, `/doctor`, and future capability surfaces.

#### M5: Style Preference Persistence and Run Attribution

- **Dependencies:** M4, `03-filesystem-root-taxonomy`
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for user-selected style persistence under the approved Trevor settings root.
  2. GREEN: Persist active style id and source, with fallback to default for unknown or retired ids.
  3. RED: Add tests proving each run records active style id/source at turn start.
  4. GREEN: Attach active style attribution to run diagnostics/transcript inspection without changing already-started turns.
  5. REFACTOR: Keep style preference separate from provider/model/reasoning preferences.

#### M6: Presentation-Only Enforcement

- **Dependencies:** M4, M5
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving style changes do not alter tool inventory, model/source, reasoning level, agent/subagent selection, or execution mode.
  2. GREEN: Thread active style facts only through response-shape guidance and run attribution.
  3. RED: Add evals or prompt tests for at least concise, diagnostic, reviewer, explanatory, and default behavior.
  4. GREEN: Make style-specific response guidance observable enough for tests without exposing it as user-facing prompt configuration.
  5. REFACTOR: Remove any accidental coupling between style id and routing/policy decisions.

### Phase 3: Reuse and Integration

**Goal:** The nested menu is demonstrably reusable beyond `/style`.

**Gate from previous:** `/style` works through the generic menu without bespoke web branches.

#### M7: Second Fixture Consumer

- **Dependencies:** M1-M3
- **Effort:** S
- **Tasks:**
  1. RED: Add a fake or fixture command family that uses two-level nested choices independent of `/style`.
  2. GREEN: Render and execute the fixture through the same generic component and action path.
  3. RED: Add tests proving command-family-specific data changes behavior without code changes.
  4. GREEN: Document how future command families should define nested menus.
  5. REFACTOR: Extract any remaining `/style` assumptions from shared menu code.

#### M8: Verification

- **Dependencies:** M1-M7
- **Effort:** M
- **Tasks:**
  1. RED: Add integration tests for menu payload round-trip, web rendering, action dispatch, and transcript result rendering.
  2. GREEN: Ensure `/style` menu selection, reset/default, persistence, and run attribution pass.
  3. RED: Add accessibility and keyboard regression tests for nested navigation.
  4. GREEN: Verify Storybook states at mobile and desktop widths.
  5. REFACTOR: Tighten names and docs so future plans can depend on the nested command-menu pattern directly.

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---:|---:|---|---|
| `/style` becomes a bespoke component | medium | medium | Require a second fixture consumer and tests that shared menu code has no style-specific branches. | Web |
| Style selection leaks into routing/policy | high | medium | Add enforcement tests for model/tool/reasoning/agent invariants. | Host |
| Menu payload becomes too generic to render well | medium | medium | Keep a narrow v1 schema: sections, rows, actions, breadcrumbs, search, disabled reasons. | Host/Web |
| Persisted styles drift from available metadata | medium | low | Unknown ids fall back to default and are reported in diagnostics. | Host |

## 4. Escape Hatches

1. **If the generic schema is too broad:** narrow v1 to exactly two menu levels plus breadcrumbs, then expand later.
2. **If style guidance is hard to test deterministically:** keep run attribution and policy-invariant tests as the hard gate, and add model-response evals as a gated follow-up.
3. **If persistence is blocked:** ship the reusable menu and `/style` preview/listing first, but do not mark `/style` selection complete until persistence lands.

## 5. Progress Report Accounting

The progress report is `.plans/18-nested-command-menu/progress-report.md`. It tracks only current-cutoff work for the reusable nested menu and `/style` first consumer. Future command families that may reuse the pattern are not blockers unless explicitly promoted into this plan.

Before implementation resumes, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "18-nested-command-menu"
```

## 6. Validation Commands

```bash
pnpm test
pnpm --filter @trevor/web test
pnpm --filter @trevor/agent-host test
pnpm typecheck
```

## 7. Decisions

Canonical decisions are in `.plans/18-nested-command-menu/plan.db`. Query them with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "18-nested-command-menu"
```
