# Trevor Open-Source Launch Readiness - Implementation Plan

> **Status: SCAFFOLD.** This plan captures the five launch-readiness workstreams and their decided
> shape from the productization brainstorm. Milestones are at a coarse grain and several backend/scope
> choices are deliberately left open (flagged `OPEN`). Flesh out each phase before implementing.

Prepare the codebase to be released as an open-source product. Five independent workstreams remove the
blockers that would bite a first public release: the `tool_script` sandbox is macOS-only, the repo
carries owner-specific private workflow, configuration is a scatter of ~25 env vars with no file, the
"Trevor" identity needs public polish, and launch security/dependency checks are not yet repeatable.
This plan is **business-model-agnostic** - every workstream is a
prerequisite whether the project ships fully-open or open-core, so no licensing choice is baked in.
<!-- D-001 -->

## 0. Hard Dependencies

- [x] **Former `.plans/56-rename-to-trevor` dependency completed (WS4).** The structural V2-to-Trevor
  rename landed and the completed plan directory was deleted. WS4 therefore no longer waits on plan 56
  and only keeps the public identity/tagline/trademark work plus a regression guard for old name markers.
  <!-- D-009 -->
- [ ] **`.plans/28-headless-cli-sdk-harness` (hard dependency, WS3).** `trevor init` and `trevor doctor`
  are CLI verbs; they need the `apps/trevor-cli` executable + arg-parsing surface plan 28 introduces.
  <!-- D-007 -->
- [ ] **`.plans/41-doctor-health-surface` (hard dependency, WS3).** The config-validation surface is a
  new `/doctor` area; it builds on 41's health-surface + storage/config checks. <!-- D-007 -->
- [ ] **`.plans/21-workflows-runtime` (coordination, WS1).** 21's M9 extracts a shared `sandbox-runner`
  from plan 16. WS1 adds a second OS backend to that same layer - whichever lands first, the other
  accommodates. Prefer building WS1's backend on 21's extracted runner if it lands first. <!-- D-007 -->
- [x] Shipped sandbox seam WS1 extends (plan 16, complete): `packages/session/src/tool-script-sandbox.ts`
  (`SandboxMode = "sandbox-exec" | "safehouse" | "child-process" | "none"`, `selectSandboxMode`,
  `SandboxEnvironment`, `fallbackSandboxMode`), `apps/agent-host/src/tool-script/sandbox-profile.ts`
  (`buildDenyFirstProfile`, `sandboxExecCommand`, `probeSandboxEnvironment`), `.../launch.ts`
  (`resolveRunnerLaunch`, fail-closed + `TREVOR_TOOL_SCRIPT_ALLOW_UNSANDBOXED`), `.../spawn.ts`.
- [x] Shipped AGENTS/CLAUDE handling WS2 edits (plan 26, complete): the `/init` AGENTS.md generator
  (`apps/agent-host/src/project-context/init-agents.ts`), CLAUDE.md migration-only merge, `.trevor/rules`.
- [x] Shipped config substrate WS3 consolidates onto: `packages/session/src/ports.ts` (`RESERVED_PORTS`,
  `serviceUrl`), `packages/session/src/node-paths.ts` (`TREVOR_HOME` default `~/.trevor`,
  `TREVOR_STATE_HOME`; `config.jsonc` already *reserved in docstrings* with no loader),
  `apps/agent-host/src/boot/config.ts` (from plan 22.1).
- [x] Shipped naming surfaces WS4 touches: `TREVOR_*` env prefix, `@trevor/*` package scope,
  `apps/trevor-cli`, `.trevor/` paths - all kept; only the public *identity* changes. <!-- D-005 -->

**Downstream plans:** none. Plan 49 is a capstone with only upstream dependencies; the former rename
dependency is complete and no longer counts as current cutoff work. <!-- D-006 --> <!-- D-009 -->

**Non-goals (out of scope, deferred):** the licensing choice (fully-open vs open-core) and any
business-model / hosted-substrate work. A LICENSE file + headers are separate governance work to add once
that decision is made; they are intentionally excluded here so the readiness work does not wait on it.
<!-- D-001 -->

## 1. Architecture

Five independent workstreams, each rooted in an existing seam so the work is extension, not rewrite:

