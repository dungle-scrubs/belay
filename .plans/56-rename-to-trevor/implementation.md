# Rename trevorV2 to trevor - Implementation Plan

Rename the project from `trevorV2` to `trevor` now that the previous Trevor ("trevor legacy") has been
moved aside: `~/dev/trevor` -> `~/dev/trevor_legacy` and `~/.trevor` -> `~/.trevor_legacy`. The rename is
narrower than it looks - the npm identity is **already** `trevor` (`package.json` name is `"trevor"`, every
workspace package is `@trevor/*`), so this is **not** a package rename. What actually changes is the two
user-global home dirnames, the working directory, the GitHub repo, ~305 test/story/fixture path literals,
the docs, the in-repo `.claude/skills`, and the (out-of-repo) Claude project memory. <!-- D-001 -->

The runtime surface is tiny and centralized: `packages/session/src/node-paths.ts` is the single owner of
both home dirnames, enforced by a drift test, so the behavioral change is two string constants plus a
legacy-pointer repoint. Everything else is mechanical fallout (fixtures, docs) or one-time real-world
cutover (data move, repo rename, working-dir move, memory migration). <!-- D-001 -->

## 0. Hard Dependencies

- [x] **`packages/session/src/node-paths.ts` (shipped, plan 03 taxonomy).** The single definition site of
  `TREVOR_HOME_DIRNAME` (`.trevorV2`), `TREVOR_STATE_DIRNAME` (`trevorV2`), and `LEGACY_TREVOR_DIRNAME`
  (`.trevor`), plus `resolveRootPolicy`/`STORAGE_INVENTORY`. A drift test (`node-paths-drift.test.ts`)
  already enforces that no other runtime source re-spells the home root - the rename rides that guard.
- [x] **The npm identity is already `trevor`.** Root `package.json` `"name": "trevor"`, `@trevor/*` scope,
  `TREVOR_*` env prefix, `.trevor/` project dir - none contain "V2"; none change. <!-- D-001 -->
- [x] **Owner has freed the target names.** `~/dev/trevor` and `~/.trevor` do not exist on disk
  (confirmed); the old data is at `~/dev/trevor_legacy` and `~/.trevor_legacy`. <!-- D-003 -->

**No upstream plan dependencies.** This is a foundational cross-cutting rename; it depends on shipped
infrastructure only, so it is eligible immediately.

**Downstream plans (this plan is sequenced FIRST, ahead of the 46/48/49 backlog, via forward-deps - not
renumbering):** <!-- D-006 -->
- **`.plans/49-open-source-launch-readiness` (concrete accommodation).** 49 gains an upstream hard-dep on
  56. Its WS4 "drop the V2 suffix ... keep back-compat for the actual `~/.trevorV2` dir" is **superseded** -
  56 does the real dir rename, so WS4 keeps only README/description/app-title/trademark polish. 49's stale
  "Plan 49 is the highest-numbered plan / terminal / no downstream" note is corrected. <!-- D-008 -->
- **`.plans/48-desktop-shell-tauri` (coordination note).** 48 has no `trevorV2` literals, but its Tauri app
  identity (bundle id, product name, window title) must be built against the final `trevor` name since 56
  lands first; paths derive from `node-paths` (already `~/.trevor`). <!-- D-008 -->
- **`.plans/46-worktree-fleet` (considered, skipped).** Its worktree paths derive from `node-paths` and
  auto-adjust; its single `trevor-v2` doc reference is cosmetic and is swept by 56's M3 doc pass. No design
  accommodation. <!-- D-008 -->

## 1. Architecture

The rename is layered by blast radius, smallest first. Each layer is a milestone (M1-M4).

