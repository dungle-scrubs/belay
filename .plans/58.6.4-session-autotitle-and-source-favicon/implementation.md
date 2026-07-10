# Session Auto-Title + Source-Card Favicon - Implementation Plan

## 0. Hard Dependencies

- [x] Plan 58.6 audit rows A13 (auto-titling) and D7 (lazy favicon). <!-- D-001 -->
- [x] The `session.title` event, the inventory rename-wins projection, the off-turn
  `distillToBudget` LLM primitive, and the `assistant.completed` host hook all already
  exist (verified). This plan wires them; it builds no new infrastructure. <!-- D-003 -->

## 1. Objective

Two small capabilities the audit found assistant-ui offers and Trevor lacks:

1. **A13 - LLM session auto-titling.** Give an un-renamed session a generated title
   instead of showing the truncated first prompt / session id.
2. **D7 - lazy source-card favicon.** Show the site icon on web source cards, with a
   fallback, so cited sources are scannable.

## 2. Relevant Surfaces (verified)

### A13

- `packages/session/src/inventory.ts:132-163` - `titleFrom()` precedence: manual rename
  (`session.title`) wins → else first user message truncated to 60 → else session id.
  Rendered in the sidebar at `apps/web/src/sidebar/project-sidebar.tsx:171`.
- `packages/session/src/protocol/events.ts:891-894` - `sessionEvents.sessionTitle({title})`
  → `{type:"session.title", payload:{title}}`. The rename write path
  (`apps/web/src/session/use-session.ts:152`) emits it from the web client today.
- `apps/agent-host/src/agent/tool-less-summary.ts:26` - `distillToBudget(provider, prompt,
  opts)`: one tool-less model step at cheapest reasoning, token-budgeted. Used by the
  compactor (`compactor.ts:147`). Provider via
  `compaction-controller.ts:86` `providerOrDefault()`.
- `apps/agent-host/src/main.ts:987-1011` - the `assistant.completed` admission branch;
  has `conversationLog.history()`, `emit`, and the compaction controller in scope - the
  trigger seam.

### D7

- Source cards: `apps/web/src/components/chat/web-fetch.tsx` (URL at `:136`),
  `web-search.tsx` (per-result `:80-100`, URL `:97`), `docs.tsx` (`SourceLink` `:134-146`).
  `source-recall.tsx` is file-path only - **excluded**.
- `prettyUrl` helper is copied in all three (`web-fetch.tsx:71`, `web-search.tsx:37`,
  `docs.tsx:123`) - the natural place to also derive the favicon origin, and a dedupe target.
- `apps/web/src/artifact-thumb.tsx:11-45` - the `broken`/`onError` fallback pattern to reuse.
- No CSP in `apps/web` (verified) - nothing technically blocks a remote favicon; the
  constraint is the local-first privacy one (D-004).

## 3. Milestones

### M1: Session auto-titling (A13)

**Testing:** test-first for the trigger/gate/emit logic (behavior-bearing); test-after
for prompt/title quality (LLM output).

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. Seams under test: the "should this session get an auto-title now?" gate + the
     title-emit, given a sequence of host events.
  2. RED: Test the gate - fires exactly once, on the first `assistant.completed`, only
     when no `session.title` event exists; does NOT fire when the user already renamed,
     and a later manual rename still wins (latest-wins).
  3. GREEN: Add a `buildTitlePrompt(history)` and a title job that calls `distillToBudget`
     via `providerOrDefault()` at cheapest reasoning, bounded to a short token budget;
     emit the result as a `session.title` event via the host `emit` with a host producer id.
  4. GREEN: Wire the job into the `assistant.completed` branch (`main.ts:987`) behind the
     gate; guard against re-entrancy and against titling an empty/errored turn.
  5. RED: Test failure handling - a failed/empty title job leaves the derived title
     untouched (no empty `session.title` emitted).
  6. REFACTOR: If the title job reads like the compactor's summarize path, share structure.
  7. Verify: host unit tests; a manual host run showing a new session gets a generated
     title after its first turn and a manual rename still overrides it.

### M2: Lazy source-card favicon (D7)

**Testing:** test-after (frontend rendering + fallback behavior).

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. Build a small `SourceFavicon` component: `<img>` from same-origin
     `https://<host>/favicon.ico` derived from the row hostname, `loading="lazy"`,
     `referrerPolicy="no-referrer"`, and an `onError` fallback to a neutral globe
     placeholder (mirror `artifact-thumb.tsx`'s `broken` state) - never a broken image.
  2. Dedupe the `prettyUrl` helper into the shared source-link/favicon module and render
     the favicon beside the hostname/title in `web-fetch.tsx`, `web-search.tsx`, `docs.tsx`.
  3. RED/behavioral: test that a failing favicon renders the placeholder, not a broken
     image; that `source-recall` rows (no URL) render unchanged.
  4. Verify: a story showing web-search / web-fetch / docs cards with favicons + one
     forced-broken fallback.

## 4. Non-Goals

- No re-titling on topic shift; A13 titles once on the first turn only (a later
  re-title could be a follow-up).
- No third-party favicon provider (`s2/favicons` etc.) - it would leak every browsed
  domain; same-origin `/favicon.ico` only. <!-- D-004 -->
- No favicon on `source-recall` (local file paths, no URL).
- No change to the manual rename UX (auto-title reuses the same event and yields to it).

## 5. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Auto-title overwrites a user's manual rename | high | low | Gate: fire only when no `session.title` exists; latest-wins means a later rename overrides anyway (M1 RED) | impl |
| Title job fires repeatedly / on every turn | medium | medium | Once-only gate keyed on first `assistant.completed` + no prior title (M1 RED) | impl |
| Empty/garbled LLM title replaces a fine derived title | medium | medium | M1 task 5: failed/empty job emits nothing; keep the derived fallback | impl |
| Favicon leaks browsed domains (local-first) | medium | medium | Same-origin `/favicon.ico` only + `no-referrer`; provider-based favicons rejected; opt-in if owner prefers (D-004) | impl |
| Remote favicon load jank / broken images | low | medium | `loading="lazy"` + `onError` placeholder, mirrors `artifact-thumb` | impl |

## 6. Validation Commands

```sh
pnpm --filter web test
pnpm --filter agent-host test
pnpm --filter web typecheck
npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "58.6.4-session-autotitle-and-source-favicon"
npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-convergence --plan "58.6.4-session-autotitle-and-source-favicon" --streak 3
```

## 7. Decisions

Canonical decisions are in `plan.db`.

- D-001: scope = A13 auto-titling + D7 lazy favicon.
- D-002: numbered 58.6.4.
- D-003: A13 reuses the existing `session.title` event + `distillToBudget` +
  `assistant.completed` hook; fires once, yields to manual rename.
- D-004: D7 favicon is same-origin `/favicon.ico` + `no-referrer` + lazy + fallback;
  no third-party favicon provider; opt-in if the owner prefers zero transcript-originated
  remote requests.
