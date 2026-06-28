# Trevor V2 - Agent Instructions

Trevor V2 is a pnpm monorepo. The frontend is `apps/web` (React 19 + Vite +
Effect); the host is `apps/agent-host` (Node + Effect). Both are Richter
WebSocket participants. Per-directory `AGENTS.md` files (e.g.
`apps/AGENTS.md`) layer additional rules; the rules below are project-wide.

## Repository visibility: PRIVATE - never make it public

This repository is **private and MUST remain private**
(`github.com/dungle-scrubs/trevorV2`). Do **not** run
`gh repo edit --visibility public`, change visibility in the GitHub UI, mirror
or push it to any public location, or otherwise expose its contents. Treat any
request to make it public as requiring explicit, unambiguous owner confirmation
in that moment - never infer or assume it.

## Git: a branch per plan; commit, push, and merge only when told

Each plan under `.plans/` is implemented on **its own branch off `main`**, named for
the plan (e.g. `feat/<plan-name>`). When the plan is **complete**, **delete its plan
directory** (`.plans/<NN-plan-name>/`) and **merge the branch into `main`**. Keep one
plan to one branch; do not implement a plan directly on `main`, and do not mix two
plans on one branch.

Do **not** `git commit`, `git push`, or `git merge` unless the owner explicitly tells
you to in that moment. Completing, building, verifying, or being asked to "build it" /
"add it" is **not** authorization to commit, push, or merge - make the changes and
stop, leaving them on the plan's branch for the owner to review. Treat "commit",
"push", and "merge" as required, in-the-moment instructions; never infer them from the
task. (Creating the plan's branch off `main` is part of starting implementation; the
consequential steps - pushing and merging into `main` - still wait for the owner.)

## Local models: LM Studio directly via pi-ai - never emberlm

This project talks to **LM Studio directly**. The host streams completions through
**pi-ai** against LM Studio's OpenAI-compatible API (`LMSTUDIO_URL`), and manages
model load state with **LM Studio's own tooling** (its REST API and the `lms` CLI).

**Do NOT use emberlm (or any other model control plane) for this project, ever.**
Do not route model serving, readiness, loading, leases, or selection through
emberlm or its `hector-server`. emberlm is a separate machine-level tool; it is
not a dependency of Trevor V2 and must not become one. Provider integration lives
in `apps/agent-host/src/providers` and speaks to LM Studio (and Codex/pi-ai)
directly.

## Local storage taxonomy

Before adding any file-backed feature, reuse the existing storage roots. Do not
invent a new dot-directory, cache root, or home-relative path unless the plan
explicitly adds a new root.

- **User settings and durable Trevor state** live under `TREVOR_HOME`, defaulting
  to `~/.trevorV2`. This includes user-global `AGENTS.md`, project/session
  mappings, host ownership records, locks, managed worktrees, launcher logs,
  the session-store SQLite database, blob-store bytes, and product state that
  must survive restarts. The single code owner for the env override and default
  directory name is the node-only `@trevor/session/node-paths` subpath; Node
  packages should import `TREVOR_HOME` or `resolveTrevorHome` from there instead
  of spelling `~/.trevorV2` themselves.
- **Debug metrics, traces, and generated diagnostic artifacts** live under
  `${XDG_STATE_HOME:-~/.local/state}/trevorV2`. This is for append-only JSONL,
  performance snapshots, provider/turn diagnostics that are not user settings,
  and other stateful debug output. Keep writes best-effort and never let debug
  metric failures affect a user turn.
- **Legacy shared service data** may still exist under `~/.trevor` from older
  V2 runs or V1-era local tooling. Do not add new features or active V2 writes
  there; only touch it when maintaining or migrating old data.
- **Temporary scratch** belongs in the OS temp directory (`tmpdir()`), for tests,
  transcodes, and short-lived intermediate files that can disappear at any time.
- **Browser-only ephemeral UI state** belongs in browser storage, currently
  `sessionStorage` for tab-scoped composer drafts and prompt history. Do not put
  browser drafts in the durable session log or host filesystem.
- **External shared roots** are not Trevor storage: `~/.pi/auth.json` is the
  pi-ai credential store, and `~/.agents` holds shared agents/skills. Trevor may
  read them when integrating with those tools, but new Trevor-owned data should
  not be written there.

## Testing

Tests are organized by **scope, not by one global placement rule**. "Where does
a test go" has four answers, decided by what the test exercises. Get the scope
right and placement follows; do **not** default everything to "next to the
source" or "in one `tests/` folder."

**Placement by scope:**

- **Unit** - one pure module in isolation (the folds: `recovery`, `transcript`,
  `send-queue`, `log`, `store`, `protocol`). **Co-located** as `foo.test.ts`
  beside `foo.ts`; it moves, renames, and is deleted with the code. This is the
  default and the only tier that lives in `src/`.
- **Integration** - several modules of one package against a real local
  dependency (session-store over a real socket + temp SQLite; blob-store on an
  ephemeral port; the host turn pipeline with a fake provider). Lives in that
  package's `test/` dir, e.g. `apps/session-store/test/`.
