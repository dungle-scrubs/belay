# 08.1 multi-edit-detail-file - Progress Report

**Stage:** ready

**Current focus:** Phase 1 · M1 - Shared salient-path derivation (first RED: `salientToolArg("multi_edit", ...)` test)

The `multi_edit` detail FILE section renders `(none)` because three web surfaces read a
top-level `input.path` that `multi_edit` never sets (its path is per-edit under
`edits[].path`). Resolve the path once in the `tool-args` salient registry; fix the detail
view to show one chip per distinct file.

## Summary

- **Milestones:** 3 (M1, M2, M3) - 0/3 complete
- **Tasks (current cutoff):** 0/15 checked
- **Deferred / follow-up:** none
- **Superseded:** none

All work is current-cutoff. No deferred or superseded buckets.

---

## Phase 1: Resolve multi_edit's file path from edits[]

### M1: Shared salient-path derivation (registry + single-string surfaces) - 0/7

- [ ] RED: failing `salientToolArg("multi_edit", {edits:[{path:"a.ts",…}]})` test in
      `apps/web/src/tool-args.test.ts` - expects `"a.ts"` (today `undefined`); multi-file
      case expects the first path.
- [ ] GREEN: add `multiEditPaths(edits)` (distinct, first-seen) + a `multi_edit` branch in
      `salientToolArg` returning the first distinct edit path.
- [ ] RED: failing `toolActionLabel("multi_edit", '{"edits":[{"path":"a.ts",…}]}')` test -
      expects `"editing a.ts"` (today `"editing"`); multi-file expects the bounded `N files`
      indicator.
- [ ] GREEN: confirm the label resolves through the fixed `salientToolArg`/`toolSummary`;
      add the `+N`/`N files` indicator for the multi-file single-string case (D-005).
- [ ] RED: failing `compactToolSummary("multi_edit", realArgs)` test - expects the path
      present (today only the edit count).
- [ ] GREEN: point `compactToolSummary`'s `multi_edit` branch at `multiEditPaths`; drop the
      top-level `parsed.path` read and the dead `?? str(parsed.file_path)`.
- [ ] REFACTOR: `salientToolArg`, `compactToolSummary`, and `multiEditDetailArgs` all read
      the one `multiEditPaths` helper (C-18 single registry); no second path map.

### M2: Detail FILE chip + multi-file diff correctness - 0/5

- [ ] RED: rewrite the `multi_edit` detail test (`detail-body.test.tsx:74-84`) to the real
      host shape and assert the FILE section shows `a.ts`, not `(none)`. Fails today.
- [ ] GREEN: `multiEditDetailArgs` exposes `paths: readonly string[]`; `MultiEditDetail`
      renders one `FilePath` chip per distinct path with title `File`/`Files` (D-002).
- [ ] RED: multi-file detail test (`edits` across `a.ts` and `b.ts`) - asserts both chips
      render AND the CHANGES summary reads `2 files` (today collapses to `1`). Fails today.
- [ ] GREEN: fix `detail-body.tsx:306` to feed `MultiEditDiff` each edit's own `e.path`
      instead of the single top-level `path` (D-004).
- [ ] REFACTOR: replace the fictitious top-level-`path` fixtures in `detail-body.test.tsx`
      and `tool-detail-view.stories.tsx` with the real host schema; add a `MultiEditMultiFile`
      story; drop the unused top-level `path` from `MultiEditDetailArgs` if nothing reads it.

### M3: Verification - 0/3

- [ ] RED: reproduce in the real app first (`/verify`) - a single-file `multi_edit`'s detail
      FILE shows `(none)`; the EZE repro that proves the fix target.
- [ ] GREEN: re-drive post-fix - FILE names the file; a multi-file `multi_edit` shows every
      file and the correct `N files` summary. Record evidence.
- [ ] REFACTOR: run the full validation gate + both stories; fix any lint/type/test fallout.

### Gate 1→done

- [ ] `pnpm test:web` passes.
- [ ] `pnpm --filter @trevor/web typecheck` clean.
- [ ] `pnpm lint` clean.
- [ ] `pnpm --filter @trevor/web build-storybook`; `MultiEditChanges` + `MultiEditMultiFile`
      render the file(s), not `(none)`.
- [ ] Real-app drive confirms a `multi_edit` names its file(s) in the detail FILE section.

---

## Deferred / Follow-up

None.

## Superseded / Obsolete

None.
