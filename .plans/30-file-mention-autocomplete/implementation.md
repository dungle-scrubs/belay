# File Mention Autocomplete - Implementation Plan

## 0. Hard Dependencies

- [x] Existing production composer boundary: `apps/web/src/hooks/use-composer.ts` and `apps/web/src/components/chat/prompt-input.tsx`.
- [x] Existing slash-command autocomplete pattern: `useSlashMenu` plus `CommandMenu`, with the caller owning filtering, active index, and key handling.
- [x] Existing workspace root confinement and file-search primitives in the host (`WORKSPACE_ROOT`, `glob`, `grep`, shared skip policy).
- [x] Existing prompt token/ref behavior for inline image tokens, so file mentions can follow the same "visible text plus structured metadata" direction without becoming attachment chips.

## 1. Architecture

Typing `@` in the composer should open a fuzzy file picker backed by the active host workspace. It is a composer affordance, not a model tool and not a slash command. The browser renders and navigates the menu; the host owns workspace file enumeration because the browser has no filesystem authority.

The first implementation target is path selection, not automatic file-content injection. Selecting a result inserts a visible workspace-relative mention such as `@apps/web/src/App.tsx` into the draft and records structured mention metadata for that range. The submitted prompt still reads naturally as ordinary text; later work can decide whether selected file mentions become prompt attachments, explicit context blocks, or tool-detail links.

### Boundaries

| Boundary | Owns | Does not own |
|---|---|---|
| `CommandMenu` or extracted generic menu | Row chrome, active-row styling, mouse-down pick behavior | Slash-specific matching or file search |
| `useSlashMenu` | Leading slash command detection and completion | File mentions |
| New file mention hook | Active `@` token detection, menu state, key handling, insertion | Filesystem reads, durable session protocol |
| Host file-search service | Workspace-confined file list/search, ignore policy, result caps | Prompt mutation or model turns |
| Session/protocol events | Optional request/response/read-model transport for file search | File contents unless a later plan adds content injection |

### Key Decisions

- Reuse the slash-menu visual component by generalizing its item shape or adding a sibling wrapper around the same presentational primitive.
- Trigger only when the caret is inside an active mention token at a safe boundary: start of draft or preceded by whitespace/open punctuation. Email addresses and ordinary `@` in the middle of a word should not open the picker.
- Search is host-owned, workspace-confined, debounced, capped, and ignore-aware. It returns relative paths and lightweight metadata only.
- Selection inserts/replaces the active token and parks the caret after the inserted path.
- Escape closes only the mention menu first. It must not cancel a turn, clear the draft, or close transcript takeovers while the mention menu owns focus.

## 2. Phases

### Phase 1: Storybook Composer Affordance

**Goal:** The real composer can show and navigate a file mention menu in Storybook before any live host search is wired.

#### M1: Reusable Autocomplete Chrome

- **Dependencies:** hard dependencies
- **Effort:** S
- **Tasks:**
  1. RED: Add Storybook fixtures for slash-menu, file-menu, long paths, empty results, and narrow composer widths.
  2. GREEN: Extract the shared menu row/list primitive from `CommandMenu` or widen `CommandMenu` with a typed item adapter.
  3. RED: Add component tests for active row, mouse-down pick preserving focus, long path truncation, and summary metadata.
  4. GREEN: Render file rows with basename emphasis, muted directory path, and stable row height.
  5. REFACTOR: Keep slash command behavior byte-for-byte equivalent at the public hook/component boundary.

#### M2: Composer Token Detection

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Unit-test active mention parsing for start/middle/end of draft, cursor movement, whitespace boundaries, punctuation boundaries, email addresses, multiline prompts, and shell/slash lanes.
  2. GREEN: Add a pure parser that returns active mention range, raw query, and replacement range.
  3. RED: Hook-test keyboard ownership: ArrowUp/Down, Tab, Enter, Escape, Backspace, and normal text entry.
  4. GREEN: Add `useFileMentionMenu` parallel to `useSlashMenu`; it owns only file mention state and key handling.
  5. RED: Test coexistence ordering with slash menu, prompt history, image-token deletion, Enter submit, and future Vim mode.
  6. GREEN: Wire the hook into App's composer key path before global Escape/cancel handling, after composer-owned atomic token deletion.
  7. REFACTOR: Keep mention parsing pure and independent of React.