- **WS1 - Cross-platform sandbox.** Today `tool_script` runs under macOS `sandbox-exec` only; on Linux
  `selectSandboxMode` returns `child-process` and `resolveRunnerLaunch` **fails closed** (refuses unless
  `TREVOR_TOOL_SCRIPT_ALLOW_UNSANDBOXED=1`). The `SandboxMode` enum already reserves a preferred
  `"safehouse"` mode with no implementation. WS1 makes the seam produce a real OS sandbox on Linux. The
  concrete backend (finish Agent Safehouse vs add a bubblewrap/landlock/nsjail mode) is **OPEN** and
  deferred; the near-term, backend-independent work is: extend `SandboxEnvironment` with the Linux fact,
  keep the fail-closed contract explicit, and surface the active sandbox + policy hash in `/doctor`.
  <!-- D-002 -->
- **WS2 - De-personalization via public/private split.** A clean **public** repo carries code + neutral
  docs; a **private** repo/overlay retains `.plans/` (2.9 MB, 21 committed `plan.db`), the owner-specific
  `AGENTS.md` workflow, and the `opchain`-wrapped host-spawn in `apps/trevor-cli/src/platform.ts`. The
  boundary is enforced by a **public-surface guard** (extend the existing `packages/repo-policy`) that
  fails CI if a disallowed private artifact or string is present in the public tree. <!-- D-003 -->
- **WS3 - Config consolidation.** Implement the already-reserved `${TREVOR_HOME}/config.jsonc` loader;
  env vars override the file (file provides defaults, env wins). `trevor init` scaffolds the file from
  the existing `/init` evidence primitive; a new `/doctor` **Config** area validates it. Scattered
  `TREVOR_*` / provider-key reads migrate to reading the resolved config. <!-- D-004 -->
- **WS4 - Naming/branding.** The structural V2-to-Trevor rename has already landed. WS4's remaining
  scope is the PUBLIC product identity only: README/package-description/tagline polish, a regression
  guard for old name markers, and **trademarking** "Trevor". No further dir/path work - `TREVOR_*`,
  `@trevor/*`, `.trevor/` stay. <!-- D-005 --> <!-- D-009 -->
- **WS5 - Security/dependency launch gates.** A public export cannot be cut from informal checks. WS5
  adds repeatable release blockers: verified TruffleHog history scan, sensitive-file/current-code scan,
  local pre-push TruffleHog hook, dependency vulnerability audit, dependency-upgrade analysis, and
  Dependabot coverage. Current baseline: `trufflehog git file://. --only-verified --no-update` was clean
  on 2026-07-05; `pnpm audit --audit-level high` fails on Playwright advisory
  `GHSA-7mvr-c777-76hp` until Playwright is patched to `>=1.55.1` across the root/browser/Storybook paths.
  <!-- D-010 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Sandbox is blast-radius reduction, not the authoritative control (the host bridge is) <!-- D-002 --> | WS1 can ship the Linux seam + fail-closed default before a perfect backend; the bridge already enforces perms. |
| WS3 depends on plans 28 + 41 (numbered before 49) | Ordering already satisfies this - 49 is the capstone; do not start WS3 before 28/41 land. |
| Public/private split, not destructive scrub <!-- D-003 --> | Owner keeps full plan history + private workflow; the guard, not deletion, defines the public surface. |
| No mass rename <!-- D-005 --> | WS4 is bounded to public-facing identity; internal `TREVOR_*`/`@trevor/*` identifiers are untouched. |
| Launch security fails closed <!-- D-010 --> | Any high/critical dependency vulnerability, confirmed secret, missing local secret scan, or missing dependency-update coverage blocks public release until patched or explicitly accepted. |

### Boundaries

WS1 lives in `apps/agent-host/src/tool-script/` + `packages/session/src/tool-script-sandbox.ts`. WS2 is
repo-structure + `packages/repo-policy`. WS3 is `packages/session` (config loader) + `apps/trevor-cli`
(verbs) + `apps/agent-host/src/doctor` (validation area). WS4 is docs + public identifiers only. WS5 is
release/readiness automation: `packages/repo-policy`, `lefthook.yml`, dependency manifests, and
`.github/dependabot.yml`. The five workstreams do not share code; they can be implemented in any order
except WS3-after-28/41.

### Observability

WS1 surfaces the selected sandbox mode + policy hash in the `/doctor` Tools area (already partly there).
WS3 adds a `/doctor` **Config** area reporting the resolved config source (file vs env vs default) per
key and any validation findings with `nextAction` remediation.

---

## Phases

