# CLI Headless Agent Surface — Progress Report

**Plan:** `50-cli-headless-agent-surface`
**Stage:** ready (authored; not yet implemented)
**Current focus:** M1 — Browser-less spawn + trevor -p (0/9)

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 30 |
| Checked (done) | 0 |
| Current-cutoff blockers (unchecked) | 30 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

All four milestones are current-cutoff; nothing is deferred. Escape-hatch
fallbacks (env-only defaults, no-op `openBrowser`, capability-manifest catalog)
are contingencies in `implementation.md`, not scheduled work — they do not
appear as tasks here.

---

## M1 — Browser-less spawn + `trevor -p`  (0/9)

- [ ] RED: `launch({ noBrowser: true })` readies services + spawns/reuses a host but never calls `openBrowser`; plain `launch()` still opens.
- [ ] GREEN: Add `noBrowser?` to `launch()` options; guard the two `openBrowser` sites in `launchInner`.
- [ ] RED: `trevor -p "hi"` ensures a host online browser-less, runs `runPrompt`, prints final answer to stdout / deltas to stderr; `--json` prints the turn record.
- [ ] GREEN: Add the top-level `-p` / `--prompt` branch in `main()`; wire ensure-host-online + `runPrompt`.
- [ ] RED: `--ephemeral` mints a throwaway session and tears down a self-spawned host but NOT a reused/pre-existing one.
- [ ] GREEN: Implement `--ephemeral` (throwaway session, spawn, teardown-if-self-spawned).
- [ ] RED: spawn failure / `waitForHostOnline` timeout / turn timeout each surface a distinct `{ stage }` message (+ structured `--json` error).
- [ ] GREEN: Thread stage-tagged failures through the `-p` path.
- [ ] REFACTOR: Extract the "ensure host online (browser-less)" helper for M2; update `USAGE`; module-comment new `main.ts` seams.

## M2 — SDK catalog read + `trevor models`  (0/5)

- [ ] RED: `client.listCatalog(sessionId)` returns host-announced `sources` + `catalogBySource` (with `reasoningLevels`/`defaultReasoning`); absent presence → typed empty result, not a throw.
- [ ] GREEN: Implement `listCatalog()` in the SDK client (read presence; reuse `model-source` decoders).
- [ ] RED: `trevor models` ensures a host online, prints one line per model (`sourceId/modelId` + levels); `--json` prints structured catalog; no-host/empty prints a clear message.
- [ ] GREEN: Add the `models` verb to `runHeadless` dispatch + `USAGE`.
- [ ] REFACTOR: Share the catalog-format helper between human + validation; module-comment the SDK read.

## M3 — `--model` / `--reasoning` flags  (0/7)

- [ ] RED: `--model <sourceId>/<modelId>` builds the ModelRef; bare-unambiguous resolves via catalog; ambiguous bare model errors with qualified candidates.
- [ ] GREEN: Add `--model`/`--reasoning` to the `prompt`/`-p` value-flags; build the ModelRef; pass as `options.model` into `runPrompt`.
- [ ] RED: unknown model / unsupported reasoning level fails fast with a catalog-derived error pointing at `trevor models`; valid `--reasoning` rides `ModelRef.reasoning`.
- [ ] GREEN: Validate parsed ref/level against `listCatalog()` before submit.
- [ ] RED: `prompt --model … --reasoning …` publishes a `user.message` whose `model` ModelRef carries both fields.
- [ ] GREEN: Confirm the wired path (assertion; plumbing exists).
- [ ] REFACTOR: Fold flag parsing into one `resolveModelRef(args, catalog)` used by `prompt` + `-p`.

## M4 — `config.jsonc` + env defaults + precedence  (0/7)

- [ ] RED: resolver precedence `flag > env > file > host-default`; missing/malformed `config.jsonc` degrades to env+default with a warning, not a throw.
- [ ] GREEN: Build (or consume, if 49-WS3 shipped it) the single `${TREVOR_HOME}/config.jsonc` loader — JSONC load (`model`/`reasoning`) + resolver. One loader shared with 49-WS3.
- [ ] RED: `TREVOR_MODEL`/`TREVOR_REASONING` honored (SESSION_STORE_URL pattern), lose to a flag, win over the file.
- [ ] GREEN: Read env in the resolver; wire it into `prompt` + `-p` so an omitted flag falls through the chain.
- [ ] RED: with no flag/env/file, resolution defers to the host default (plan 51 `active ?? default ?? legacy`) — CLI sends no `model`.
- [ ] GREEN: Ensure "no resolved model" sends no ModelRef (not an empty/invalid one).
- [ ] REFACTOR: Document precedence in `USAGE` + a `config.jsonc` example; module-comment `config.ts` noting plan 49/WS3 extends it.

---

## Gate 1→done

- [ ] `trevor -p "…"` runs a turn with no browser (human + `--json`); `--ephemeral` tears down only self-spawned hosts.
- [ ] `prompt`/`-p` accept `--model`/`--reasoning`, validated, fail-fast on unknown.
- [ ] `trevor models` lists valid `sourceId/modelId` + reasoning levels.
- [ ] Precedence `flag > env > config.jsonc > host-default` holds end-to-end.
- [ ] `launch({ noBrowser })` is the single seam plan 48 M7 can consume.
- [ ] Lint + typecheck + CLI/SDK/launcher suites pass.
