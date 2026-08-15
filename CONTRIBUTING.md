# Contributing to Belay

Thanks for considering a contribution.

## Quick start

```bash
pnpm install --frozen-lockfile
pnpm lint        # Biome + filename policy
pnpm -r typecheck
pnpm test:unit
pnpm test:integration  # real SQLite + ephemeral ports
pnpm test:web
pnpm test:e2e          # hermetic (fake provider)
pnpm test:e2e:browser  # real browser, needs Playwright browsers
```

Pre-commit hooks run via `lefthook` (Biome, typecheck, filename policy, unit). Install with `lefthook install` (runs automatically via `prepare`).

## Commit style

We use Conventional Commits. This enables `release-please` automation:

- `feat:` — new capability
- `fix:` — bug fix
- `docs:` — docs only
- `chore:` — tooling, deps
- `refactor:` — no user-visible change
- `test:` — tests only

Include scope when helpful: `feat(web): ...`, `fix(agent-host): ...`.

Breaking changes: `feat!: ...` or `BREAKING CHANGE:` footer.

## Project conventions

- **Branch per plan:** implementation lives on `feat/<plan-name>` off `main`; plan docs (`.plans/<NN>-name/`) stay on `main`. Do not implement directly on `main`.
- **Filenames:** kebab-case for source/test/script files. Check with `pnpm check:filenames` (`packages/repo-policy`).
- **Storage taxonomy:** see `AGENTS.md` — user config under `BELAY_HOME` (`~/.belay`), runtime state under `BELAY_STATE_HOME` (`~/.local/state/belay` via `@belay/session/node-paths`), temp under `tmpdir()`.
- **Testing:** `unit` (co-located `*.test.ts`), `integration` (`test/` per package), `web` (jsdom), `e2e` (top-level `e2e/`). One runner `vitest run` via projects. See `AGENTS.md#Testing`.
- **Web UI:** prefer optimistic updates (see `apps/web/src/sidebar/use-project-sidebar.ts`).

## Pull requests

1. Branch from `main`, keep changes focused.
2. Ensure `pnpm lint && pnpm -r typecheck && pnpm test` passes locally.
3. Describe behavior + anchor to implementation (`apps/...`, `packages/...`) and plan if applicable.
4. For browser-visible fixes (scroll, virtualization, snapshots), include browser verification or Playwright trace.

## Reporting issues

Use the issue templates in `.github/ISSUE_TEMPLATE/` — bug report or feature request.

## Security

Do not file public issues for vulnerabilities. See `SECURITY.md`.

## License

By contributing you agree your contribution is licensed under the `MIT` License (`LICENSE`).
