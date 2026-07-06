# 08.1 multi-edit-detail-file - Progress Report

**Stage:** implementing

**Current focus:** Phase 1 · M3 - Verification (real-app drive + full validation gate)

The `multi_edit` detail FILE section renders `(none)` because three web surfaces read a
top-level `input.path` that `multi_edit` never sets (its path is per-edit under
`edits[].path`). Resolve the path once in the `tool-args` salient registry; fix the detail
view to show one chip per distinct file.

## Summary

- **Milestones:** 3 (M1, M2, M3) - 2/3 complete
- **Tasks (current cutoff):** 12/15 checked
- **Deferred / follow-up:** none
- **Superseded:** none

All work is current-cutoff. No deferred or superseded buckets.

---

## Phase 1: Resolve multi_edit's file path from edits[]

### M1: Shared salient-path derivation (registry + single-string surfaces) - 7/7

- [x] RED: failing `salientToolArg("multi_edit", {edits:[{path:"a.ts",…}]})` test in
      `apps/web/src/tool-args.test.ts` - expects `"a.ts"` (today `undefined`); multi-file
      case expects the first path.
- [x] GREEN: add `multiEditPaths(edits)` (distinct, first-seen) + a `multi_edit` branch in
      `salientToolArg` returning the first distinct edit path.
- [x] RED: failing `toolActionLabel("multi_edit", '{"edits":[{"path":"a.ts",…}]}')` test -
      expects `"editing a.ts"` (today `"editing"`); multi-file expects the bounded `N files`
      indicator (updated the pre-existing fictitious-top-level-`path` case in `action-label.test.ts`).
- [x] GREEN: confirm the label resolves through the fixed `salientToolArg`/`toolSummary`;
      add the `(N files)` indicator for the multi-file single-string case (D-005).
- [x] RED: failing `compactToolSummary("multi_edit", realArgs)` test - migrated the compact
      fixture to the real host schema; added a multi-file case asserting `2 files`.
- [x] GREEN: point `compactToolSummary`'s `multi_edit` branch at the shared `salientToolArg`
      (which reads `multiEditPaths`); dropped the top-level `parsed.path` read, the dead
      `?? str(parsed.file_path)`, and the now-unused local `str` helper.
- [x] REFACTOR: `salientToolArg` and `compactToolSummary` read the one `multiEditPaths` helper
      (C-18 single registry, compact via `salientToolArg`); `multiEditDetailArgs` joins in M2.

### M2: Detail FILE chip + multi-file diff correctness - 5/5

- [x] RED: rewrite the `multi_edit` detail test to the real host shape and assert the FILE
      section shows `a.ts`, not `(none)`.
- [x] GREEN: `multiEditDetailArgs` exposes `paths: readonly string[]`; `MultiEditDetail`
      renders one `FilePath` chip per distinct path with title `File`/`Files` (D-002).
- [x] RED: multi-file detail test (`edits` across `a.ts` and `b.ts`) - asserts both chips
      render AND the CHANGES summary reads `2 files` (today collapses to `1`).
- [x] GREEN: feed `MultiEditDiff` each edit's own `e.path` instead of the single top-level
      `path` (D-004).
- [x] REFACTOR: migrated the fictitious top-level-`path` fixtures in `detail-body.test.tsx`,
      `detail-args.test.tsx`, and `tool-detail-view.stories.tsx` to the real host schema; added
      a `MultiEditMultiFile` story; replaced the top-level `path` on `MultiEditDetailArgs` with
      `paths` (its only reader is `MultiEditDetail`).

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
