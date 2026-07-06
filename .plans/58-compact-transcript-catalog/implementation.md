# Compact Transcript Catalog — Implementation Plan

Give the compact transcript a single Storybook story that renders **every**
transcript item type in its compact (1-2 line) form side by side — resting and
active/loading states, plus the existing drill-into-detail affordances — and,
underneath it, add the one piece of real behavior that story depends on: a
**type-aware spacing rule** so a compact transcript groups by type instead of
being a uniform run of tight one-liners. Consecutive items of the same type sit
flush; a type change inserts exactly one blank-line spacer. Tools are the
exception: all read-only tools count as one type, every other tool is typed by
name, and MCP tools are always their own type regardless of read-only status.

This is a **Storybook-first**, `apps/web`-only plan. The agent-host is not
touched; the `compact` toggle already exists in the web app (`app.tsx`) and in
`VirtualTranscript` from completed plan 05.

## 0. Hard Dependencies

All hard dependencies are **already complete and live in the working tree**;
this plan extends them. There are no downstream plans to accommodate (58 is the
highest plan number) and no dependency on live plans 46/48/49/50/57. <!-- D-007 -->

- **Complete — plan 05 (compact transcript layout).** The compact projection
  and one-line row already exist: `apps/web/src/components/chat/compact-display.ts`
  (`compactDisplayFor`, `staysFullInCompact`, `isCompactEligible` — the primacy
  rule that keeps user prompts and assistant segments with visible text FULL and
  collapses everything else), `compact-row.tsx` (`CompactRow`, the `h-6` one-line
  row + chevron expand), and the `compact` / `expandedRows` / `onToggleRow` path
  through `virtual-transcript.tsx` and `transcript-row-view.tsx`. Existing
  stories: `virtual-transcript.stories.tsx` (`Compact`, `LiveRunningCompact`) and
  `compact-row.stories.tsx`; fixtures: `compact-fixtures.ts`.
- **Complete — plan 08 (tool detail takeover).** The drill-in affordances this
  plan demonstrates: the inline chevron-expand on every `CompactRow`, and the
  `WithInspect` "Inspect" takeover (`apps/web/src/tool-detail/inspect-affordance.tsx`)
  gated by `isDetailEligible` (`tool-detail/detail-model.ts` — eligible for
  `tool` and `shell` rows only). <!-- D-004 -->
- **Complete — read-only tool categorization.** `packages/session/src/tools.ts`
  owns `ToolDescriptor.readOnly` and the derived `READ_ONLY_TOOL_NAMES` set,
  already consumed by `readOnlyToolBatches` (`apps/web/src/transcript.ts`) to fold
  2+ consecutive read-only tools into one `tool_batch` row. The compact type key
  reuses this set — no new read-only list. <!-- D-006 -->

## Architecture

Two layers, both under `apps/web/src/components/chat/`, plus one new pure module.

- **New pure module — `compact-spacing.ts`.** Owns the type taxonomy for compact
  spacing: `compactTypeKey(row)` returns a stable string key per `TranscriptRow`,
  and a spacing derivation turns an ordered row list into per-row leading-gap
  flags. No React, fully unit-testable, imports `READ_ONLY_TOOL_NAMES` from
  `@trevor/session`.
- **Renderer wiring — `virtual-transcript.tsx`.** Replaces the current uniform
  "tight spacing for collapsed compact rows" branch (`~:357-363`) with the
  type-aware derivation, applied in both the rendered layout and `estimateRowSize`
  (`~:52`) so virtualization measurements stay correct.
- **Catalog surface — `compact-catalog.stories.tsx` + `compact-catalog-fixtures.ts`.**
  A new story (title `Chat/CompactCatalog`) that renders one compact exemplar of
  every `Message.kind` and every tool type-variant through the **real** compact
  renderer, resting and active, with the drill-in affordances visible.

### The type key

<!-- D-002 --> `compactTypeKey(row)` decides what "same type" means for spacing.
For a `message` row it derives from the `Message`; for a `tool_batch` row it is
always the read-only key. The tool sub-typing checks **MCP first**:

