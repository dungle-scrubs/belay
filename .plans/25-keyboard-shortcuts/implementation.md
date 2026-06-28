# Keyboard Shortcuts - Implementation Plan

## 0. Hard Dependencies

- [ ] `24-vim-motions-ui` - shortcut routing must coordinate with Vim insert/normal/visual key ownership.
- [ ] `03-filesystem-root-taxonomy` - the Vim toggle command persists by editing the Trevor config under `TREVOR_HOME`, defaulting to `~/.trevorV2`.
- [x] `18-nested-command-menu` - reusable nested command-menu/row chooser patterns exist for command-like surfaces.
- [x] `apps/web/HOTKEYS.md` - cross-platform browser/OS shortcut ledger exists and is the policy source.

## 1. Architecture

Trevor needs a keyboard shortcut system that behaves like a browser-hosted productivity app: useful app-level commands, but never at the cost of text editing, browser conventions, or the frontmost surface. The shortcut layer must prevent the observed class of bug where a key interacts with a surface behind the modal/menu/panel currently in front.

This plan introduces a central shortcut router and a small command palette opened by `Mod+K` (`Cmd+K` on macOS, `Ctrl+K` on Windows/Linux). The first palette action is a Vim-mode toggle that persists by editing Trevor's config under `TREVOR_HOME` (`~/.trevorV2` by default). The plan uses `apps/web/HOTKEYS.md` as the living policy ledger for browser/OS conflicts and every Trevor-owned binding.

### Key Constraints

| Constraint | Impact |
|---|---|
| Frontmost surface wins | A key event can affect only the modal/menu/panel/composer layer that owns focus; surfaces behind it never react. |
| Vim is always considered | In insert mode, first `Esc` enters normal mode and does not cancel/close anything behind the composer. |
| Browser conventions are constraints | Do not bind keys users expect browsers to own unless explicitly classified and scoped. |
| `Mod` is the primary app modifier | `Cmd` on macOS, `Ctrl` on Windows/Linux; avoid raw `Ctrl` and avoid `Alt`/`Option` for first-class shortcuts. |
| `apps/web/HOTKEYS.md` is the source ledger | Every new shortcut updates the ledger in the same change. |
| Config writes are host-owned | Browser UI requests config mutation; it does not write `~/.trevorV2` directly. |

### Shortcut Policy Classes

Every candidate shortcut is classified before implementation:

| Class | Meaning | Example |
|---|---|---|
| `safe` | Free across macOS, Windows, Linux baseline browsers | `Mod+Enter`, `Mod+/` |
| `contextual` | Safe only when a specific Trevor surface is focused/open | composer-only submit, command-menu navigation |
| `rude` | Technically interceptable but violates browser/user expectation | `Mod+P`, `Mod+F`, `Mod+S` |
| `reserved` | Browser/OS owns it; Trevor must not depend on receiving it | `Mod+T`, `Mod+W`, tab switching |

`Mod+K` is accepted as the command-palette binding even though `Ctrl+K` is an omnibox/search shortcut on Windows/Linux. It must be scoped to the focused app, call `preventDefault()`, and be verified in supported browsers.

### Initial Binding Set

