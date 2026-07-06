# 08.1 multi-edit-detail-file - Implementation Plan

The `multi_edit` tool's detail-view **FILE** section renders `(none)` even though the
**CHANGES** summary reports a file (`multi_edit(2 edits · 1 file · +26 -1)`). The file
path *is* known - it lives per-edit under `input.edits[].path` - but three web surfaces
read a top-level `input.path` that `multi_edit` never sets. This plan resolves the path
from `edits[].path` once, in the shared salient-arg registry, and fixes the detail view to
show one chip per distinct file.

## 0. Hard Dependencies

None. This is a standalone fix to code owned by the completed, removed plan
`08-tool-detail`. No plan currently has a live feature branch or worktree, and no other
plan reads the FILE-chip derivation.

---

## Architecture

### Root cause

`multi_edit`'s host schema (`apps/agent-host/src/tools/multi-edit.ts:12-24`) is
`{ edits: [{ path, old, new }, …] }` - **there is no top-level `path`**; each edit carries
its own. Contrast `edit`/`write`, which do have a top-level `path`
(`apps/agent-host/src/tools/{edit,write}.ts`). Three web surfaces assume the `edit`/`write`
shape and read a top-level `path` for `multi_edit`:

| Surface | Reads | For `multi_edit` |
|---|---|---|
| Detail **FILE** chip | `multiEditDetailArgs` → `str(a.path)` (`tool-args.ts:127`), consumed at `detail-body.tsx:301` | `""` → renders `(none)` |
| Compact one-line summary | `str(parsed.path) ?? str(parsed.file_path)` (`compact-display.ts:252`) | both absent → edit count only |
| Live action-status label | `salientToolArg` default `args.path` (`tool-args.ts:58`) → `toolSummary` → `toolActionLabel` | `""` → `"editing"` with no file |

<!-- D-004 -->
A second, compounding defect: `MultiEditDetail` (`detail-body.tsx:306`) remaps **every**
edit onto the single (empty) top-level `path`
(`edits.map((e) => ({ path, old: e.old, new: e.new }))`), discarding each `e.path` that
`multiEditDetailArgs` already preserved (`tool-args.ts:124`). `MultiEditDiff` groups by
`edit.path` (`multi-edit-diff.tsx:50-54`), so all edits collapse into one group. The
"1 file" in the screenshot is a **collapse artifact**, not a correct count - a genuinely
multi-file `multi_edit` would *also* mislabel as "1 file". The `+X -Y` counts derive from
edit text and are always right. The transcript **row** renderer already reads `e.path` per
edit correctly (`tool-message.tsx:83-95`), which is why the row shows filenames while the
detail pane does not.

### Fix shape

