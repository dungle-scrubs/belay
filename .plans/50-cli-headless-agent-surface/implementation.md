# CLI Headless Agent Surface — Implementation Plan

Make the `trevor` CLI a first-class headless agent surface — a one-shot
`trevor -p "…"` that runs a turn to completion without a browser, per-request
`--model` / `--reasoning` selection, a `trevor models` catalog listing, and
`config.jsonc` + env defaults — instead of only a browser-launcher plus a
session-addressed `trevor prompt` that requires an already-running host.

## 0. Hard Dependencies

All hard dependencies are **already complete** (this plan is wiring + one
launcher option + one SDK read on top of them); the only cross-plan concern
is a shared seam with plan 48 and a resolver plan 49 will consume.

- **Complete — plan 28 (headless CLI/SDK harness).** Established the
  `apps/trevor-cli` executable, its arg-parsing surface, and the SDK boundary
  <!-- D-004 -->(plan 28 D-003: command names, arg parsing, output formatting,
  and exit behavior are CLI-layer concerns; the SDK returns data). The SDK
  `PromptInput` already carries `model: ModelRef` + `reasoning` + `provider`,
  and `runPrompt` already forwards `options.model` — only `main.ts` never
  builds one.
- **Complete — plan 44.1 (`@trevor/launcher` extraction).** `launch()` /
  `launchInner()` / `spawnHost` live in `packages/launcher/src/`; `spawnHost`
  is already fully headless and `openBrowser` is an injected, best-effort,
  separable `LaunchPlatform` capability. (Plan 48's §0 still points at the old
  `apps/trevor-cli/src/launch.ts`; that path is gone — see downstream note.)
- **Complete — D-065 (ModelRef / source / catalog contract).**
  `ModelRef = {sourceId, modelId, reasoning}` in
  `packages/session/src/model-source.ts`; per-model `reasoningLevels` /
  `defaultReasoning` on the catalog entry; host announces `sources` +
  `catalogBySource` on `host.online` / presence.
- **Complete — plan 51 (host-side model default + favorites).** Precedence
  `active ?? default ?? legacy` (51 D-005); this plan's resolved model slots
  in as an explicit per-session active, above that host default.
- **Coordination — plan 48 (desktop shell / Tauri), NOT a blocker.** Plan 48
  M7 needs the *same* browser-less host spawn this plan adds
  <!-- D-003 -->(`launch({ noBrowser })`). Neither hard-depends on the other;
  they share one seam and must not fork it. Threaded as a forward dependency
  into 48 (§ downstream).
