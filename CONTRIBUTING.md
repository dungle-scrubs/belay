# Contributing to Belay

Thanks for your interest in Belay. This guide covers the setup, the checks that
must pass, and the commit conventions the release automation depends on.

## Prerequisites

- **Node.js 22 or newer.** CI runs Node 24, because `node:sqlite` (used by the
  session store's log) is stable there. Match it locally if you can.
- **pnpm 11.5.2**, pinned via the `packageManager` field. Run `corepack enable`
  and pnpm will select the right version automatically.

## Setup

```bash
pnpm install
```

This also installs the [lefthook](https://github.com/evilmartians/lefthook)
pre-commit hooks via the `prepare` script.

## Running the app

```bash
pnpm dev        # session store, blob store, agent host, and web UI together
pnpm dev:web    # web UI only
pnpm belay      # the CLI
```

## Checks

Every one of these runs in CI, so run them before opening a pull request.

```bash
pnpm lint             # Biome, plus the repo filename and residual-name policies
pnpm format           # Biome autofix
pnpm -r typecheck     # TypeScript across every workspace package
pnpm test             # the full Vitest suite
```

The suite is split into lanes you can run individually:

| Command | Covers |
|---------|--------|
| `pnpm test:unit` | Pure unit tests |
| `pnpm test:integration` | Cross-module integration |
| `pnpm test:web` | `apps/web` component tests (jsdom) |
| `pnpm test:e2e` | Hermetic end-to-end |
| `pnpm test:e2e:browser` | Real-browser transcript behavior |
| `pnpm test-storybook` | Storybook visual regression |

The browser lanes are **local-only and never run in CI**. They execute inside the
pinned `mcr.microsoft.com/playwright:v1.62.1-noble` container via
`tests/browser/check-storybook-baselines.sh`, which requires Docker.

That image is multi-arch, so it resolves to arm64 on Apple Silicon and amd64 on
an x86 machine, and font rasterization differs between the two. Committed
baselines are therefore only comparable on the architecture that produced them -
which is why the lane does not run on a cloud runner. Regenerate baselines with
`tests/browser/update-storybook-baselines.sh` and review the diff before
committing.

## Repository policies

`pnpm lint` enforces two project-specific rules beyond Biome:

- **Filenames are kebab-case.** All repo-owned files.
- **No residual pre-rename naming.** Docs and Claude skill files must use the
  Belay name. Genuine history (`trevor_legacy` paths, prose about the retired
  project) is allowed; new uses of the old name are not.

## Commit messages

Belay uses [Conventional Commits](https://www.conventionalcommits.org/). The
release automation reads these prefixes to decide version bumps and to build the
changelog, so the prefix matters:

| Prefix | Changelog section | Version effect (pre-1.0) |
|--------|-------------------|--------------------------|
| `feat:` | Added | patch |
| `fix:` | Fixed | patch |
| `perf:`, `refactor:`, `deps:`, `docs:`, `chore:`, `ci:`, `test:` | Changed | patch |
| any type with `!` or a `BREAKING CHANGE:` footer | - | minor |

While Belay is pre-1.0, breaking changes bump the minor version and features
bump the patch version, keeping version churn low during rapid development.

Scope the subject where it helps, and keep it lowercase with no trailing period:

```
feat(web): add transcript jump-to-latest affordance
fix(agent-host): stop dropping host-injected control prompts
```

## Pull requests

Branch off `main`, keep one logical change per branch, and make sure `pnpm lint`,
`pnpm -r typecheck`, and `pnpm test` all pass. Fill in the pull request template
so reviewers know what changed and how it was verified.

## Releases

Releases are automated with
[release-please](https://github.com/googleapis/release-please). Merging to `main`
opens or updates a release pull request that accumulates the changelog; merging
that pull request tags the version and publishes the GitHub release. Do not edit
`CHANGELOG.md` version sections by hand.
