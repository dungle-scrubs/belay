# Model Favorites and Default — Progress Report

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks | 30 |
| Completed | 30 |
| Deferred / future-phase | 0 |
| Superseded | 0 |

**Current focus:** Done - all milestones landed.

**Stage:** IMPLEMENTED (M1-M7 built + tested; lint, typecheck, and full vitest green on the branch).

---

## Phase 1: Host-owned model-prefs store

**Goal:** `{ default, pinned }` persists durably at `~/.trevorV2/model-prefs.json`
behind a host store mirroring the vim/style stores, declared in the storage
inventory. Nothing announced or rendered yet.

### M1: model-prefs store + storage inventory

- [x] RED: Store test — missing file → `{ default: null, pinned: [] }`; malformed file → same (reported, not thrown); round-trip a `default` + `pinned` list; `setDefault` replaces; pin/unpin idempotent; `saveModelPrefs` clears the read-once cache. <!-- D-001 -->
- [x] GREEN: Add `apps/agent-host/src/prefs/model-prefs-store.ts` — `loadModelPrefs`/`saveModelPrefs`/cached `modelPrefs()` over `loadJsonConfig`/`writeJsonConfig`, reusing `decodeModelPreferences` + the pure `setDefaultModel`/`pinModel`/`unpinModel` from `@trevor/session`.
- [x] RED: Inventory + path test — `USER_MODEL_PREFS_JSON` resolves under `TREVOR_HOME`; the new `model-prefs` `STORAGE_INVENTORY` entry maps to `config` with a unique name; the `~/.trevorV2` drift guard still passes.
- [x] GREEN: Add `USER_MODEL_PREFS_JSON` to `apps/agent-host/src/boot/paths.ts` and a `model-prefs` `config` entry to `STORAGE_INVENTORY` in `packages/session/src/node-paths.ts`.
- [x] REFACTOR: Confirm the store reuses the pure transitions (no re-implemented default/pin logic) and carries a module-level owns/not-owns comment (mirror `vim-store.ts`).

---

## Phase 2: Announce + read the host preference

**Goal:** The host preference rides `host.online` as an optional `modelPrefs` field
and the browser reads it — additive, back-compatible with a host that omits it.

### M2: host.online modelPrefs + modelPrefsFrom

- [x] RED: Protocol builder test — `events.hostOnline({ ..., modelPrefs })` carries `modelPrefs` when provided and omits the key when `undefined` (back-compat, like `vimEnabled?`). <!-- D-001 -->
- [x] GREEN: Add optional `modelPrefs?: { default: ModelRef | null; pinned: readonly ModelRef[] }` to the `hostOnline` builder + payload spread in `packages/session/src/protocol.ts`.
- [x] RED: Presence test — `announceOnline()` includes `modelPrefs` read from the host store's cache.
- [x] GREEN: Thread `modelPrefs()` into the `events.hostOnline({...})` call in `apps/agent-host/src/transport/presence.ts` (same shape as `vimEnabled: vimEnabled()`).
- [x] RED: Derive test — `modelPrefsFrom(announcement)` returns `{ default, pinned }`, defaulting to `{ default: null, pinned: [] }` when absent.
- [x] GREEN: Add `modelPrefsFrom` to `apps/web/src/derive.ts` beside `vimEnabledFrom`.

---

## Phase 3: Mutate the preference (write side)

**Goal:** Setting the default and toggling a favorite persist host-side and
re-announce, so every open client updates without a restart.

### M3: Set-default / toggle-favorite command + re-announce

- [x] RED: Command test — set default persists + returns `ok`; add favorite persists; remove favorite persists the removal; an unusable ref is rejected without corrupting the store. <!-- D-001 -->
- [x] GREEN: Implement the host command(s) that decode the target `ModelRef` and apply `setDefaultModel`/`pinModel`/`unpinModel` via `saveModelPrefs`.
- [x] RED: Re-announce test — after a successful mutation the host re-announces `host.online` with the updated `modelPrefs` (the `if (name === "/vim" && ok) announceOnline()` pattern).
- [x] GREEN: Wire the re-announce in `apps/agent-host/src/main.ts` for the new command name(s).

---

## Phase 4: Web reads host prefs; mutations route to the host

**Goal:** `pinned`/`default` come from the announcement, not localStorage; the hook
exposes `setDefault` and routes `setDefault`/`togglePin` through the host command;
the projection exposes `defaultKey`.

### M4: Source default/favorites from the announcement + defaultKey

