# Compact Transcript Catalog — Progress Report

**Plan:** `58-compact-transcript-catalog`
**Stage:** ready (authored; not yet implemented)
**Current focus:** M1 — Compact type key + spacing model (pure) (0/5)

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 24 |
| Checked (done) | 0 |
| Current-cutoff blockers (unchecked) | 24 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

All three milestones (19 RED/GREEN/REFACTOR tasks) plus the 5 gate criteria are
current-cutoff; nothing is deferred. The escape-hatch
fallbacks (defer M3 wiring, seed fixtures from existing sets, snapshot as
informational) are contingencies in `implementation.md`, not scheduled work —
they do not appear as tasks here.

---

## M1 — Compact type key + spacing model (pure)  (0/5)

- [ ] RED: `compactTypeKey(row)` — non-tool row keys by `Message.kind`; read-only `tool` row and read-only `tool_batch` both key `readonly`; non-read-only tool keys `tool:<name>` (two same-named calls share it); `mcp`/`mcp__*` tool keys `mcp:<name>` and never `readonly` even when the name is in `READ_ONLY_TOOL_NAMES`.
- [ ] GREEN: Implement `compactTypeKey` in new `compact-spacing.ts`, MCP-first, read-only bucket from `@trevor/session` `READ_ONLY_TOOL_NAMES`.
- [ ] RED: Spacing derivation over an ordered row list — same-key adjacency → no leading gap; different-key adjacency → exactly one; first row → no leading gap.
- [ ] GREEN: Implement the per-row leading-gap derivation in `compact-spacing.ts`.
- [ ] REFACTOR: Module-comment `compact-spacing.ts`; confirm the single `READ_ONLY_TOOL_NAMES` import is the only read-only source.

## M2 — All-types compact catalog fixtures + story  (0/7)

- [ ] RED: Coverage test fails if any `Message.kind` lacks a catalog fixture, or if any tool type-variant is missing (read-only run, two distinct non-read-only tools, two same-named non-read-only tools, MCP tool).
- [ ] GREEN: Build `compact-catalog-fixtures.ts` — one ≤2-line compact exemplar per `Message.kind` + the tool variants, reusing `compact-fixtures.ts` / `inline-agent-fixtures.ts` where possible.
- [ ] RED: Story-render expectation — every catalog item renders through the real compact path (`CompactRow`) at ≤2 lines, resting state.
- [ ] GREEN: Author `compact-catalog.stories.tsx` (title `Chat/CompactCatalog`) rendering all types side by side via the real compact renderer.
- [ ] RED: State-coverage test — each type with an active variant appears in both resting and active/running state (tools running, assistant streaming, `compacting`/`reconnecting`/`delegation` running).
- [ ] GREEN: Add active/loading variants to fixtures + story; surface drill-in affordances (chevron-expand everywhere; `WithInspect` on tool/shell where eligible).
- [ ] REFACTOR: De-duplicate fixture construction; add a catalog story snapshot under `apps/web/__snapshots__`.

## M3 — Wire type-aware spacing into `VirtualTranscript` compact mode  (0/7)

- [ ] RED: `VirtualTranscript` compact behavioral test — zero gap between same-type-key rows, exactly one blank-line spacer between different-type-key rows (replacing uniform tight spacing).
- [ ] GREEN: Consume `compactTypeKey` + derivation in `virtual-transcript.tsx`, replacing the uniform collapsed-row spacing (`~:357-363`); apply gaps in both layout and `estimateRowSize` (`~:52`).
- [ ] RED: Read-only grouping test — a `tool_batch` row and an adjacent lone read-only `tool` row sit flush; a following non-read-only tool opens exactly one gap.
- [ ] GREEN: Ensure `tool_batch` rows resolve to the `readonly` key in the spacing path.
- [ ] RED: Expansion test — toggling a compact row open renders the full detail inline without changing sibling spacing.
- [ ] GREEN: Confirm expansion is internal to the row and does not perturb sibling gaps.
- [ ] REFACTOR: Remove the old tight-spacing branch; regenerate the catalog snapshot for the wired spacing; module-comment the spacing seam in `virtual-transcript.tsx`.

---

## Gate 1→done

- [ ] `compactTypeKey` + spacing derivation unit-tested: MCP-first, one shared read-only bucket, other tools by name, first row no leading gap.
- [ ] `Chat/CompactCatalog` renders every `Message.kind` + tool type-variant in compact ≤2-line form, resting + active, with chevron-expand and `Inspect` (tool/shell) affordances.
- [ ] `VirtualTranscript` compact: zero gap within a type, one blank line between types; read-only tools/batches flush; MCP always separate.
- [ ] Agent-host untouched; no new `Message` kinds; compact primacy rule unchanged.
- [ ] `pnpm test:web`, `pnpm typecheck`, `pnpm lint`, catalog snapshot/`test-storybook` pass.