<!-- D-001 -->
**Coherent fix in the shared registry.** `apps/web/src/tool-args.ts` is the single owner of
tool-argument parsing and salient-field extraction (its module comment: "Transcript rows,
compact rows, and detail takeovers all read this module so a tool's argument shape is
declared once"). Deepen **C-18** consolidated the salient-arg registry there for exactly
this reason. So `multi_edit`'s path is derived from `edits[].path` **once**, in
`tool-args.ts`, and all three surfaces read it - a detail-view-only patch would leave the
compact summary and live status pathless, reopening the drift C-18 removed.

<!-- D-005 -->
**Single-string surfaces** (`salientToolArg` → action label, `compactToolSummary`) take one
bounded string: the **first distinct** edit path, plus a bounded `+N` / `N files` indicator
when the edits span more than one file. This honors the label redaction doctrine
(`toolSummary` / `redactLabelFragment`: a single ≤48-char fragment, never the raw args
blob).

<!-- D-002 -->
**Detail FILE section** takes the full list: one clickable `FilePath` chip per **distinct**
path, first-seen order; the section title is `File` for one file and `Files` for many. A
single-file `multi_edit` renders exactly one chip - the current look is unchanged; only the
`(none)` bug and the multi-file case change.

### Key Constraints

| Constraint | Impact |
|---|---|
| Redaction doctrine (`tool-args.ts:64-68`, `action-label.ts:27`) | A missing/malformed salient field must collapse to `""`, never leak raw args. Path derivation must return `""`/empty on a malformed `edits` array, never fall through to the args blob. |
| One salient-arg registry (deepen C-18) | The distinct-path derivation lives in `tool-args.ts` and is the single source; `salientToolArg`, `compactToolSummary`, and `multiEditDetailArgs` all read it - no second per-surface path map. |
| `MultiEditDiff` groups by `edit.path` (`multi-edit-diff.tsx:48-56`) | The detail view must feed it edits carrying their real `e.path` so per-file grouping and the `N files` summary are correct. |
| Streaming tolerance | `multi_edit` args stream in; an edit may arrive before its `path`. Derivation and rendering must tolerate a partial/empty `edits` array without throwing (existing "No edits streamed yet." fallback stays). |

### Boundaries

- `apps/web/src/tool-args.ts` - **owns** the new `multiEditPaths(...)` distinct-path
  helper and the `multi_edit` branch of `salientToolArg`; `MultiEditDetailArgs` exposes
  `paths: readonly string[]`.
- `apps/web/src/tool-detail/detail-body.tsx` - `MultiEditDetail` renders per-file chips and
  feeds `MultiEditDiff` edits with their own `e.path`. No path logic of its own beyond
  reading `paths`.
- `apps/web/src/components/chat/compact-display.ts` - `compactToolSummary`'s `multi_edit`
  branch reads the shared helper (drops the top-level `parsed.path` / dead `?? file_path`).
- `apps/web/src/action-label.ts` - unchanged; it already composes from `toolSummary`, so
  fixing `salientToolArg` fixes the live label for free (locked by a test).
- No host / protocol change. `multi_edit`'s wire shape is already correct; this is purely a
  web-side read fix.

### Observability

No runtime/transport/provider change. The only observable surface is the rendered UI; the
verification milestone drives a real `multi_edit` in the app and asserts on the detail
FILE section and Storybook stories.

---

## Phases

### Phase 1: Resolve multi_edit's file path from edits[]

**Goal:** the FILE chip, compact summary, and live status label all name the file(s) a
`multi_edit` touches, and the detail view shows every distinct file.

**Gate from previous:** none.

#### M1: Shared salient-path derivation (registry + single-string surfaces)

- **Dependencies:** none
- **Effort:** S (1-3d)
- **Tasks:**
  1. RED: Add a failing test (`apps/web/src/tool-args.test.ts`, real host shape
     `{"edits":[{"path":"a.ts","old":"x","new":"y"}]}`) asserting
     `salientToolArg("multi_edit", …)` returns `"a.ts"` (today it returns `undefined` via
     `args.path`), and a multi-file case returns the first path.
  2. GREEN: Add a `multiEditPaths(edits)` helper (distinct paths, first-seen order) and a
     `multi_edit` branch to `salientToolArg` returning the first distinct edit path.
  3. RED: Add a failing test asserting
     `toolActionLabel("multi_edit", '{"edits":[{"path":"a.ts",…}]}') === "editing a.ts"`
     (today `"editing"`), plus a multi-file case asserting the bounded `N files` indicator.
  4. GREEN: Confirm the label resolves through the fixed `salientToolArg`/`toolSummary`;
     add the `+N`/`N files` indicator for the multi-file single-string case (D-005). Lock
     with the test.
  5. RED: Add a failing test that `compactToolSummary("multi_edit", realArgs)` includes the
     path (today only the edit count).
  6. GREEN: Point `compactToolSummary`'s `multi_edit` branch at `multiEditPaths` and drop
     the top-level `parsed.path` read and the dead `?? str(parsed.file_path)`.
  7. REFACTOR: Ensure `salientToolArg`, `compactToolSummary`, and `multiEditDetailArgs` all
     read the one `multiEditPaths` helper (C-18 single registry); no second path map.

#### M2: Detail FILE chip + multi-file diff correctness

- **Dependencies:** M1
- **Effort:** S (1-3d)
- **Tasks:**
  1. RED: Rewrite the `multi_edit` detail test (`detail-body.test.tsx:74-84`) to the real
     host shape (`{"edits":[{"path":"a.ts","old":"x","new":"y"},{"path":"a.ts",…}]}`) and
     assert the FILE section renders `a.ts` (not `(none)`). Fails today.
  2. GREEN: `multiEditDetailArgs` exposes `paths: readonly string[]` (distinct, via
     `multiEditPaths`); `MultiEditDetail` renders one `FilePath` chip per distinct path with
     title `File`/`Files` (D-002).
  3. RED: Add a multi-file detail test
     (`{"edits":[{"path":"a.ts",…},{"path":"b.ts",…}]}`) asserting BOTH `a.ts` and `b.ts`
     chips render AND the CHANGES summary reads `2 files` (today it collapses to `1`). Fails
     today.
  4. GREEN: Fix `detail-body.tsx:306` to feed `MultiEditDiff` each edit with its own
     `e.path` instead of the single top-level `path` (D-004), so grouping and the `N files`
     summary are correct.
  5. REFACTOR: Replace the fictitious top-level-`path` fixtures in `detail-body.test.tsx`
     and `tool-detail-view.stories.tsx` (`MultiEditChanges`) with the real host schema; add
     a `MultiEditMultiFile` Storybook story as the visual fixture; drop the now-unused
     top-level `path` field from `MultiEditDetailArgs` if nothing else reads it.

#### M3: Verification

- **Dependencies:** M1, M2
- **Effort:** S (≤1d)
- **Tasks:**
  1. RED: Reproduce the bug in the real app first (per `/verify`): open a session, have the
     model run a single-file `multi_edit`, open the tool detail, confirm FILE shows `(none)`
     - the pre-fix EZE repro that proves the fix.
  2. GREEN: Re-drive the same flow post-fix; confirm the FILE section names the file, and a
     multi-file `multi_edit` shows every file and the correct `N files` summary. Record the
     evidence.
  3. REFACTOR: Run the full validation gate (below) and the `MultiEditChanges` /
     `MultiEditMultiFile` stories; fix any lint/type/test fallout.

### Gate 1→done

- [ ] `pnpm test:web` passes (new + updated `tool-args`/`detail-body` tests).
- [ ] `pnpm --filter @trevor/web typecheck` clean.
- [ ] `pnpm lint` clean.
- [ ] `pnpm --filter @trevor/web build-storybook` succeeds; `MultiEditChanges` and
      `MultiEditMultiFile` render the file(s), not `(none)`.
- [ ] Real-app drive (M3) confirms a `multi_edit` names its file(s) in the detail FILE
      section.

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---|---|---|---|
| Changing `MultiEditDetailArgs.path` → `paths` breaks another reader | low | low | Grep confirms `multiEditDetailArgs` is consumed only by `MultiEditDetail`; keep the change local | impl |
| Multi-file indicator blows the ≤48-char label bound | low | low | Reuse `redactLabelFragment`/`truncateText`; assert the bound in a test | impl |
| Streaming partial `edits` (edit before its path) throws | low | low | `multiEditPaths` filters empties; existing "No edits streamed yet." fallback stays | impl |

---

## Non-Goals

- No host / protocol / `multi_edit` wire-shape change - the wire is already correct.
- No redesign of the diff renderer (`MultiEditDiff`), only feeding it correct per-edit paths.
- No change to `edit`/`write` detail rendering - their top-level `path` is correct.

---

## Validation Commands

```bash
pnpm test:web                          # vitest --project web (tool-args + detail-body)
pnpm --filter @trevor/web typecheck    # tsgo --noEmit
pnpm lint                              # biome check . + check:filenames
pnpm --filter @trevor/web build-storybook
```

---

## Decisions

Canonical decisions live in `.plans/08.1-multi-edit-detail-file/plan.db`. Query with:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts \
  query-decisions --plan "08.1-multi-edit-detail-file"
```

- <!-- D-001 --> Coherent shared fix in the `tool-args` salient registry (all three surfaces).
- <!-- D-002 --> One `FilePath` chip per distinct file; title `File`/`Files`.
- <!-- D-003 --> Numbered `08.1` off completed plan 08; no downstream threading.
- <!-- D-004 --> Feed `MultiEditDiff` each edit's own `e.path`; the "1 file" was a collapse artifact.
- <!-- D-005 --> Single-string surfaces = first distinct path + bounded `N files` indicator.