| Shortcut | Action | Policy |
|---|---|---|
| `Mod+K` | Open command palette | accepted takeover, documented and tested |
| `Mod+Enter` | Submit composer where composer owns focus | contextual/safe |
| `Mod+/` | Open shortcuts help | safe |
| `Mod+\` | Toggle left sidebar | candidate, verify browser/Arc/Zen behavior |
| `Mod+Shift+\` | Toggle right panel | candidate, verify browser/Arc/Zen behavior |
| `Mod+.` | Stop/cancel active run | candidate, explicit non-Escape stop path |

The first implemented command-palette action is:

```text
Toggle Vim mode
```

It flips the persisted `vim.enabled` preference in Trevor config under `TREVOR_HOME`. The app must reflect the new setting without a restart when possible, while the config file remains the source of truth.

### Focus and Surface Routing

Shortcut routing uses an ordered surface stack:

```text
command palette
modal/dialog
artifact panel / carousel
composer and Vim layer
left/right sidebars
global app
```

Only the frontmost eligible surface handles a key. Handlers return one of:

```text
handled       key consumed; stop propagation/prevent default if needed
pass          this surface does not own the key; next eligible layer may decide
blocked       no action, but do not let lower layers see it
```

### Escape Policy

Escape is routed, not treated as a flat global shortcut:

1. If Vim-enabled composer is focused and in insert mode: `Esc` only changes to normal mode.
2. If Vim visual mode is active: `Esc` leaves visual mode for normal mode.
3. If a command palette, modal, menu, carousel, or frontmost panel owns Escape: close/dismiss that surface.
4. If no front surface owns Escape: existing cancel/clear behavior may run.

### Boundaries

- **Shortcut router:** owns global keydown listener, platform `Mod` normalization, surface stack dispatch, and focus guards.
- **Surface adapters:** each frontmost UI layer declares which keys it owns and whether it blocks lower layers.
- **Command palette:** owns searchable command rows and invokes registered commands.
- **Config command bridge:** owns Vim toggle persistence through host/config APIs.
- **HOTKEYS ledger:** documents current app bindings and policy classification.

### Observability

- Shortcut conflicts should be test-visible through router unit tests, not runtime logs.
- Debug-only development traces may show which surface handled a key, but ordinary users should not see shortcut routing logs.
- `/doctor` may eventually report malformed config, but this plan does not require a new doctor surface.

## 2. Phases

### Phase 1: Policy Ledger and Router Foundation

**Goal:** Establish the shortcut policy and a router that prevents behind-surface key handling.

**Gate from previous:** `apps/web/HOTKEYS.md` exists.

#### M1: HOTKEYS Policy Ledger Update

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add a check/test that expected Trevor bindings are represented in `apps/web/HOTKEYS.md`.
  2. GREEN: Extend `apps/web/HOTKEYS.md` with policy classes, accepted `Mod+K` takeover rationale, and candidate bindings.
  3. RED: Add tests or lint fixtures proving undocumented shortcut registrations fail.
  4. GREEN: Add a declarative shortcut registry that can be compared to the ledger.
  5. REFACTOR: Keep browser/OS reservation notes separate from Trevor-owned binding rows.

#### M2: Central Shortcut Router and Focus Guards

- **Dependencies:** M1
- **Effort:** L
- **Tasks:**
  1. RED: Add router tests for frontmost-surface ordering: command palette, modal/dialog, artifact carousel, composer, panels, global app.
  2. GREEN: Implement a central shortcut router with `handled` / `pass` / `blocked` semantics.
  3. RED: Add tests proving shortcuts do not fire behind a modal/menu/panel or from ordinary text-editing fields unless explicitly allowed.
  4. GREEN: Add focus guards for `input`, `textarea`, `contenteditable`, command search fields, and code-like editors.
  5. REFACTOR: Remove scattered global shortcut assumptions from individual components where the router can own them.

### Phase 2: Command Palette and Vim Toggle

**Goal:** Ship the first user-facing shortcut surface: `Mod+K` opens a command palette with a persisted Vim toggle.

**Gate from previous:** Shortcut router blocks behind-surface interaction.

#### M3: Command Palette Shell

- **Dependencies:** M1-M2, `18-nested-command-menu`
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving `Mod+K` opens the command palette and prevents the browser action when the app is focused.
  2. GREEN: Implement the command palette using the existing command-menu pattern.
  3. RED: Add tests for palette frontmost routing: while open, palette keys do not leak to composer, sidebars, transcript, or panels.
  4. GREEN: Register palette navigation, selection, close, and empty-state behavior.
  5. REFACTOR: Keep palette commands data-driven so later actions do not need bespoke key handlers.

#### M4: Persisted Vim Toggle Command

- **Dependencies:** M3, `24-vim-motions-ui`, `03-filesystem-root-taxonomy`
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for a command-palette `Toggle Vim mode` action reading current config state.
  2. GREEN: Add the palette command and display current enabled/disabled status.
  3. RED: Add host/config tests proving toggling edits the Trevor config under `TREVOR_HOME` (`~/.trevorV2` by default) with override support.
  4. GREEN: Persist `vim.enabled` through the host-owned config mutation path and refresh the web setting.
  5. REFACTOR: Keep config read/write logic shared with `24-vim-motions-ui`.

#### M5: Vim and Escape Integration

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add tests proving Vim insert-mode `Esc` switches to normal mode and does not cancel a run or close a behind surface.
  2. GREEN: Route Escape through the Vim layer before global cancel/clear behavior.
  3. RED: Add tests for Vim normal/visual Escape behavior, palette Escape, modal Escape, and global Escape ordering.
  4. GREEN: Implement Escape precedence exactly once in the shortcut router.
  5. REFACTOR: Document Escape ownership in `apps/web/HOTKEYS.md`.

### Phase 3: Core App Bindings

**Goal:** Add the first stable Trevor shortcut set without violating browser conventions.

**Gate from previous:** command palette + Vim toggle are working.

#### M6: Submit and Shortcuts Help

- **Dependencies:** M1-M5
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for `Mod+Enter` submit only when composer owns focus and submit is valid.
  2. GREEN: Implement `Mod+Enter` as a composer-owned shortcut.
  3. RED: Add tests for `Mod+/` opening shortcuts help without leaking to underlying surfaces.
  4. GREEN: Implement a shortcuts help surface generated from the shortcut registry and HOTKEYS policy metadata.
  5. REFACTOR: Ensure help text reflects platform-specific `Cmd` vs `Ctrl` labels.

#### M7: Panel Toggles

- **Dependencies:** M1-M6
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for left-sidebar toggle candidate `Mod+\` respecting focus guards and frontmost surfaces.
  2. GREEN: Implement the left-sidebar toggle if browser verification passes.
  3. RED: Add tests for right-panel toggle candidate `Mod+Shift+\` respecting focus guards and frontmost surfaces.
  4. GREEN: Implement the right-panel toggle if browser verification passes.
  5. REFACTOR: Update `apps/web/HOTKEYS.md` with final accepted panel bindings or rejected alternatives.

#### M8: Stop/Cancel Binding Decision

- **Dependencies:** M1-M6
- **Effort:** S
- **Tasks:**
  1. RED: Add tests for candidate `Mod+.` behavior when a run is active, queued, or idle.
  2. GREEN: Implement `Mod+.` only if it is accepted as a deliberate non-Escape stop/cancel path.
  3. RED: Add tests proving `Mod+.` does not interfere with text input or Vim commands.
  4. GREEN: Route the binding through the same cancel/stop semantics as the existing Escape path where appropriate.
  5. REFACTOR: Document if `Mod+.` is rejected, deferred, or shipped.

### Phase 4: Browser Convention Verification

**Goal:** Verify the binding set across target browsers and operating systems.

**Gate from previous:** candidate bindings are implemented behind tests.

#### M9: Browser and OS Matrix

- **Dependencies:** M1-M8
- **Effort:** M
- **Tasks:**
  1. RED: Add a manual verification matrix sourced from `apps/web/HOTKEYS.md` for Chrome, Arc, Firefox, Zen, and Safari where relevant.
  2. GREEN: Verify `Mod+K`, `Mod+Enter`, `Mod+/`, panel toggles, Escape routing, and any stop/cancel binding.
  3. RED: Add Playwright or jsdom-level tests for preventDefault and focus routing where browser automation can represent it.
  4. GREEN: Mark each binding as accepted, contextual, rude-but-accepted, rejected, or reserved in the ledger.
  5. REFACTOR: Remove or reassign any binding that behaves unreliably.

#### M10: Full Regression Coverage

- **Dependencies:** M1-M9
- **Effort:** M
- **Tasks:**
  1. RED: Add regression tests for every bug class: behind-surface interaction, text-field theft, Vim Escape ordering, palette leakage, modal leakage, and stale handlers.
  2. GREEN: Make all router/component tests pass.
  3. RED: Add test coverage that every registered shortcut appears in shortcuts help and `apps/web/HOTKEYS.md`.
  4. GREEN: Finalize docs/help/ledger consistency.
  5. REFACTOR: Keep shortcut registration centralized and remove duplicate component-local shortcut tables.

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---:|---:|---|---|
| Shortcut fires behind a frontmost modal/panel | high | medium | Central router with surface stack and regression tests for every layer. | Web |
| Vim insert Escape cancels a run | high | medium | Hard dependency on Vim plan and explicit Escape precedence tests. | Web |
| `Mod+K` is unreliable on Windows/Linux | medium | medium | Browser matrix; accept as deliberate takeover only with preventDefault and fallback path. | Web |
| `Alt`/`Option` shortcuts break text input or browser menus | medium | high | Exclude `Alt`/`Option` from first-class shortcuts. | Web |
| Config toggle corrupts user config | high | low | Host-owned typed config mutation, tests for malformed config and TREVOR_HOME override. | Host/Web |

## 4. Escape Hatches

1. **If `Mod+K` is unreliable in a target browser:** keep command palette available through UI and `Mod+/` help, then choose a verified alternate binding.
2. **If panel toggle candidates conflict with Arc/Zen/browser behavior:** defer panel toggles and ship palette + Vim toggle first.
3. **If config persistence is not ready:** ship read-only palette shell first and keep the Vim toggle disabled until `24-vim-motions-ui` config plumbing lands.

## 5. Progress Report Accounting

The progress report is `.plans/25-keyboard-shortcuts/progress-report.md`. It tracks only keyboard shortcut routing, the command palette shell, the persisted Vim toggle command, and the first binding set. It does not implement broader settings, global navigation, or non-keyboard command surfaces.

Before implementation resumes, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "25-keyboard-shortcuts"
```

## 6. Validation Commands

```bash
pnpm --filter @trevor/web test
pnpm --filter @trevor/web typecheck
pnpm test
pnpm typecheck
```

## 7. Decisions

Canonical decisions are in `.plans/25-keyboard-shortcuts/plan.db`. Query them with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "25-keyboard-shortcuts"
```
