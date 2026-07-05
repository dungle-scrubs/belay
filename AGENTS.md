# Trevor V2 - Agent Instructions

Trevor V2 is a pnpm monorepo. The frontend is `apps/web` (React 19 + Vite +
Effect); the host is `apps/agent-host` (Node + Effect). Both are Tether
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

**Plan documents belong on `main`.** A plan's docs under `.plans/<NN>-<name>/` (and the shared
vocabulary in `CONTEXT.md`) are the shared backlog and are committed to `main`, not carried on a
feature branch. A plan's **implementation** (the source changes) is done on **its own branch off
`main`**, named for the plan (e.g. `feat/<plan-name>`); do not implement a plan directly on `main`,
and do not mix two plans on one branch. When the plan is **complete**, **delete its plan directory**
(`.plans/<NN-plan-name>/`) and **merge the branch into `main`**.

**Prune a merged branch immediately - locally AND on the remote.** Once a branch is merged into
`main`, its commits live in `main`, so the branch ref is dead weight: delete it locally
(`git branch -d <branch>`) and on origin (`git push origin --delete <branch>`), then
`git remote prune origin` to drop stale tracking refs. **Only `main` should ever persist** - no merged
`feat/*` branch lingers locally or on origin. This branch cleanup (deleting a ref whose commits are
already in `main`) is part of completing the merge, not a separate content push; it does not need a
second go-ahead once the merge itself is authorized.

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

## Filename policy

Use kebab-case for repo-owned source, test, story, script, and support
filenames. Keep exported TypeScript symbols and React component names in their
normal casing, e.g. `PanelHost` may live in `panel-host.tsx`; do not create
PascalCase component filenames.

Conventional documentation filenames are explicit exceptions: `AGENTS.md`,
`CLAUDE.md`, `README.md`, `CHANGELOG.md`, `HOTKEYS.md`, `CONTEXT.md`,
`FEATURES.md`, `SECURITY_RISKS.md`, and skill `SKILL.md` files. Generated
artifacts may be excluded only through the filename policy checker's explicit
allowlist.

## Local storage taxonomy

Before adding any file-backed feature, reuse the existing storage roots. Do not
invent a new dot-directory, cache root, or home-relative path unless the plan
explicitly adds a new root.

- **User settings and editable config** live under `TREVOR_HOME`, defaulting to
  `~/.trevorV2`. This is hand-editable, portable configuration only - the
  user-global `AGENTS.md` and `config.jsonc`, plus small per-concern preference
  files like `style.json` (`{ activeStyle }`) and `vim.json`
  (`{ "enabled": true }` opts the prompt composer into Vim motions; disabled by
  default) - not runtime state. The single code owner for the env override and
  default directory name is the node-only `@trevor/session/node-paths` subpath;
  Node packages should import `TREVOR_HOME` or `resolveTrevorHome` from there
  instead of spelling `~/.trevorV2` themselves.
- **All machine-local runtime state** lives under `TREVOR_STATE_HOME`, defaulting
  to `${XDG_STATE_HOME:-~/.local/state}/trevorV2`. This is everything the app owns
  at runtime: the session-store SQLite database, blob-store bytes, managed
  worktrees, the host/lock/project registries (`hosts.json`, `locks/`,
  `projects.json`), launcher logs, provider observations, and best-effort debug
  metrics/traces/diagnostics (append-only JSONL, performance snapshots). It is
  kept out of the config dir so a config backup or sync never drags the session
  history along. Import `TREVOR_STATE_HOME` or `resolveTrevorStateHome` from
  `@trevor/session/node-paths`. Keep debug-metric writes best-effort and never let
  a diagnostics failure affect a user turn.
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

A new file-backed feature must resolve its location through the root policy in
`@trevor/session/node-paths` (`resolveRootPolicy` / `rootCategory` / the
`STORAGE_INVENTORY`) and add itself to the inventory, rather than spelling a
home-relative path. A drift test fails if a new `~/.trevorV2` literal appears
outside that owner. This taxonomy is the single citation for storage placement;
see `.plans/03-filesystem-root-taxonomy` for the detailed model and rationale.

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
  `session-store` and Tether. A contract suite never lives inside one
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

## Plans are canonical, and numbered

Work is organized as **numbered plans** under `.plans/<NN>-<name>/`, each a self-contained plan-db
(`plan.db` + `implementation.md` + `progress-report.md` + `artifacts/`). There is **no single umbrella
plan**: the former canonical `.plans/trevor-v2/implementation.md` is **retired** in favor of the
numbered plans. Its cross-cutting **domain vocabulary** now lives in the repo-root
[`CONTEXT.md`](./CONTEXT.md); record new shared terms there.

The umbrella's permanent decisions still hold even though the document is gone - in particular the
**DROP list** (multi-user/collaboration incl. "teams", the routing engine, model-led routing
classification, inline self-validation, native extension dispatch, ...) is still cut for good. A
plan's presence under `.plans/` does **not** by itself authorize building it - it is built only when
explicitly picked up.

When a plan and any other document disagree, **the plan wins**; when a plan and `CONTEXT.md` disagree
on a term, fix one so they agree.

## Remote host restart over SSH: inject the opchain token, never the keychain

`trevor` spawns each agent-host through opchain
(`opchain primary --read op run --env-file=<TREVOR_HOME>/.env.op -- tsx agent-host`), which
resolves its 1Password **service-account token** from the macOS **login keychain**. That
keychain is unlocked only by an interactive **GUI login** and is **not reachable from an SSH
session**: macOS scopes keychain access to the console session, so an SSH-spawned opchain gets
`errSecInteractionNotAllowed` (opchain exit 44) and the host dies on startup - even when a GUI
session (Screen Sharing / JumpDesktop) has the same keychain unlocked. So a plain
`ssh <host> 'trevor open <session>'` **cannot** start a host; only a command run inside the GUI
session can rely on the keychain.

**To restart a host on a remote machine over SSH, inject the token instead of relying on the
remote keychain.** `buildHostSpawnCommand` (`apps/trevor-cli/src/platform.ts`) passes opchain
`--allow-env-token` **only when `OPCHAIN_TOKEN_OVERRIDE` is set** - gated, so GUI launches stay
byte-identical and the keychain path is unchanged. With the override present, opchain uses the
env token and never touches the keychain. Then:

1. Fetch the `primary-read` service-account token **silently** from a machine that already has
   it in its keychain (opchain reads it via `security`, no Touch ID / no 1Password-app prompt -
   do **not** use `op item get`, which triggers biometric):

       opchain primary --read op run -- sh -c 'printf %s "$OP_SERVICE_ACCOUNT_TOKEN"'

2. Pipe it over SSH **stdin** (so it never appears in argv / `ps` or on the remote disk) and
   hand it to `trevor open`:

       opchain primary --read op run -- sh -c 'printf %s "$OP_SERVICE_ACCOUNT_TOKEN"' \
         | ssh <user>@<host> 'bash -lc '\''IFS= read -r T; cd ~/dev/trevorV2 \
             && trevor stop <session> >/dev/null 2>&1; sleep 1 \
             && OPCHAIN_TOKEN_OVERRIDE="$T" trevor open <session>'\'''

The token is a scoped, revocable **read-only** service account; it only transits the encrypted
SSH channel at restart time and is never persisted on the remote host. For a restart from a GUI
session (Screen Sharing / JumpDesktop), skip all of this - `trevor open <session>` reads the
keychain directly with no biometric.
