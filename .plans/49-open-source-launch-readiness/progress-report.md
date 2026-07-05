# Trevor Open-Source Launch Readiness - Progress Report

> **SCAFFOLD.** Milestones are coarse and two backend/external items are deferred. Refine each phase into
> finer RED/GREEN batches before implementing. Nothing is built yet.

## Summary

- **Current cutoff blockers:** 31
- **Completed current work:** 0
- **Accepted/deferred follow-up:** 4
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** Flesh out phases, then WS5 M2 - Dependency vulnerability and update gate

## Completed Current State / Hard Dependencies

- [x] Sandbox seam WS1 extends (plan 16): `packages/session/src/tool-script-sandbox.ts` (`SandboxMode`, `selectSandboxMode`, `SandboxEnvironment`, `fallbackSandboxMode`), `apps/agent-host/src/tool-script/{sandbox-profile,launch,spawn}.ts` (fail-closed + `TREVOR_TOOL_SCRIPT_ALLOW_UNSANDBOXED`).
- [x] AGENTS/CLAUDE handling WS2 edits (plan 26): `apps/agent-host/src/project-context/init-agents.ts` (`/init` generator), CLAUDE.md migration-only merge, `.trevor/rules`.
- [x] Config substrate WS3 consolidates onto: `packages/session/src/ports.ts`, `packages/session/src/node-paths.ts` (`TREVOR_HOME`, `config.jsonc` reserved with no loader), `apps/agent-host/src/boot/config.ts` (plan 22.1).
- [x] Naming surfaces WS4 keeps: `TREVOR_*` prefix, `@trevor/*` scope, `apps/trevor-cli`, `.trevor/` paths (only public identity changes).
- [x] Former plan 56 rename dependency completed: the structural V2-to-Trevor rename landed, the completed plan directory was deleted, and WS4 now keeps only public identity/tagline/trademark work plus an old-name regression guard. <!-- D-009 -->

## Current Cutoff Blockers

### Hard-dependency gates (external plans; must land before the dependent milestone)

- [ ] `.plans/28-headless-cli-sdk-harness` reaches implementing/complete (WS3 M2/M3 need the CLI surface).
- [ ] `.plans/41-doctor-health-surface` reaches implementing/complete (WS3 M3 config area builds on it).
- [ ] `.plans/21-workflows-runtime` M9 shared `sandbox-runner` coordinated with WS1 M3 (whichever lands first, the other accommodates).

### WS1 M1 - Linux environment fact + explicit fail-closed contract

- [ ] RED: Test `selectSandboxMode` on a Linux `SandboxEnvironment` never silently picks an unsandboxed run, and `resolveRunnerLaunch` refuses without the explicit opt-in.
- [ ] GREEN: Extend `SandboxEnvironment` with the Linux sandbox-availability fact; keep the fail-closed branch + `TREVOR_TOOL_SCRIPT_ALLOW_UNSANDBOXED` escape explicit and tested.
- [ ] REFACTOR: Consolidate the mode-selection matrix (darwin/linux/other) into one documented table.

### WS1 M2 - `/doctor` sandbox visibility

- [ ] RED: Test the `/doctor` Tools area reports the active sandbox mode + policy hash on a Linux env fact.
- [ ] GREEN: Surface mode + `sandboxPolicyHash` (and the "no OS sandbox - refusing/opt-in" state) in `/doctor`.

### WS2 M1 - Public-surface guard

- [ ] RED: Add a failing `repo-policy` check flagging disallowed private artifacts/strings in the public surface (`.plans/`, owner `AGENTS.md`, `opchain`/`emberlm`/`~/.agents`, `dungle-scrubs`, "PRIVATE - never make public").
- [ ] GREEN: Implement the guard (path + string allow/deny patterns) as a `repo-policy` command.
- [ ] REFACTOR: Wire the guard into the lint/CI lane so a private leak fails the build.

### WS2 M2 - Neutralize the retained code coupling