- **Coordination — plan 49 / WS3 (config consolidation) shares the config
  loader, NOT a blocker.** <!-- D-011 -->There is exactly one
  `${TREVOR_HOME}/config.jsonc` loader, and both 49-WS3 (which already owns it
  and is numbered *first*) and this plan's M4 specify it. Whichever is
  implemented first builds the loader + `flag>env>file>default` resolver; the
  other **extends** it — 49-WS3 to the full `TREVOR_*` scatter + `trevor
  init`/`doctor`, 50-M4 to the `model`/`reasoning` keys. Neither forks a second
  loader; if 49-WS3 has already landed, M4 consumes its loader. (This corrects
  D-008's assumption that 50 runs before 49.) Threaded into 49 (§ downstream).

## Architecture

The CLI stays a thin app over `@trevor/sdk` + `@trevor/launcher`
(plan 28 D-003). Nothing in the agent loop, provider layer, or protocol
changes. Four capabilities are added at three layers:

- **CLI (`apps/trevor-cli`)** — the `-p` top-level flag, the `--model` /
  `--reasoning` flags on `prompt`, the `trevor models` verb, the
  `config.jsonc` + env resolver, and all arg parsing / output / exit behavior.
- **SDK (`@trevor/sdk`)** — one new read: `listCatalog()` (host-announced
  sources + `catalogBySource` from presence). Everything else the SDK already
  exposes (`prompt`, `streamTurn`, `ensureSession`).
- **Launcher (`@trevor/launcher`)** — one new option: `launch({ noBrowser })`
  that skips the two unconditional `openBrowser` calls in `launchInner`,
  exposing "ensure a host is online without a browser" as a reusable primitive.

### The one-shot `-p` flow

<!-- D-001 --> `trevor -p "…"` drives a headless agent-host — it does **not**
run an in-process agent loop. Trevor v2 is purely client/server: the loop
lives in the agent-host and is driven over the session log via the SDK, so
there is no `runAgent` to call in-process (unlike trevor_legacy's
`cli/prompt.ts`, which forked exactly that and left model/effort second-class).

The flow reuses `launchInner` steps 1–4 (resolve project + session, ready
shared services, `decideHostAction` → spawn-or-reuse host, `waitForHostOnline`)
with `noBrowser`, then hands off to the existing `runPrompt` path
(`client.prompt` + `client.streamTurn`) — deltas to stderr, final answer to
stdout, `--json` for the structured turn record.

<!-- D-002 --> **Default:** resolve the project session, reuse-or-spawn its
host, run the turn, and **leave the host running** (mirrors no-arg `trevor`;
fast on repeat calls). **`--ephemeral`:** mint a throwaway session, spawn a
host, run, then tear down — but tear down **only a host this invocation
spawned**, never one already running (a browser tab or the supervisor may own
it). "Ensure host online (browser-less)" is the shared primitive `trevor
models` also uses.

### Model / reasoning selection

<!-- D-004 --> `--model` / `--reasoning` build a `ModelRef` in `main.ts` and
ride the already-wired `PromptInput.model` path; `reasoning` travels on
`ModelRef.reasoning` (the authoritative channel; the legacy top-level
`reasoning` field is left for the migration to retire).

<!-- D-005 --> `--model` syntax is `<sourceId>/<modelId>`; a bare
`--model <modelId>` is accepted only when unambiguous across sources, else the
error lists the qualified candidates. `--reasoning <level>` is validated
against that model's catalog `reasoningLevels`.

<!-- D-009 --> An unknown model or an unsupported reasoning level **fails
fast** with a catalog-derived error pointing at `trevor models`, rather than
passing an unresolvable ref to the host (trevor_legacy silently dropped effort
to `undefined` — the trap this avoids).

### Catalog read

<!-- D-006 --> The catalog is host-announced (derived from `~/.pi/auth.json` at
host startup) and rides `host.online` / presence, but has no SDK accessor
today. A new `client.listCatalog()` reads sources + `catalogBySource` from the
session log; `trevor models [--json]` prints it, and `--model` / `--reasoning`
validation resolves against it. Because the catalog needs a live host, both
`trevor models` and validation use the M1 browser-less ensure-host-online
primitive.

### Config + env resolution

<!-- D-007 --> Effective model/reasoning resolves as:
**`--flag` > `TREVOR_MODEL`/`TREVOR_REASONING` env > `${TREVOR_HOME}/config.jsonc`
> host-side default** (plan 51 `active ?? default ?? legacy`). Env wins over
file, matching plan 49/WS3's precedence model. The env vars follow the existing
`SESSION_STORE_URL` / `BLOB_URL` override pattern in `main.ts`.

<!-- D-008 --><!-- D-011 --> This plan's M4 builds (or, if 49-WS3 has already
landed, consumes) the single `${TREVOR_HOME}/config.jsonc` loader — JSONC parse
+ the resolver — for the `model` / `reasoning` keys. Both 49-WS3 (numbered
first, owns the loader) and 50-M4 specify it; whichever lands first builds it
and the other extends it. There is exactly one config loader.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Trevor v2 has no in-process agent loop | `-p` must drive a host, not run the agent itself (D-001) |
| Catalog is host-announced, needs a live host | `trevor models` + flag validation require ensure-host-online (D-006) |
| `openBrowser` is called unconditionally in `launchInner` (two sites) | Needs a `noBrowser` option to reach a headless spawn (D-003) |
| ModelRef needs `sourceId` + `modelId`; a modelId can repeat across sources | Source-qualified flag syntax + unambiguous-bare shortcut (D-005) |
| Only one config loader may exist across plans 49 and 50 | Whichever of 49-WS3 / 50-M4 lands first builds it; the other extends it (D-008/D-011) |
| `--ephemeral` must not kill a host it didn't spawn | Track spawn ownership; tear down self-spawned only (D-002) |

### Boundaries

- **CLI ↔ SDK:** the CLI parses args, formats output, sets exit codes, and
  owns process/lifecycle concerns; the SDK returns data + operations
  (plan 28 D-003). New CLI surface: `-p`, `--model`, `--reasoning`,
  `trevor models`, the config resolver. New SDK surface: `listCatalog()` only.
- **CLI ↔ launcher:** the CLI calls `launch({ noBrowser })`; the launcher owns
  project/session identity, host ownership, and spawn. No new host-ownership
  logic in the CLI.
- **Config resolver:** a single module (e.g. `apps/trevor-cli/src/config.ts`,
  or `packages/session` if 49-WS3 lands first and places it there) owning
  file+env+flag precedence; 49-WS3 and 50-M4 share it, never a parallel one.

New target files (`apps/trevor-cli/src/config.ts`, and the `-p` / `models` /
resolver seams in `main.ts`) get module-level comments describing what they own
and why, matching `headless.ts`'s existing docstring style.

### Observability