1. **MCP** — a tool whose name is the `mcp` gateway or matches the `mcp__`
   prefix → key `mcp:<name>`. Never joins the read-only group, even if the tool
   name happens to be read-only. Each distinct MCP tool name is its own type.
2. **Read-only** — a non-MCP tool whose name is in `READ_ONLY_TOOL_NAMES` (and a
   `tool_batch` row) → the single shared key `readonly`. All read-only tools sit
   flush together.
3. **Other tool** — any other non-read-only tool → key `tool:<name>`. Consecutive
   calls to the *same* tool name (edit, edit) share a key and sit flush; a
   different tool name opens a gap.

Every non-tool row keys by its `Message.kind` (`user`, `assistant`, `question`,
`shell`, `compacting`, …). Full-rendered rows (user prompts, assistant-with-text
under the primacy rule) participate in spacing with their `kind` as the key —
the rule is applied uniformly to all rows in compact mode.

### The spacing rule

<!-- D-001 --> In compact mode, the gap **before** row *i* is: none if row *i*
shares a type key with the previous row; exactly one blank-line spacer if the
keys differ. The first row never gets a leading gap. This replaces the uniform
tight spacing, so a compact transcript reads as type-grouped blocks:

```
user prompt            (full)
                        ← gap (kind change)
assistant response     (full)
                        ← gap (kind change)
read ·  glob ·  grep    (readonly — flush, no gaps between them)
                        ← gap (readonly → tool:edit)
edit
edit                    (tool:edit — flush)
                        ← gap (tool:edit → tool:bash)
bash
                        ← gap (tool:bash → mcp:github__create_issue)
mcp  github__create_issue
```

Expanding a compact row (chevron) renders its full detail inline and does **not**
change the type key or the spacing of sibling rows — expansion is internal to the
row.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Read-only categorization already lives in `@trevor/session` | Type key reuses `READ_ONLY_TOOL_NAMES`; no parallel list (D-006) |
| 2+ read-only tools already fold into one `tool_batch` row | `tool_batch` resolves to the `readonly` key; a lone read-only tool keys the same, so batch + single sit flush (D-002) |
| MCP is funneled through a single `mcp` gateway tool, and `mcp__*` names pass through as unknown | MCP detected by name (gateway or prefix), checked before read-only (D-002) |
| `estimateRowSize` drives the virtualizer | Spacing must be reflected in both layout and size estimate or scroll math drifts (D-003 wiring) |
| Primacy rule keeps user/assistant-with-text full | Unchanged; full rows still key by `kind` and participate in spacing (D-003) |
| Storybook-first, host untouched | No agent-host change; the story is the acceptance surface (D-003) |

### Boundaries

- **`compact-spacing.ts` ↔ everything else:** pure functions over `TranscriptRow`
  + `Message` + `READ_ONLY_TOOL_NAMES`. No React, no host coupling. The renderer
  consumes it; the story validates the resulting layout.
- **This plan ↔ compact projection:** reuses `compact-display.ts` /
  `CompactRow` / `isCompactEligible` unchanged. It adds *spacing between* rows; it
  does not change how any single row projects to its compact form.
- **This plan ↔ drill-in:** consumes the existing chevron-expand and `WithInspect`
  / `isDetailEligible`; does **not** widen detail eligibility. <!-- D-004 -->

The new `compact-spacing.ts` gets a module-level comment describing what it owns
(the compact type taxonomy + spacing derivation) and why it exists, matching the
docstring style of the neighboring `compact-display.ts`.

### Observability

This is a pure-projection + Storybook change with no runtime/transport/provider
surface, so no spans or structured failure events are added. Debuggability comes
from `compactTypeKey` being a pure, independently-testable function whose output
(the key string) is directly assertable, and from the catalog story being the
visual inspection surface for the full taxonomy in one screen.

---

## Phases

### Phase 1: Compact transcript catalog + type-aware spacing (single phase)

**Goal:** A `Chat/CompactCatalog` story renders every transcript item type in
compact 1-2 line form with resting + active states and drill-in affordances, and
`VirtualTranscript` in compact mode groups rows by type — flush within a type,
one blank line between types, read-only tools as one group, other tools by name,
MCP always separate.