- **Runtime (M1) - two constants + one repoint.** `TREVOR_HOME_DIRNAME` `.trevorV2` -> `.trevor` and
  `TREVOR_STATE_DIRNAME` `trevorV2` -> `trevor` in `node-paths.ts`; every consumer (`resolveTrevorHome`,
  `resolveTrevorStateHome`, the root taxonomy, `STORAGE_INVENTORY`, the launcher, both stores) derives from
  these, so no consumer changes. The **legacy-pointer collision** is the one real design point: the new
  active config home `.trevor` equals the current `LEGACY_TREVOR_DIRNAME`, so the legacy pointer is
  repointed to `.trevor_legacy` (where the owner moved the old data), keeping `legacy-migration.ts`, the
  `legacy` root category, and the doctor legacy area correct. <!-- D-004 --> One non-`node-paths` leak
  exists: `apps/agent-host/package.json:12,14` hardcodes `${TREVOR_HOME:-$HOME/.trevorV2}/.env.op` in
  shell (the drift test cannot see shell), so it is updated in lockstep. <!-- D-001 -->
- **Fixtures + user strings (M2) - ~305 literals across ~62 files.** Test assertions and Storybook stories
  embed `.trevorV2`, `~/.local/state/trevorV2`, or `~/dev/trevorV2` as fixtures. After M1 flips the
  constants these assertions fail (the RED signal); M2 updates each to the new literal. The only two
  **user-facing** strings that carry the old name are the CLI banners `trevor-cli/src/main.ts:227` (USAGE)
  and `:303` (`--version`, "trevor v2 (trevorV2 launcher)") - both fixed here. <!-- D-001 -->
- **Docs + skills (M3) - prose.** Mechanical `Trevor V2`->`Trevor`, `~/.trevorV2`->`~/.trevor`,
  `/Users/kevin/dev/trevorV2`->`/Users/kevin/dev/trevor` across root docs, `docs/`, `.claude/skills`, and
  the plain refs in active plan docs (46/48/49). The **semantic** rewrites turn every "trevor v1 vs trevor
  v2" comparison into "trevor legacy vs trevor" (paths `~/dev/trevor_legacy` / `~/.trevor_legacy`; prose
  "trevor legacy") at the four sites AGENTS.md:93-95, CONTEXT.md:41,134,135. <!-- D-005 --> Historical
  references to the retired `.plans/trevor-v2/` umbrella stay **verbatim** (a proper noun for a removed
  artifact). <!-- D-006 -->
- **Cutover (M4) - one-time real-world ops, post-merge.** Not code: a runbook the owner executes after
  M1-M3 merge. Move the two v1 collisions to `_legacy`, move the live data forward, rename the GitHub repo
  + `git remote set-url`, move the working directory, and migrate the Claude project memory dir. Verified
  by an EZE checklist (host boots against `~/.trevor`, session history intact, doctor legacy area shows
  `~/.trevor_legacy`). <!-- D-002 --> <!-- D-007 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| `node-paths.ts` is the single home-dir owner; a drift test enforces it <!-- D-001 --> | The runtime change is 3 constants; all path consumers auto-follow. |
| New config home `.trevor` collides with the legacy pointer `.trevor` <!-- D-004 --> | Legacy pointer must repoint to `.trevor_legacy`, not stay at `.trevor`, or legacy detection would target the live config home. |
| Drift guard literal `~/.trevor` vs project-local `.trevor/` | The drift test currently matches the unambiguous `.trevorV2`; after rename it must match the **home root** (`join(home, ".trevor")` / `~/.trevor`), not the many legitimate `.trevor/commands`, `.trevor/rules` workspace references. |
| No back-compat migration code <!-- D-002 --> | The app does not auto-move `~/.trevorV2`; the one-time move is a documented M4 runbook. Renamed code that boots before M4 would see an empty `~/.trevor` - so M4 cutover is coordinated (post-merge) and the owner runs it before the next real host boot. |
| Identity-only depth <!-- D-001 --> | Leave semver (`v2.0.0-dev` fixtures), framework versions (Tauri v2), and the ~14 code-comment V1->V2 lineage notes untouched - they are versions/history, not branding. |

### Boundaries