The `-p` and `trevor models` paths cross the launcher spawn + session
transport. They must surface, on failure, *which* stage failed: project
resolution, services-ready, host spawn, `waitForHostOnline` timeout, catalog
read, or turn timeout — not a bare "failed". Reuse the launcher's existing
`step`/status reporting; a `--json` error on `-p` and `models` carries a
structured `{ stage, message }` so scripted callers can branch. The
ensure-host-online primitive logs the spawn-or-reuse decision (which host pid,
reused vs spawned) so `--ephemeral` teardown ownership is auditable.

---

## Phases

### Phase 1: First-class headless CLI (single phase)

**Goal:** From a terminal, a user can run a full agent turn one-shot without a
browser, pick the model + reasoning per request, discover valid values, and set
defaults via env / `config.jsonc`.

**Gate from previous:** none (builds on completed 28 / 44.1 / 51 / D-065).

#### M1: Browser-less spawn + `trevor -p`

- **Dependencies:** none
- **Effort:** M (3-7d)
- **Tasks:**
  1. RED: Launcher test — `launch({ noBrowser: true })` readies services and
     spawns/reuses a host but never calls `platform.openBrowser` (spy asserts
     zero calls); `launch()` without the flag still opens as today.
  2. GREEN: Add `noBrowser?: boolean` to the `launch()` options; guard the two
     `openBrowser` call sites in `launchInner` (`~:195`, `~:249`).
  3. RED: CLI test — `trevor -p "hi"` resolves the project session, ensures a
     host online browser-less, runs `runPrompt`, and prints the final answer to
     stdout (deltas to stderr); `--json` prints the turn record. Drive against a
     recording transport + fake launcher platform.
  4. GREEN: Add the top-level `-p` / `--prompt` branch in `main()` (before the
     launcher path); wire the ensure-host-online primitive + `runPrompt`.
  5. RED: CLI test — `--ephemeral` mints a throwaway session, and on completion
     tears down a host it spawned but NOT a pre-existing/reused host
     (ownership assertion via the spawn decision).
  6. GREEN: Implement `--ephemeral` (throwaway session id, spawn, teardown-if-
     self-spawned).
  7. RED: Error-path test — spawn failure / `waitForHostOnline` timeout / turn
     timeout each surface a distinct `{ stage }` message (and structured
     `--json` error).
  8. GREEN: Thread stage-tagged failures through the `-p` path.
  9. REFACTOR: Extract "ensure host online (browser-less)" as one named helper
     reused by M2; update `USAGE`; module-comment the new `main.ts` seams.

#### M2: SDK catalog read + `trevor models`

- **Dependencies:** M1 (ensure-host-online primitive)
- **Effort:** S (1-3d)
- **Tasks:**
  1. RED: SDK test — `client.listCatalog(sessionId)` returns the host-announced
     `sources` + `catalogBySource` (with per-model `reasoningLevels` /
     `defaultReasoning`) parsed from a recorded `host.online` / presence event;
     empty/absent presence yields a typed empty-catalog result, not a throw.
  2. GREEN: Implement `listCatalog()` in the SDK client (read presence from the
     session log; reuse `model-source` decoders).
  3. RED: CLI test — `trevor models` ensures a host online, prints one line per
     model (`sourceId/modelId` + reasoning levels); `--json` prints the
     structured catalog; no-host / empty catalog prints a clear message.
  4. GREEN: Add the `models` verb to `runHeadless` dispatch + `USAGE`.
  5. REFACTOR: Share the catalog-formatting helper between human + validation
     use; module-comment the SDK read.

#### M3: `--model` / `--reasoning` on `trevor prompt` (and `-p`)

- **Dependencies:** M2 (catalog for validation)
- **Effort:** S (1-3d)
- **Tasks:**
  1. RED: Parser test — `--model <sourceId>/<modelId>` builds the matching
     `ModelRef`; a bare unambiguous `--model <modelId>` resolves via the
     catalog; an ambiguous bare model errors listing qualified candidates
     (D-005).
  2. GREEN: Add `--model` / `--reasoning` to the `prompt` (and `-p`) value-flag
     set; build the `ModelRef` and pass it as `options.model` into `runPrompt`.
  3. RED: Validation test — an unknown model or an unsupported reasoning level
     fails fast with a catalog-derived error pointing at `trevor models`
     (D-009); a valid `--reasoning` rides `ModelRef.reasoning`.
  4. GREEN: Validate the parsed ref/level against `listCatalog()` before submit.
  5. RED: End-to-end test — a `prompt --model … --reasoning …` publishes a
     `user.message` whose `model` ModelRef carries both fields (recording
     transport assertion).
  6. GREEN: Confirm the wired path (mostly assertion; plumbing exists).
  7. REFACTOR: Fold model-flag parsing into a single `resolveModelRef(args,
     catalog)` used by both `prompt` and `-p`.