> Each phase is one workstream; they are independent (except WS3's upstream deps). Milestones are coarse
> scaffolding - refine into finer RED/GREEN batches when fleshing out.

### Phase WS1: Cross-platform sandbox

**Goal:** `tool_script` produces a real OS sandbox on Linux, or fails closed loudly - the safety story is
no longer macOS-only.

#### M1: Linux environment fact + explicit fail-closed contract

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Test `selectSandboxMode` for a Linux `SandboxEnvironment` - assert it does not silently pick an
     unsandboxed run, and `resolveRunnerLaunch` refuses without the explicit opt-in.
  2. GREEN: Extend `SandboxEnvironment` with the Linux sandbox-availability fact; keep the fail-closed
     branch and the `TREVOR_TOOL_SCRIPT_ALLOW_UNSANDBOXED` escape explicit and tested.
  3. REFACTOR: Consolidate the mode-selection matrix (darwin/linux/other) into one documented table.

#### M2: `/doctor` sandbox visibility

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Test the `/doctor` Tools area reports the active sandbox mode + policy hash on a Linux env fact.
  2. GREEN: Surface mode + `sandboxPolicyHash` (and "no OS sandbox - refusing/opt-in" state) in `/doctor`.

#### M3 (OPEN - backend deferred): Real Linux sandbox backend

- **Dependencies:** M1; coordinate with plan 21 M9 shared `sandbox-runner`
- **Effort:** OPEN (L-XL)
- **Decision to resolve first:** finish the reserved `"safehouse"` (Agent Safehouse) mode, or add a new
  `bubblewrap`/`landlock` mode. <!-- D-002 -->
- **Tasks (sketch, pending the decision):**
  1. RED: Test the chosen backend is detected + selected on Linux and denies network egress + out-of-root
     filesystem access (mirrors the macOS `sandbox-profile` contract).
  2. GREEN: Implement the backend profile builder + launch wiring alongside `sandbox-profile.ts`.
  3. REFACTOR: Factor the shared deny-first contract so macOS and Linux backends share one policy source.

### Phase WS2: De-personalization (public/private split)

**Goal:** a public tree that provably contains no owner-specific private artifact, enforced by a guard.

#### M1: Public-surface guard

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add a failing `repo-policy` check that flags disallowed private artifacts/strings in the public
     surface - `.plans/`, owner `AGENTS.md` workflow, `opchain`/`emberlm`/`~/.agents` coupling, `dungle-scrubs`,
     "PRIVATE - never make public".
  2. GREEN: Implement the guard (allowlist/denylist of paths + string patterns) as a `repo-policy` command.
  3. REFACTOR: Wire the guard into the existing lint/CI lane so a private leak fails the build.

#### M2: Neutralize the retained code coupling

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Test the host-spawn path works without `opchain` - a plain env/secret provider satisfies it
     (`apps/trevor-cli/src/platform.ts` `buildHostSpawnCommand`).
  2. GREEN: Make secret injection pluggable; default to plain env, `opchain` as an opt-in private adapter.
  3. GREEN: Replace `opchain`/owner-specific example fixtures (session names, story data) with neutral ones.
  4. REFACTOR: Move `.plans/` + the owner `AGENTS.md` workflow to the private overlay; leave a neutral
     public `AGENTS.md`/README. (Structural move - guarded by M1.)

### Phase WS3: Config consolidation

**Goal:** one `config.jsonc` is the source of configuration; env vars override it; `trevor init`/`doctor`
scaffold and validate it.

#### M1: `config.jsonc` loader (file + env-override precedence)

- **Dependencies:** none (loader is standalone); real CLI/doctor wiring needs 28/41
- **Effort:** M
- **Tasks:**
  1. RED: Test the loader reads `${TREVOR_HOME}/config.jsonc`, applies defaults, and lets a matching env
     var override a file value.
  2. GREEN: Implement the loader in `packages/session` over the reserved path; typed schema + validation.
  3. REFACTOR: Migrate the scattered `TREVOR_*` / provider-key reads to consume the resolved config.

#### M2: `trevor init` scaffolds the config

- **Dependencies:** M1, plan 28
- **Effort:** S
- **Tasks:**
  1. RED: Test `trevor init` writes a valid starter `config.jsonc` (reusing the `/init` evidence primitive).
  2. GREEN: Add the `init` verb to `apps/trevor-cli` producing the file (review-before-write, like `/init`).

#### M3: `/doctor` Config area

- **Dependencies:** M1, plan 41
- **Effort:** S
- **Tasks:**
  1. RED: Test a `/doctor` Config area reports per-key source (file/env/default) and flags invalid values
     with a `nextAction`.
  2. GREEN: Add the Config area to the doctor snapshot + web renderer.

### Phase WS4: Naming / branding

**Goal:** the public identity is "Trevor" (no "V2"), trademark-cleared; internal identifiers unchanged.

#### M1: Public-identity consistency + guard

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add a check that no old V2-era name markers leak into public-facing identity (README, package
     `description`, app `<title>`, public docs).
  2. GREEN: Set the public identity to "Trevor"; drop old V2-era markers from public-facing strings
     (README, package `description`, app `<title>`, public docs). The config dir is already `~/.trevor`,
     so no back-compat shim is in scope. <!-- D-009 -->
  3. REFACTOR: One neutral public tagline/description shared across README + package metadata.

#### M2 (OPEN - external): Trademark clearance

- **Dependencies:** none
- **Effort:** OPEN
- **Task:** Trademark search + filing for "Trevor" in the relevant class. Non-code; tracked here so it is
  not forgotten before public launch. <!-- D-005 -->

### Phase WS5: Security / Dependency Launch Gates

**Goal:** every public export is gated by repeatable security and dependency checks; the current
Playwright audit finding is explicit release-blocking work. <!-- D-010 -->

#### M1: Secret-history and local secret-scan gate

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add a `repo-policy` readiness test that fails when the local pre-push TruffleHog hook is missing
     or a public export contains sensitive files such as real `.env`, `*.pem`, `*.key`, or credentials JSON.
  2. GREEN: Add the local pre-push hook through `lefthook.yml` (or a repo-owned equivalent) to run
     `trufflehog git file://. --only-verified --no-update` before push.
  3. REFACTOR: Document the launch-time secret scan result in the readiness output without putting secret
     scanning in GitHub Actions.

#### M2: Dependency vulnerability and update gate

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add a launch-readiness check that treats `pnpm audit --audit-level high` failure as a release
     blocker and reports the vulnerable dependency path.
  2. GREEN: Patch the current Playwright advisory (`GHSA-7mvr-c777-76hp`) by moving all Playwright paths to
     a patched version (`>=1.55.1`) or by upgrading/transitively overriding the Storybook runner path if
     needed.
  3. REFACTOR: Add weekly Dependabot coverage for GitHub Actions and the npm/pnpm workspace, plus a
     dependency-upgrade analysis step that separates safe patch/minor updates from major migrations.

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| WS1 backend choice churns (Safehouse vs bwrap) | medium | medium | Ship M1/M2 (seam + fail-closed + doctor) first; M3 backend deferred behind an explicit decision | owner |
| Private artifact leaks into the public repo | high | medium | WS2 M1 guard fails CI on any disallowed path/string before release | owner |
| WS3 blocked waiting on 28/41 | low | low | Numbering already orders 28/41 before 49; loader (M1) is standalone and can land early | owner |
| "Trevor" trademark unavailable | medium | low | WS4 M2 clearance early; a fallback name is a later decision, not a blocker to the readiness code | owner |
| Dependency or secret finding blocks launch late | high | medium | WS5 makes scans repeatable before export; high/critical audit findings and verified secrets block release | owner |

---

## Open Questions (resolve during flesh-out)

1. WS1 M3: Agent Safehouse vs bubblewrap/landlock - what is Agent Safehouse, and is it cross-platform? <!-- D-002 -->
2. WS2: exact mechanism of the public/private split - two git repos, a `git filter-repo` publish job, or a
   private overlay dir gitignored from the public remote? <!-- D-003 -->
3. WS3: `config.jsonc` schema shape and which env vars are file-configurable vs runtime-only.
4. Licensing (deferred, out of scope): fully-open vs open-core - determines the fifth LICENSE item. <!-- D-001 -->

---

## Decisions

Canonical decisions are in `.plans/49-open-source-launch-readiness/plan.db`. Key decisions use
`<!-- D-NNN -->` markers above: D-001 (scope/framing + non-goals), D-002 (WS1 sandbox), D-003 (WS2 split),
D-004 (WS3 config), D-005 (WS4 naming), D-006 (numbering/terminal, historical), D-007 (hard deps),
D-008 (former rename dependency, historical), D-009 (rename dependency complete), D-010
(security/dependency launch gates).