- **Runtime name ownership:** `packages/session/src/node-paths.ts` (constants) + `legacy-migration.ts`
  (consumes the legacy constant). Nothing else defines a home-dir string.
- **Fixtures:** `apps/**` and `packages/**` test/story/fixture files - assertion literals only, no
  production-logic change.
- **Docs + skills:** root `*.md`, `docs/`, `.claude/skills/{plan-next-feature,implement-plan}`; active plan
  docs 46/48/49 (plain refs only).
- **Out-of-repo (M4 runbook, not committed):** `~/.trevorV2`, `~/.local/state/trevorV2`, the GitHub repo,
  the working directory, and `~/.claude/projects/-Users-kevin-dev-trevorV2/`.

### Observability

The rename is verified by (a) the existing `node-paths.test.ts` + `node-paths-drift.test.ts` (assert the new
dirnames + no stray old literal in runtime source), (b) the full test suite going green after the fixture
sweep, and (c) the M4 EZE checklist (doctor storage/legacy areas render `~/.trevor` + `~/.trevor_legacy`;
`resolveTrevorHome()` -> `~/.trevor`; `sessions.db` found so session history survives).

---

## 2. Phases

### Phase 1: Rename (in-repo, merges as one branch)

**Goal:** the codebase, tests, docs, and skills say `trevor` (not `trevorV2`); the suite + drift guard are
green; nothing on real disk has moved yet.

#### M1: Home dirnames + legacy repoint (runtime source of truth)

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Update `node-paths.test.ts` (`:18` expect `TREVOR_HOME_DIRNAME === ".trevor"`, `:30` expect
     `TREVOR_STATE_DIRNAME === "trevor"`, and the derived `~/.trevor` / `~/.local/state/trevor` path
     assertions) and `node-paths-drift.test.ts` (`:13` target literal) so they fail against the current
     code.
  2. RED: Update `legacy-migration.test.ts` to expect the migration source under `~/.trevor_legacy`.
  3. GREEN: Set `node-paths.ts:15` `TREVOR_HOME_DIRNAME = ".trevor"`, `:18` `TREVOR_STATE_DIRNAME =
     "trevor"`, `:101` `LEGACY_TREVOR_DIRNAME = ".trevor_legacy"`; update the four doc-comment literals
     (`:11,:22,:38,:221`). Update `apps/agent-host/package.json:12,14` shell default to
     `${TREVOR_HOME:-$HOME/.trevor}/.env.op`.
  4. GREEN: Tighten the drift guard so its home-root literal (`~/.trevor` / `join(home, ".trevor")`) does
     not match the legitimate project-local `.trevor/` workspace paths; confirm it passes.
  5. REFACTOR: Confirm `resolveRootPolicy` legacy category + `STORAGE_INVENTORY` `legacy-root` description
     read `~/.trevor_legacy`; align the inline doc comments.

#### M2: Fixture, story, and user-string literals

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Run the full suite; enumerate the ~60 test/story files whose assertions embed the old literal
     (`.trevorV2`, `~/.local/state/trevorV2`, `~/dev/trevorV2`) and now fail after M1.
  2. GREEN: Update the derived-path assertions across `apps/session-store/src/config.test.ts`,
     `apps/blob-store/src/config.test.ts`, `packages/launcher/{src,test}/*`, `apps/agent-host/**` tests,
     and `packages/session/**` tests to the new literals.
  3. GREEN: Update `apps/web/**` test + story fixtures + `doctor-fixtures.ts` (`~/dev/trevorV2` ->
     `~/dev/trevor`, `state/trevorV2` -> `state/trevor`, `~/.trevorV2` -> `~/.trevor`).
  4. GREEN: Fix the two user-facing CLI banners - `trevor-cli/src/main.ts:227` USAGE ("Trevor V2" ->
     "Trevor") and `:303` `--version` ("trevor v2 (trevorV2 launcher)" -> drop "V2"/"trevorV2").
  5. REFACTOR: Grep-verify zero `trevorV2` / `.trevorV2` / `state/trevorV2` literals remain in `apps/**` +
     `packages/**`, excluding the identity-only allowlist (semver `v2.*`, Tauri `v2`, lineage comments).

