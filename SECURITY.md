# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| main    | :white_check_mark: |

We track `main` only. Pin to a commit SHA for production use until versioned releases land.

## Reporting a Vulnerability

Please do not open a public issue. Instead:

1. Email `kevinfrilot@icloud.com` with subject `SECURITY: belay`.
2. Include a minimal reproduction, impact, and affected commit/branch.
3. Allow up to 7 days for an initial response, 30 days for a fix window.

We will credit reporters in `CHANGELOG.md` unless you ask to stay anonymous.

## Secret Handling

- Verified secrets scanning runs via TruffleHog:
  - Local: `lefthook` `pre-push` runs `trufflehog git file://. --only-verified --no-update --fail`
  - CI suggestion: add `trufflesecurity/trufflehog` action on PR if you fork
- Current scan (2026-08-14, TruffleHog 3.93.8): `verified_secrets: 0` (`71551041` bytes, `21994` chunks)
- No `.env` files are committed; `.gitignore` excludes `.env*` (allowlist `.env.example` only)

## Known Dependency Risk (2026-08-14)

`pnpm audit` after patch updates reports **23 advisories** (down from 40 on 2026-08-14) — mostly transitive via `apps/web` (`@storybook/test-runner > jest > glob > brace-expansion`) and `apps/agent-host > @earendil-works/pi-ai > @modelcontextprotocol/sdk > hono/undici`:

- `playwright <1.55.1` (GHSA-7mvr-c777-76hp, high) — **intentionally pinned** at `1.50.0` via `pnpm-workspace.yaml` overrides + `mcr.microsoft.com/playwright:v1.50.0-noble` for screenshot parity (plan 09.2 D-002). Bumping requires coordinated container + lockfile + baseline refresh. Accepted until browser lane upgrade; mitigation: CI runs browsers only inside the pinned container.
- `brace-expansion <1.1.18 / <2.1.4 / <5.0.9`, `js-yaml <3.15.1`, `nanoid <3.3.18 / <5.1.16`, `undici <7.29.0`, `postcss <8.5.18`, `shell-quote <1.8.5`, `uuid <11.1.1` — transitive via Storybook/Jest and `pi-ai` SDK. Direct `mermaid`+`dompurify` patched (`mermaid ^11.16.1`, `dompurify ^3.4.13`); remaining require upstream `@storybook/test-runner` and `@earendil-works/pi-ai` releases. Tracked; patch when upstream ships compatible major.

Run before release:

```bash
pnpm install
pnpm audit
pnpm outdated
trufflehog git file://. --only-verified --no-update --fail
```

## Hardening Checklist for Forks

- Enable GitHub: Settings -> Code security and analysis -> Dependabot alerts, Secret scanning, Push protection
- Enable branch protection on `main` (require PR, dismiss stale reviews)
- Set Actions permissions to least-privilege (`read` default already; restrict `allowed_actions` to `selected` if you use private actions)
- Keep `TREVOR_HOME` / `TREVOR_STATE_HOME` out of backups/sync