- **Conformance / contract** - an interface every implementation must satisfy.
  Authored **with the contract owner** and parameterized over implementations:
  the transport contract lives in `packages/session/test/` and runs against both
  `session-store` and Richter. A contract suite never lives inside one
  implementor.
- **End-to-end / smoke** - boots multiple services and drives the whole system.
  Lives in the top-level **`e2e/`** workspace, never in a leaf package, because
  it owns multi-service lifecycle (ports, boot, teardown) and depends on
  everything.

Shared harness lives in two homes, split by typing: the generic pieces -
ephemeral-port service boot/teardown, temp dirs, a transport client,
`waitFor`/`subscribe` - in **`packages/test-kit`**, imported by every tier; the
host-typed pieces - the deterministic **fake provider** and the turn driver -
under **`apps/agent-host/test/support`**, re-exported via
`@trevor/agent-host/testing` for the e2e workspace. Never copy-pasted.

**The decision rule (use this to avoid drift):** lift a test out of `src/` only
when it **owns lifecycle** (boots a service, binds a port, writes a real DB) or
**spans packages**. Otherwise co-locate it. Clutter from co-located unit files
is solved by editor file-nesting and `tsconfig` build excludes, not by a
parallel `tests/` tree.

**Runner: Vitest with projects.** One runner owns every tier as a project
(`unit` | `integration` | `web` | `e2e`), each with its own environment,
timeout, and gating. `node:test` and the hand-run `scripts/verify-*` regime are retired -
there is **one test system**, runnable via `pnpm test` and selectable by
project. Do **not** add new `verify-*` scripts; fold existing ones into the tier
they belong to.

**Per-app environment:**

- **`apps/agent-host`** (Effect) - use **`@effect/vitest`**. Drive time-injected
  machines (`src/lease.ts`, the turn scheduler) with **`TestClock`** instead of
  real waits; provide the `Emit` service via a collecting test `Layer`; the
  deterministic **fake provider** stands in for a model in the turn pipeline.
- **`apps/web`** (React) - component and hook tests run in the **`web`** project
  under **jsdom + Testing Library** (`render` for components, `renderHook` for
  hooks); the file suffix is `*.test.tsx` (the node-env `unit` project only globs
  `*.test.ts`, so they never overlap). Storybook stays the visual catalog, not a
  substitute for behavioral tests. A full-browser Playwright pass against the
  running app is a future option, not yet set up.

**E2E lanes** (in `e2e/`), so the suite stays deterministic and CI-able:

- **Hermetic** - boots store + blob + host on ephemeral ports with the fake
  provider. Default, deterministic, runs in CI.
- **Live model** - exercises real providers (LM Studio via `LMSTUDIO_URL`, cloud
  via `~/.pi/auth.json`). **Gated**: when a prerequisite is absent the test
  **skips with a stated reason** - it never silently passes and never fails the
  run.

(Browser/DOM behavior is covered by the `web` jsdom project above, not an e2e
lane; a full-browser Playwright pass would be a future addition here.)

**Gating:** unit + integration + web green, plus the hermetic e2e lane, is the
bar for a change being done. Pre-commit runs Biome + typecheck + the fast `unit`
project (`lefthook.yml`); CI (`.github/workflows/ci.yml`) runs lint, typecheck,
and all test projects; the live-model lane runs on demand / nightly, never on
every commit.

**Status:** in place. The Vitest projects, `packages/test-kit`, the relocated
and parameterized conformance suite, and the `e2e/` workspace are stood up, and
the `scripts/verify-*` regime has been folded into the tiers and removed. Build
new tests into this structure; do not reintroduce the old regime.

## The plan is canonical

The **single canonical plan** is
[`.plans/trevor-v2/implementation.md`](./.plans/trevor-v2/implementation.md),
with decisions recorded in `.plans/trevor-v2/plan.db` (D-001 to D-039). It is the
one source of truth: architecture, the domain vocabulary, the DROP list, the
done/remaining re-baseline, the sequenced roadmap, and the kept (unsequenced)
backlog all live there. When the plan and any other document disagree, **the plan
wins.**

The former `FEATURES.md`, `TABLED.md`, and the separate
`graceful-overflow-recovery` plan have been **merged into this plan and deleted**
(2026-06-23, D-031):

- The host feature inventory and its triage (old `FEATURES.md` section 4) is now
  the plan's **kept backlog** (section 7), pruned to what V2 actually wants, with
  H-IDs preserved for V1 provenance. A feature's presence in the backlog does
  **not** authorize building it now - the roadmap (section 6) decides sequencing,
  and backlog items are built only when explicitly picked up.
- The cross-cutting **domain vocabulary** (old `FEATURES.md` section 2) is the
  plan's section 3.
- The **DROP list** (old `FEATURES.md` section 3 plus the sole `TABLED.md` entry)
  is the plan's section 4. Model-led routing classification (old T-1) is no longer
  "tabled" - it is **dropped for good**, with the entire routing engine.
- Graceful context-overflow recovery is the plan's next sequenced feature
  (D-034 to D-038).

Before building or proposing anything, consult the plan: section 4 (dropped for
good?), section 7 (deferred backlog, not authorized now?), then section 6 (is it
sequenced?). Do not pull backlog or dropped work forward on your own initiative.