**Gate from previous:** none (extends completed plan 05 / 08 and the
`@trevor/session` read-only categorization).

#### M1: Compact type key + spacing model (pure)

- **Dependencies:** none
- **Effort:** S (1-3d)
- **Tasks:**
  1. RED: Unit test for `compactTypeKey(row)` — a non-tool row keys by
     `Message.kind`; a read-only non-MCP `tool` row and a read-only `tool_batch`
     row both key `readonly`; a non-read-only tool keys `tool:<name>` and two
     same-named calls share it; an `mcp` gateway / `mcp__*` tool keys `mcp:<name>`
     and never `readonly` even when its name is in `READ_ONLY_TOOL_NAMES`.
  2. GREEN: Implement `compactTypeKey` in new
     `apps/web/src/components/chat/compact-spacing.ts`, MCP-first, deriving the
     read-only bucket from `@trevor/session` `READ_ONLY_TOOL_NAMES`.
  3. RED: Unit test for the spacing derivation over an ordered row list — adjacent
     same-key rows yield no leading gap, adjacent different-key rows yield exactly
     one, and the first row never gets a leading gap.
  4. GREEN: Implement the derivation (per-row leading-gap flags from the ordered
     rows) in `compact-spacing.ts`.
  5. REFACTOR: Module-comment `compact-spacing.ts` (owns the compact type taxonomy
     + spacing derivation); confirm the single `READ_ONLY_TOOL_NAMES` import is the
     only read-only source.

#### M2: All-types compact catalog fixtures + story

- **Dependencies:** M1
- **Effort:** M (3-7d)
- **Tasks:**
  1. RED: Coverage test that fails if any `Message.kind` lacks a catalog fixture,
     and if any tool type-variant is missing (a read-only run, two distinct
     non-read-only tools, two same-named non-read-only tools, an MCP tool).
  2. GREEN: Build `apps/web/src/components/chat/compact-catalog-fixtures.ts` — one
     compact exemplar (≤2 lines) per `Message.kind` plus the tool variants,
     reusing `compact-fixtures.ts` / `inline-agent-fixtures.ts` where possible.
  3. RED: Story-render expectation (Storybook test-runner / render test) that every
     catalog item renders through the real compact path (`CompactRow`) at ≤2 lines
     in its resting state.
  4. GREEN: Author `apps/web/src/components/chat/compact-catalog.stories.tsx`
     (title `Chat/CompactCatalog`) rendering all types side by side via the real
     compact renderer.
  5. RED: State-coverage test — each type with an active variant appears in both a
     resting and an active/running state (tools running, assistant streaming,
     `compacting` / `reconnecting` / `delegation` running).
  6. GREEN: Add the active/loading variants to fixtures + story, and surface the
     drill-in affordances (chevron-expand on every row; `WithInspect` on the
     tool/shell rows where already eligible). <!-- D-004 -->
  7. REFACTOR: De-duplicate fixture construction; add a story snapshot under
     `apps/web/__snapshots__` for the catalog.

#### M3: Wire type-aware spacing into `VirtualTranscript` compact mode

- **Dependencies:** M1 (model), M2 (catalog story is the acceptance surface)
- **Effort:** M (3-7d)
- **Tasks:**
  1. RED: `VirtualTranscript` compact behavioral test — an ordered row set renders
     with zero gap between same-type-key rows and exactly one blank-line spacer
     between different-type-key rows (replacing the uniform tight spacing).
  2. GREEN: Consume `compactTypeKey` + the spacing derivation in
     `virtual-transcript.tsx`, replacing the uniform collapsed-row spacing branch
     (`~:357-363`), applying gaps in both the layout and `estimateRowSize`
     (`~:52`) so virtualization measurements match. <!-- D-001 -->
  3. RED: Read-only grouping test — a `tool_batch` row and an adjacent lone
     read-only `tool` row sit flush (both `readonly`); a following non-read-only
     tool opens exactly one gap.
  4. GREEN: Ensure `tool_batch` rows resolve to the `readonly` key in the spacing
     path.
  5. RED: Expansion test — toggling a compact row open renders the full detail
     inline without changing the type-key spacing of its sibling rows.
  6. GREEN: Confirm expansion is internal to the row and does not perturb sibling
     gaps.
  7. REFACTOR: Remove the old tight-spacing branch in favor of the derivation;
     regenerate the catalog snapshot to reflect the wired spacing; module-comment
     the spacing seam in `virtual-transcript.tsx`.