#### M3: Docs, skills, and semantic "legacy vs trevor" rewrites

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add a `packages/repo-policy` string check that fails when `Trevor V2` / `trevorV2` / `~/.trevorV2`
     appears in tracked docs or `.claude/skills`, with a minimal allowlist for the two historical
     `.plans/trevor-v2/` umbrella lines (AGENTS.md:200, CONTEXT.md:4).
  2. GREEN: Mechanical doc sweep - `Trevor V2`->`Trevor`, `~/.trevorV2`->`~/.trevor`,
     `/Users/kevin/dev/trevorV2`->`/Users/kevin/dev/trevor` across `AGENTS.md`, `CONTEXT.md`, `FEATURES.md`,
     `SECURITY_RISKS.md`, `apps/AGENTS.md`, `docs/capability-manifest.md`, `docs/telemetry.md`, and the
     plain refs in `.plans/46,48,49`. Update the repo remote ref `AGENTS.md:11`
     (`dungle-scrubs/trevorV2` -> `dungle-scrubs/trevor`).
  3. GREEN: Semantic rewrites (D-005) - AGENTS.md:93-95 (legacy data now at `~/.trevor_legacy`),
     CONTEXT.md:41 (teams), :134-135 (0-based vs 1-based) become "trevor legacy vs trevor".
  4. GREEN: `.claude/skills` sweep - `plan-next-feature` + `implement-plan`: the 11 hardcoded
     `/Users/kevin/dev/trevorV2` paths -> `/Users/kevin/dev/trevor`; the 3 "V1 prior art `~/dev/trevor`"
     lines -> `~/dev/trevor_legacy` ("trevor legacy"); the "Trevor V2" titles/descriptions -> "Trevor".
  5. REFACTOR: Run the M3 RED guard to green; confirm only the two allowlisted historical lines remain.

