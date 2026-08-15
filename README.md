# Belay

[![CI](https://github.com/dungle-scrubs/belay/actions/workflows/ci.yml/badge.svg)](https://github.com/dungle-scrubs/belay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)
[![pnpm 11.5.2](https://img.shields.io/badge/pnpm-11.5.2-blue)](pnpm-workspace.yaml)

Local-first agent workspace — React 19 frontend + Effect host, SQLite log, content-addressed blobs, MCP/hooks/runtime.

## What it does

- **Session log** — typed event protocol (`packages/session`) + SQLite store (`apps/session-store`) + WebSocket stream/replay with optimistic updates
- **Agent host** — Effect loop (`apps/agent-host`) with turn scheduler, lease leader, provider routing (LM Studio / cloud via `pi-ai`), tool sandbox seam
- **Artifacts** — immutable blob store (`apps/blob-store`), managed worktrees, markdown artifacts, capability manifest (`/belay-export`)
- **Web UI** — `apps/web` (Vite, virtualized transcript, optimistic sidebar, Storybook)
- **CLI** — `belay` launcher (`apps/belay-cli`) via `opchain` for secrets

See `FEATURES.md` for the capability ledger with code anchors, `docs/capability-manifest.md` for the derived manifest, and `AGENTS.md` for project conventions.

## Requirements

- Node >= 22 (`node --version`)
- pnpm 11.5.2 (`corepack enable` then `corepack prepare pnpm@11.5.2 --activate`)
- For local models: LM Studio running with an OpenAI-compatible endpoint (`LMSTUDIO_URL`)
- For cloud models: `~/.pi/auth.json` via `pi-ai` (Codex / Claude credentials)

## Quick start

```bash
# clone and install (frozen lockfile)
git clone https://github.com/dungle-scrubs/belay.git
cd belay
corepack enable
pnpm install --frozen-lockfile

# run everything (stores + host + web) concurrently
pnpm dev
# → web http://127.0.0.1:17420, session-store ws://127.0.0.1:17424, blob-store http://127.0.0.1:17423

# or run pieces
pnpm --filter @belay/session-store dev
pnpm --filter @belay/blob-store dev
pnpm --filter @belay/agent-host dev
pnpm --filter @belay/web dev
```

Open `http://127.0.0.1:17420` in a browser. The host will claim the session lease if a project is available.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `BELAY_HOME` | `~/.belay` | Editable config (`config.jsonc`, `AGENTS.md`) — portable, hand-edited |
| `BELAY_STATE_HOME` | `~/.local/state/belay` | Runtime state: SQLite, blobs, registries, worktrees (resolved via `@belay/session/node-paths`) |
| `LMSTUDIO_URL` | — | LM Studio OpenAI-compatible endpoint, e.g. `http://127.0.0.1:1234/v1` |
| `BELAY_TOOL_SCRIPT_ALLOW_UNSANDBOXED` | `0` (fail-closed) | Set `1` on Linux to allow tool scripts without sandbox |

Port registry: `~/.agents/PORTS.md` governs loopback ports; all services bind to `127.0.0.1`.

## Scripts

```bash
pnpm lint            # Biome + filename policy (packages/repo-policy)
pnpm format          # Biome write
pnpm check:filenames # kebab-case enforcement
pnpm typecheck       # pnpm -r typecheck (tsgo)
pnpm test            # vitest run (all projects)
pnpm test:unit       # --project unit (co-located *.test.ts)
pnpm test:integration# real SQLite + ephemeral ports
pnpm test:web        # jsdom + Testing Library
pnpm test:e2e        # hermetic (fake provider)
pnpm test:e2e:browser# real browser (Playwright, needs chromium)
pnpm --filter @belay/web storybook # Storybook on :17422
```

Pre-commit hooks via `lefthook`: Biome, typecheck, filename policy, unit tests. Pre-push runs `trufflehog git --only-verified`.

## Project layout

```
apps/
  agent-host/      # Effect host, turn loop, providers, MCP, hooks
  web/             # React 19 + Vite, transcript, composer, sidebar
  session-store/   # SQLite log + WS fan-out
  blob-store/      # content-addressed blobs
  belay-cli/       # launcher (belay bin) via opchain
  supervisor/
packages/
  session/         # protocol, transport, ports, telemetry
  launcher/ server-kit/ sdk/ test-kit/ repo-policy/
e2e/               # hermetic + live-model lanes (vitest)
tests/browser/     # Playwright real-browser suite (virtualization, transcript)
.plans/            # numbered plan-db (backlog, not shipped)
docs/              # capability manifest, ADRs
```

## Development

- **Branch per plan:** implementation on `feat/<plan-name>` off `main`; plan docs (`.plans/<NN>-name/`) stay on `main`. See `AGENTS.md`.
- **Filenames:** kebab-case, enforced by `pnpm check:filenames`.
- **Storage taxonomy:** `BELAY_HOME` / `BELAY_STATE_HOME` / `tmpdir()` — no new dot-dirs without updating `@belay/session/node-paths`.
- **Testing:** unit (co-located), integration (`test/` per package), web (jsdom), e2e (top-level `e2e/` + `tests/browser`). Single runner: `vitest run` with projects.
- **Web UI:** optimistic updates — reflect locally at click time, revert on publish failure, drop override when durable data confirms.

## Security

Do not file public issues for vulnerabilities. See `SECURITY.md` for reporting (email) and `SECURITY_RISKS.md` for known audit state. Secrets are scanned locally on pre-push via TruffleHog; CI never logs secrets.

## Contributing

See `CONTRIBUTING.md` — Conventional Commits, branch hygiene, testing tiers, and PR template (`.github/PULL_REQUEST_TEMPLATE.md`). Issue templates live in `.github/ISSUE_TEMPLATE/`.

## Changelog & Releases

- `CHANGELOG.md` is generated via `release-please` from Conventional Commits on `main`.
- Release workflow: `.github/workflows/release.yml` (push to `main` → release-please PR → GitHub Release).
- Current version: `0.0.0` (pre-release, tracking `main`; pin to commit SHA for production).

## License

MIT — see `LICENSE`. Copyright (c) 2026 Kevin Frilot and contributors.