### Phase 2: Host File Search Read Model

**Goal:** The UI can ask the active host for lightweight file matches without exposing filesystem access to the browser.

#### M3: Workspace-Confined Search

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Host unit tests cover workspace confinement, ignored directories, hidden files policy, cap/truncation, empty query, and path escaping.
  2. GREEN: Add a host-side file-search service using existing workspace root and skip-policy primitives.
  3. RED: Add ranking tests for basename match, path segment match, exact prefix, fuzzy subsequence, and stable tie-break order.
  4. GREEN: Implement a small fuzzy scorer that favors basename and recently exact prefixes without reading file contents.
  5. RED: Add protocol/decoder tests for request, response, stale response, and host unavailable cases.
  6. GREEN: Add a browser-host request path or host-announced read model for file-search results.
  7. RED: Add debouncing/cancellation tests so stale results cannot overwrite newer queries.
  8. REFACTOR: Keep search result payloads small: relative path, basename, directory, kind if cheap, and truncation flag.

#### M4: Live Composer Integration

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Web tests cover loading, stale host, no results, capped results, selecting by keyboard, selecting by mouse, and preserving draft text around the mention.
  2. GREEN: Wire live search results into `useFileMentionMenu` with debounce and request identity.
  3. RED: Submission tests verify visible prompt text and structured mention metadata stay aligned after edits.
  4. GREEN: Add mention metadata to composer state or derive it from selected mentions at submit time.
  5. RED: Regression tests ensure unselected `@foo` remains plain text and does not invent metadata.
  6. GREEN: Submit selected mentions alongside prompt metadata only if the protocol slice is added; otherwise keep visible text as the first shipped behavior.
  7. REFACTOR: Remove any duplicated menu filtering that should live in shared autocomplete helpers.

### Phase 3: Validation and Polish

**Goal:** The feature feels native and does not regress hotkeys, draft persistence, or prompt submission.

#### M5: Test and E2E Coverage

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add Storybook interaction tests for keyboard navigation and selection.
  2. GREEN: Complete visual states for desktop, narrow composer, long paths, dark theme, and reduced motion.
  3. RED: Add integration tests with a temp workspace and fake host search.
  4. GREEN: Cover live app EZE path: type `@`, fuzzy-find a file, insert it, submit a prompt, and verify transcript text.
  5. RED: Add accessibility tests for menu semantics, active descendant, and screen-reader labels.
  6. REFACTOR: Document the non-goal: file mention autocomplete does not automatically read or inject file contents in this slice.

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation |
|---|---:|---:|---|
| Large repos make every-keystroke search expensive | high | medium | Debounce, cap results, cache only the file list/index for the current workspace, never file contents |
| Menu key handling conflicts with Escape/cancel, history recall, or Vim mode | high | medium | Centralize menu ownership ordering and test each key path |
| Users expect `@file` to inject content | medium | high | Make the first slice visibly path-selection only; keep structured metadata so a later injection plan can build on it |
| Browser sees paths outside the workspace | high | low | Host confinement tests and relative-path-only payloads |

## 4. Progress Report Accounting

Use `.plans/30-file-mention-autocomplete/progress-report.md` as the implementation resume state. Before resuming implementation, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "30-file-mention-autocomplete"
```

## 5. Validation Commands

```bash
pnpm --filter @trevor/web test -- --project web apps/web/src/hooks/use-file-mention-menu.test.tsx
pnpm --filter @trevor/web test -- --project web apps/web/src/components/chat/prompt-input.test.tsx
pnpm --filter @trevor/agent-host test -- --project unit apps/agent-host/src/file-search.test.ts
pnpm --filter @trevor/web storybook
pnpm test -- --project e2e
```

## 6. Decisions

Canonical decisions are in `.plans/30-file-mention-autocomplete/plan.db`. Query with:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "30-file-mention-autocomplete"
```