### Gate 1

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` (incl. hermetic e2e) all green.
- [ ] `node-paths.test.ts` + `node-paths-drift.test.ts` assert the new dirnames and no stray old literal.
- [ ] The M3 docs/skills guard is green (only the two historical umbrella lines allowlisted).
- [ ] Grep: no `trevorV2` outside the identity-only allowlist (semver / Tauri v2 / lineage comments).

### Phase 2: Real-world cutover (owner-run runbook, post-merge)

**Goal:** live data, the GitHub repo, the working directory, and the Claude memory are on the new names;
the host boots against `~/.trevor` with session history intact.

**Gate from previous:** Phase 1 merged to `main`.

#### M4: Cutover runbook + EZE verification

- **Dependencies:** Phase 1 merged
- **Effort:** S (owner-executed; guided)
- **Note:** This milestone is a documented manual EZE, not RED/GREEN code. The plan supplies exact commands
  and a verification checklist; the owner runs it (the GitHub rename and the working-dir move require the
  owner and change this repo's own path).
- **Tasks (ordered runbook):**
  1. Clear the two v1 collisions: `mv ~/.local/state/trevor ~/.local/state/trevor_legacy` and
     `mv ~/.claude/projects/-Users-kevin-dev-trevor ~/.claude/projects/-Users-kevin-dev-trevor_legacy`
     (the latter re-links v1's Claude memory to its moved `~/dev/trevor_legacy` home). <!-- D-003 -->
  2. Move live data forward: `mv ~/.trevorV2 ~/.trevor` and
     `mv ~/.local/state/trevorV2 ~/.local/state/trevor`. <!-- D-002 -->
  3. Rename the GitHub repo `dungle-scrubs/trevorV2` -> `dungle-scrubs/trevor` (owner, via GitHub web or
     `gh repo rename`; GitHub auto-redirects the old URL). Then
     `git remote set-url origin git@github.com:dungle-scrubs/trevor.git`. The repo stays **private**. Leave
     the unrelated `dungle-scrubs/web-search` dependency untouched.
  4. Move the working directory: `mv ~/dev/trevorV2 ~/dev/trevor`; reopen the session there (no linked
     worktrees reference the old path, so the git main worktree move is clean).
  5. Migrate the Claude project memory: `mv ~/.claude/projects/-Users-kevin-dev-trevorV2
     ~/.claude/projects/-Users-kevin-dev-trevor` (memory/ + session jsonl). Keep the `trevor-v2-*` memory
     slugs; fix the substantive in-body refs (`trevor-v2-host-config-secrets`, `trevor-v2-state-home`,
     `MEMORY.md`) to `~/.trevor` / `~/.local/state/trevor`. <!-- D-007 -->
  6. EZE verify: start a host; `resolveTrevorHome()` -> `~/.trevor`; `sessions.db` opens with prior history;
     `/doctor` storage area shows `~/.trevor` + `~/.local/state/trevor` and the legacy area shows
     `~/.trevor_legacy`; `git remote -v` shows the renamed origin; the drift test is green.

---

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Drift-guard literal `~/.trevor` false-matches project-local `.trevor/` paths | medium | medium | M1 task 4 tightens the guard to the home-root form (`join(home, ".trevor")` / `~/.trevor`), not bare `.trevor` | owner |
| Renamed code boots before M4 moves the data -> empty `~/.trevor`, "lost" sessions | high | low | No auto-migration by design; M4 is a coordinated post-merge cutover the owner runs before the next real host boot; tests use injected homes so implementation never touches real data | owner |
| A `trevorV2` literal is missed and creeps back | medium | medium | M2 grep-verify + M3 committed repo-policy docs guard catch residuals | owner |
| Overlap/contradiction with plan 49 WS4 | medium | medium | D-008 threads 49 (upstream dep + WS4 supersession) so the two do not both claim the dir rename | owner |
| GitHub rename breaks the unrelated `dungle-scrubs/web-search` dep | low | low | Only the origin remote changes; the dependency repo is a different repo and is left untouched | owner |

## 4. Non-Goals

- **No package/scope rename.** `@trevor/*`, `TREVOR_*`, `.trevor/` already carry no "V2" and do not change.
- **No public-launch branding.** README rewrite, package-description polish, and trademark clearance stay
  in plan 49 WS4. <!-- D-008 -->
- **No lineage/version edits.** Semver (`v2.0.0-dev`), Tauri `v2`, and code-comment V1->V2 architecture
  notes are left as-is. <!-- D-001 -->
- **No auto-migration code.** The data move is a one-time runbook, not shipped back-compat. <!-- D-002 -->
- **No memory-slug rename.** The 18 `trevor-v2-*` memory files keep their slugs/wikilinks; only the dir
  moves + substantive in-body refs update. <!-- D-007 -->

## 5. Validation Commands

```bash
pnpm lint
pnpm typecheck
pnpm test                 # unit + integration + web + hermetic e2e
# targeted:
pnpm exec vitest run --project unit packages/session/src/node-paths.test.ts \
  packages/session/src/node-paths-drift.test.ts packages/session/src/legacy-migration.test.ts
# residual-literal check (M2/M3):
rg -n --hidden -g '!.git' -g '!**/node_modules/**' 'trevorV2|\.trevorV2|state/trevorV2'
```

## 6. Decisions

Canonical decisions are in `.plans/56-rename-to-trevor/plan.db`. Key decisions use `<!-- D-NNN -->`
markers above: D-001 (scope + identity-only depth), D-002 (one-time-move migration, no back-compat code),
D-003 (target collisions -> `_legacy`), D-004 (legacy-pointer repoint), D-005 (comparison phrasing "legacy
vs trevor"), D-006 (number 56 + sequenced-first via forward-deps), D-007 (memory-dir migration, keep
slugs), D-008 (downstream accommodation: 49 concrete, 48 coordination, 46 skipped).