- [ ] RED: Test the host-spawn path works without `opchain` - a plain env/secret provider satisfies `buildHostSpawnCommand` (`apps/trevor-cli/src/platform.ts`).
- [ ] GREEN: Make secret injection pluggable; default to plain env, `opchain` an opt-in private adapter.
- [ ] GREEN: Replace `opchain`/owner-specific example fixtures (session names, story data) with neutral ones.
- [ ] REFACTOR: Move `.plans/` + owner `AGENTS.md` workflow to the private overlay; leave neutral public `AGENTS.md`/README (guarded by M1).

### WS3 M1 - `config.jsonc` loader (file + env-override precedence)

- [ ] RED: Test the loader reads `${TREVOR_HOME}/config.jsonc`, applies defaults, and lets a matching env var override a file value.
- [ ] GREEN: Implement the loader in `packages/session` over the reserved path; typed schema + validation.
- [ ] REFACTOR: Migrate the scattered `TREVOR_*` / provider-key reads to consume the resolved config.

### WS3 M2 - `trevor init` scaffolds the config

- [ ] RED: Test `trevor init` writes a valid starter `config.jsonc` (reusing the `/init` evidence primitive).
- [ ] GREEN: Add the `init` verb to `apps/trevor-cli` producing the file (review-before-write, like `/init`).

### WS3 M3 - `/doctor` Config area

- [ ] RED: Test a `/doctor` Config area reports per-key source (file/env/default) and flags invalid values with a `nextAction`.
- [ ] GREEN: Add the Config area to the doctor snapshot + web renderer.

### WS4 M1 - Public-identity consistency + guard

- [ ] RED: Add a check that no old V2-era name markers leak into public-facing identity (README, package `description`, app `<title>`, public docs).
- [ ] GREEN: Set the public identity to "Trevor"; drop old V2-era markers from public-facing strings (README, package `description`, app `<title>`, public docs); the config dir is already `~/.trevor`, so no back-compat shim is in scope. <!-- D-009 -->
- [ ] REFACTOR: One neutral public tagline/description shared across README + package metadata.

### WS5 M1 - Secret-history and local secret-scan gate

- [ ] RED: Add a `repo-policy` readiness test that fails when the local pre-push TruffleHog hook is missing or a public export contains sensitive files such as real `.env`, `*.pem`, `*.key`, or credentials JSON.
- [ ] GREEN: Add the local pre-push hook through `lefthook.yml` (or a repo-owned equivalent) to run `trufflehog git file://. --only-verified --no-update` before push.
- [ ] REFACTOR: Document the launch-time secret scan result in the readiness output without putting secret scanning in GitHub Actions.

### WS5 M2 - Dependency vulnerability and update gate

- [ ] RED: Add a launch-readiness check that treats `pnpm audit --audit-level high` failure as a release blocker and reports the vulnerable dependency path.
- [ ] GREEN: Patch the current Playwright advisory (`GHSA-7mvr-c777-76hp`) by moving all Playwright paths to a patched version (`>=1.55.1`) or by upgrading/transitively overriding the Storybook runner path if needed.
- [ ] REFACTOR: Add weekly Dependabot coverage for GitHub Actions and the npm/pnpm workspace, plus a dependency-upgrade analysis step that separates safe patch/minor updates from major migrations.

## Accepted / Deferred Follow-up

### WS1 M3 (OPEN - backend deferred behind a decision) - Real Linux sandbox backend

- [ ] RED: Test the chosen backend is detected + selected on Linux and denies network egress + out-of-root filesystem access.
- [ ] GREEN: Implement the backend profile builder + launch wiring alongside `sandbox-profile.ts`.
- [ ] REFACTOR: Factor the shared deny-first contract so macOS and Linux backends share one policy source.

### WS4 M2 (OPEN - external, non-code)

- [ ] Trademark search + filing for "Trevor" in the relevant class (before public launch).

### Non-goal (deferred, not counted)

- Licensing choice (fully-open vs open-core) and any hosted-substrate/business work; a LICENSE file + headers are separate governance work to add once that decision is made. <!-- D-001 -->
