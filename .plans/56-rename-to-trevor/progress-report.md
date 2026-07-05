# Rename trevorV2 to trevor - Progress Report

Nothing is built yet. Phase 1 (M1-M3) is in-repo and merges as one branch; Phase 2 (M4) is a one-time
owner-run cutover runbook executed after Phase 1 merges.

## Summary

- **Current cutoff blockers:** 21
- **Completed current work:** 0
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** M1 task 1 - flip `node-paths.test.ts` + `node-paths-drift.test.ts` to the new dirnames (RED)

## Completed Current State / Hard Dependencies

- [x] `packages/session/src/node-paths.ts` is the single home-dir owner (`TREVOR_HOME_DIRNAME`,
  `TREVOR_STATE_DIRNAME`, `LEGACY_TREVOR_DIRNAME`, `resolveRootPolicy`, `STORAGE_INVENTORY`), enforced by
  `node-paths-drift.test.ts`.
- [x] npm identity already `trevor` (`package.json` name, `@trevor/*` scope, `TREVOR_*`, `.trevor/`) - no
  package/scope rename. <!-- D-001 -->
- [x] Target names free on disk: `~/dev/trevor` and `~/.trevor` do not exist; old data is at
  `~/dev/trevor_legacy` / `~/.trevor_legacy`. <!-- D-003 -->

## Current Cutoff Blockers

### Phase 1 - M1: Home dirnames + legacy repoint (runtime source of truth)

- [ ] RED: Flip `node-paths.test.ts` (`TREVOR_HOME_DIRNAME === ".trevor"`, `TREVOR_STATE_DIRNAME ===
  "trevor"`, derived `~/.trevor` / `~/.local/state/trevor` paths) and `node-paths-drift.test.ts` target
  literal so they fail against current code.
- [ ] RED: Update `legacy-migration.test.ts` to expect the migration source under `~/.trevor_legacy`.
- [ ] GREEN: Set `node-paths.ts:15,18,101` (`.trevor`, `trevor`, `.trevor_legacy`) + the four doc-comment
  literals; update `apps/agent-host/package.json:12,14` shell default to `${TREVOR_HOME:-$HOME/.trevor}`.
- [ ] GREEN: Tighten the drift guard's home-root literal (`join(home, ".trevor")` / `~/.trevor`) so it does
  not match the legitimate project-local `.trevor/` workspace paths; confirm it passes.
- [ ] REFACTOR: Align `resolveRootPolicy` legacy category + `STORAGE_INVENTORY` `legacy-root` +
  inline docs to `~/.trevor_legacy`.

### Phase 1 - M2: Fixture, story, and user-string literals

- [ ] RED: Run the full suite; enumerate the ~60 test/story files whose assertions embed the old literal
  and now fail after M1.
- [ ] GREEN: Update derived-path assertions across `session-store`/`blob-store` config tests,
  `packages/launcher/{src,test}`, `apps/agent-host/**` tests, and `packages/session/**` tests.
- [ ] GREEN: Update `apps/web/**` test + story fixtures + `doctor-fixtures.ts` (`~/dev/trevorV2`,
  `state/trevorV2`, `~/.trevorV2` -> new).
- [ ] GREEN: Fix the two CLI banners - `trevor-cli/src/main.ts:227` USAGE and `:303` `--version` (drop
  "V2"/"trevorV2").
- [ ] REFACTOR: Grep-verify zero `trevorV2` / `.trevorV2` / `state/trevorV2` remain in `apps/**` +
  `packages/**` (identity-only allowlist: semver `v2.*`, Tauri `v2`, lineage comments).

### Phase 1 - M3: Docs, skills, and semantic "legacy vs trevor" rewrites

- [ ] RED: Add a `repo-policy` check failing on `Trevor V2` / `trevorV2` / `~/.trevorV2` in tracked docs or
  `.claude/skills`, allowlisting the two historical `.plans/trevor-v2/` umbrella lines.
- [ ] GREEN: Mechanical doc sweep across `AGENTS.md`, `CONTEXT.md`, `FEATURES.md`, `SECURITY_RISKS.md`,
  `apps/AGENTS.md`, `docs/*`, and plain refs in `.plans/46,48,49`; update the remote ref `AGENTS.md:11`
  (`dungle-scrubs/trevorV2` -> `dungle-scrubs/trevor`).
- [ ] GREEN: Semantic rewrites (D-005) - AGENTS.md:93-95, CONTEXT.md:41,134,135 -> "trevor legacy vs trevor".
- [ ] GREEN: `.claude/skills` sweep - `plan-next-feature` + `implement-plan`: 11 hardcoded paths ->
  `/Users/kevin/dev/trevor`; 3 "V1 prior art `~/dev/trevor`" lines -> `~/dev/trevor_legacy`; "Trevor V2"
  titles -> "Trevor".
- [ ] REFACTOR: M3 guard green; only the two allowlisted historical lines remain.

### Phase 2 - M4: Cutover runbook + EZE verification (owner-run, post-merge, manual EZE)

- [ ] Clear v1 collisions: `mv ~/.local/state/trevor ~/.local/state/trevor_legacy` and
  `mv ~/.claude/projects/-Users-kevin-dev-trevor{,_legacy}`. <!-- D-003 -->
- [ ] Move live data: `mv ~/.trevorV2 ~/.trevor` and `mv ~/.local/state/trevorV2 ~/.local/state/trevor`. <!-- D-002 -->
- [ ] Rename GitHub repo `dungle-scrubs/trevorV2` -> `dungle-scrubs/trevor` (owner) + `git remote set-url`;
  repo stays private; leave the `dungle-scrubs/web-search` dependency untouched.
- [ ] Move the working dir `mv ~/dev/trevorV2 ~/dev/trevor`; reopen the session there.
- [ ] Migrate Claude memory `mv ~/.claude/projects/-Users-kevin-dev-trevorV2{,}` -> `-Users-kevin-dev-trevor`;
  keep `trevor-v2-*` slugs; fix substantive in-body refs. <!-- D-007 -->
- [ ] EZE verify: host boots against `~/.trevor`; `sessions.db` opens with prior history; `/doctor` shows
  `~/.trevor` + `~/.local/state/trevor` and legacy `~/.trevor_legacy`; `git remote -v` renamed; drift test green.