- [x] RED: Projection test — `buildModelSelection` derives `pinnedKeys` and a new `defaultKey: string | null` from the injected host `modelPrefs`; `defaultKey` null with no default. <!-- D-004 -->
- [x] GREEN: Thread host `modelPrefs` into `useModelSelection`/`buildModelSelection` (source `pinned` + `default` from the announcement; keep `recent`/`active`/`reasoningByModel` browser-side); add `defaultKey` to `ModelSelectionProjection` in `apps/web/src/model-selection.ts`.
- [x] RED: Hook test — `setDefault(ref)`/`togglePin(ref)` invoke the host-command sender with the ref (not a localStorage write); the UI reflects the change on the next announcement.
- [x] GREEN: Route `setDefault` (new) + `togglePin` through the host command in `use-model-selection.ts`; drop the localStorage-global `default`/`pinned` writes.
- [x] REFACTOR: Collapse `GlobalPrefs` to the still-local `recent`; read-through any pre-existing local default/pinned once (or note non-migration) so no stale blob shadows the host value.

---

## Phase 5: Ordering and the core reset fix

**Goal:** Every model list surfaces default → favorites → rest, and a fresh session
starts on the user's default instead of qwen.

### M5: Auto-sort default → favorites → rest

- [x] RED: Unit test for a pure sort helper — default first, then favorites, then the rest; stable within each group; a model that is both default and pinned appears once (default slot). <!-- D-004 -->
- [x] GREEN: Implement the sort helper in `model-selection.ts` and apply it in the model lists (`SourceDetail`/`ModelList` in `model-chooser.tsx`).
- [x] REFACTOR: Feed the same sorted projection to the split control and the chooser so ordering cannot drift between surfaces.

### M6: Initial-model pick consults the default (the reset fix)

- [x] RED: Failing test — a fresh session (no per-session `active`) with a host `default` of source X starts `sendModel` on X, not qwen; an explicit session `active` still wins over the default. <!-- D-005 -->
- [x] GREEN: In `apps/web/src/hooks/use-active-model.ts` insert `preferences.default` between the explicit session active and the legacy fallback (`preferences.active ?? preferences.default ?? activeModelRef`). <!-- D-005 -->

---

## Phase 6: Chooser UI — set + see the default

**Goal:** The chooser can set the default + favorites from a right-click menu, a
distinct glyph marks the default on a model row and its source, and the states read
cleanly. Storybook-first for the visuals.

### M7: Default glyph + RowContextMenu + source indicator

- [x] RED: Storybook story / fixture — `ModelRow` renders `BadgeCheck` when default, `Star` when pinned, `Check` when selected (a default+pinned+selected row shows all three without overlap); `SourceRow` shows the default glyph when its source holds the default. <!-- D-002 --> <!-- D-003 -->
- [x] GREEN: Add the `BadgeCheck` default glyph to `ModelRow` and the source-level default glyph to `SourceRow` (shown when `default.sourceId === source.sourceId`) in `apps/web/src/components/chooser/model-chooser.tsx`. <!-- D-003 -->
- [x] RED: Behavioral test — right-clicking a `ModelRow` opens the menu; "Set as default" calls `setDefault` with the row's ref; "Add to / Remove from favorites" calls `togglePin`; the menu attaches to the row wrapper and does not fight the nested select/pin buttons. <!-- D-002 -->
- [x] GREEN: Add a `RowContextMenu` to `ModelRow` reusing the `session-sidebar.tsx` template, wired to `setDefault`/`togglePin`.
- [x] REFACTOR: Consolidate the three-glyph affordances + the default/favorite handlers; confirm the reset bug is closed end-to-end and no dead localStorage-global default/pinned path remains.

---

## Decisions

- **D-001** Host-side `~/.trevorV2/model-prefs.json` for `default` + favorites (`pinned`), announced on `host.online`, mutated via a host command that re-announces.
- **D-002** Set-default UI via a right-click `RowContextMenu` on a `ModelRow` + a distinct `BadgeCheck` default glyph (Star = favorite, Check = selected).
- **D-003** Source-level default indicator on a `SourceRow` when `default.sourceId === source.sourceId`.
- **D-004** Auto-sort default → favorites → rest in every model list; `defaultKey` added to the projection.
- **D-005** The initial-model pick consults `preferences.default` (`active ?? default ?? legacy`) so a fresh session starts on the user's default, not qwen.

## Notes

- The pure `ModelPreferences` model already has `default`/`pinned` and
  `setDefaultModel`/`pinModel`/`unpinModel`, and the model rows already have a pin
  Star — so "favorites" is already `pinned`. This plan adds the host-side storage,
  the default UI/glyph, the ordering, and the initial-pick wiring, not new data.
- The reset was three compounding gaps (no set-default UI, per-browser storage,
  and an initial pick that never read `default`); M1-M3 make the preference durable
  and shared, M6 is the pick fix, and M7 is the set/see UI. All three are needed to
  close it end-to-end.
- `selection.active` collapses `preferences.active ?? legacyRef` (qwen for a fresh
  session), so the default must slot *between* an explicit session active and the
  legacy fallback; `selection.active ?? default` would short-circuit on qwen.