### Gate 1→done

- [ ] `compactTypeKey` + spacing derivation are unit-tested: MCP-first, one
      shared read-only bucket, other tools by name, first row no leading gap.
- [ ] `Chat/CompactCatalog` renders every `Message.kind` + every tool type-variant
      in compact ≤2-line form, in resting and active states, with the chevron-
      expand and `Inspect` (tool/shell) affordances visible.
- [ ] `VirtualTranscript` compact mode: zero gap within a type, exactly one blank
      line between types; read-only tools/batches stay flush; MCP always separate.
- [ ] Agent-host untouched; no new `Message` kinds; the compact primacy rule
      (user + assistant-with-text stay full) is unchanged.
- [ ] `pnpm test:web`, `pnpm typecheck`, `pnpm lint`, and the catalog story
      snapshot/`test-storybook` pass.

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| A second read-only tool list forks from `@trevor/session` | high | low | D-006: type key imports `READ_ONLY_TOOL_NAMES`; no parallel list | impl |
| Spacing wired into layout but not `estimateRowSize` → virtualizer scroll drift | medium | medium | M3 applies gaps to both layout and size estimate; behavioral test asserts | impl |
| `tool_batch` row misclassified (not `readonly`) → spurious gap next to a lone read-only tool | medium | medium | D-002: `tool_batch` resolves to `readonly`; explicit grouping test (M3.3) | impl |
| MCP tool that is read-only wrongly folded into the read-only group | medium | low | D-002: MCP checked before read-only; explicit test (M1.1) | impl |
| Catalog drifts as new `Message.kind`s are added | medium | medium | M2.1 coverage test fails when a kind lacks a fixture | impl |
| Story shows target spacing but renderer never wired | medium | low | Build scope is extend-renderer + story (D-003); M3 wires the real path | impl |

---

## Escape Hatches

1. **If wiring the spacing into `estimateRowSize` destabilizes the virtualizer:**
   land M1 (pure model) + M2 (catalog story rendering the model's spacing in a
   non-virtualized container) and defer the `VirtualTranscript` wiring (M3) to a
   follow-up, keeping the story as the validated target.
2. **If per-`Message.kind` fixtures balloon:** seed the catalog from the existing
   `compact-fixtures.ts` / `inline-agent-fixtures.ts` and add only the missing
   kinds + tool variants, rather than authoring a fresh exemplar for every kind.
3. **If the story snapshot proves flaky under `test-storybook`:** keep the M2/M3
   behavioral vitest assertions as the gate and treat the snapshot as
   informational until the Storybook test-runner lane (plan 09.2) is in place.

---

## Progress Report Accounting

The progress report is the resume state and uses normalized accounting:
current-cutoff blockers only in the active flow, any escape-hatch/deferred work
under a follow-up bucket, the current-focus marker matching the first unchecked
current-cutoff box. Before resuming implementation or declaring convergence:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "58-compact-transcript-catalog"
```

---

## Validation Commands

```bash
# From repo root
pnpm test:web          # vitest --project web (compact-spacing + catalog + virtual-transcript)
pnpm typecheck         # pnpm -r typecheck
pnpm lint              # biome check . && check:filenames
pnpm test-storybook    # Storybook test-runner (catalog story render + snapshot)

# Eyeball the catalog
pnpm --filter @trevor/web storybook   # open Chat/CompactCatalog
```

---

## Decisions

Canonical decisions are in `.plans/58-compact-transcript-catalog/plan.db`
(D-001 … D-007). Query with:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "58-compact-transcript-catalog"
```