#### M4: `config.jsonc` + env defaults + precedence

- **Dependencies:** M3 (the ModelRef the resolver produces)
- **Effort:** M (3-7d)
- **Tasks:**
  1. RED: Resolver unit test — precedence `flag > env > file > host-default`
     (D-007): each layer overrides the ones below; a missing/malformed
     `config.jsonc` degrades to env+default with a clear warning, not a throw.
  2. GREEN: Build (or consume, if 49-WS3 already shipped it) the single
     `${TREVOR_HOME}/config.jsonc` loader — JSONC load (`model` / `reasoning`
     keys) + the resolver. <!-- D-011 -->One loader, shared with 49-WS3.
  3. RED: Env test — `TREVOR_MODEL` / `TREVOR_REASONING` are honored (following
     the `SESSION_STORE_URL` pattern) and lose to an explicit flag, win over
     the file.
  4. GREEN: Read the env vars in the resolver; wire the resolver into `prompt`
     and `-p` so an omitted flag falls through the chain.
  5. RED: Precedence-vs-host test — with no flag/env/file, resolution defers to
     the host default (plan 51 `active ?? default ?? legacy`), i.e. the CLI
     sends no `model` and the host default applies.
  6. GREEN: Ensure "no resolved model" sends no ModelRef (host default wins),
     not an empty/invalid ref.
  7. REFACTOR: Document the precedence chain in `USAGE` + a `config.jsonc`
     example; module-comment the loader noting it is shared with plan 49/WS3
     (whichever lands first builds it; the other extends it).

### Gate 1→done

- [ ] `trevor -p "…"` runs a turn to completion with no browser and prints the
      answer (human + `--json`); `--ephemeral` tears down only self-spawned
      hosts.
- [ ] `trevor prompt`/`-p` accept `--model` / `--reasoning`, validated against
      the catalog, failing fast on unknown values.
- [ ] `trevor models` lists valid `sourceId/modelId` + reasoning levels.
- [ ] Precedence `flag > env > config.jsonc > host-default` holds end-to-end.
- [ ] `launch({ noBrowser })` is the single seam; plan 48 M7 can consume it.
- [ ] Lint + typecheck + the CLI/SDK/launcher test suites pass.

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Two config loaders emerge (this plan + 49/WS3) | high | medium | D-008: build one scoped loader here; thread 49 to extend it, not re-introduce | impl |
| Browser-less seam diverges from plan 48's supervisor spawn | medium | medium | D-003: one `launch({ noBrowser })` option; forward-dep bullet in 48 M7 | impl |
| `--ephemeral` kills a host owned by a browser tab / supervisor | high | low | D-002: track spawn ownership; tear down self-spawned only | impl |
| `trevor models` unusable when no host can start (bad auth) | medium | medium | Structured `{ stage }` error pointing at the failing step; `--json` for scripts | impl |
| Bare `--model modelId` collides across sources silently | medium | low | D-005: unambiguous-only; else error lists qualified candidates | impl |

---

## Escape Hatches

1. **If `launch({ noBrowser })` proves entangled with browser assumptions:**
   fall back to injecting a no-op `openBrowser` platform in the CLI (zero
   launcher change) for M1, and defer the shared option to a follow-up
   coordinated with plan 48.
2. **If the `config.jsonc` resolver balloons past model/reasoning:** ship M1–M3
   (flags + `-p` + `models`) with **env-only** defaults (the originally-scoped
   quick win) and leave the full `config.jsonc` loader to plan 49/WS3 (which
   owns it and is numbered first). M1–M3 do not depend on the file loader.
3. **If `listCatalog()` presence parsing is unstable:** `trevor models` can fall
   back to the host's capability-manifest export (already an SDK method) while
   the presence read is hardened; validation degrades to pass-through with a
   warning until then.

---

## Progress Report Accounting

The progress report is the resume state and uses normalized accounting:
current-cutoff blockers only in the active flow, any deferred/escape-hatch work
under a follow-up bucket, the current-focus marker matching the first unchecked
current-cutoff box. Before resuming implementation or declaring convergence:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "50-cli-headless-agent-surface"
```

---

## Validation Commands

```bash
# From repo root
pnpm --filter @trevor/cli test
pnpm --filter @trevor/sdk test
pnpm --filter @trevor/launcher test
pnpm -w typecheck
pnpm -w lint

# Manual smoke (headless one-shot, no browser)
trevor -p "say hi" --model <sourceId>/<modelId> --reasoning high --json
trevor models --json
```

---

## Decisions

Canonical decisions are in `.plans/50-cli-headless-agent-surface/plan.db`
(D-001 … D-010). Query with:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "50-cli-headless-agent-surface"
```
