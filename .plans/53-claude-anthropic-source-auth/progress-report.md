# Claude / Anthropic Source Auth — Progress Report

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks | 25 |
| Completed | 0 |
| Deferred / future-phase | 0 |
| Superseded | 0 |

**Current focus:** Phase 1 M1 — collapse the two Claude OAuth sources (`anthropic` + `claude-code`) into one "Claude Code subscription" source.

**Stage:** RFC → READY (this plan enters the backlog at `ready`; implementation begins on its own branch off `main`).

---

## Phase 1: Consolidate the host source registry

**Goal:** One Claude subscription source (oauth, setup-token/SDK) and one Anthropic
Direct API source (api-key, plain key); the OAuth-mints-a-key path removed. The chooser
re-groups automatically because it is presentational.

### M1: Collapse the two Claude OAuth sources into one subscription source

- [ ] RED: Add a `buildCatalogSnapshot` unit test asserting exactly ONE Claude source under the oauth ("Cloud subscriptions") family — id `claude-code`, label "Claude Code subscription" — and that the separate `anthropic` oauth source is gone. <!-- D-001 -->
- [ ] GREEN: Remove the `anthropic` oauth `SourceDef` row (catalog.ts:76-81) and relabel the surviving `CLAUDE_CODE_SOURCE_ID` row to "Claude Code subscription"; keep its `cliTokenEnv` (setup-token) signal and `toolCapable: false`.
- [ ] RED: Add a `providerForSource` test asserting the merged subscription source dispatches to the SDK provider (`claudeCodeProvider`), billed to the setup-token, for a Claude model id.
- [ ] GREEN: Route the merged source through `claudeCodeProvider` (catalog.ts:384-436); drop the `source.sourceId === "anthropic"` → `anthropicProvider` branch (catalog.ts:399-401).
- [ ] RED: Add a snapshot test asserting the merged source's configured signal is the setup-token env (`cliTokenPresent`) so its action projects to `configure`, not `authenticate`.
- [ ] GREEN: Confirm the actions projection (catalog.ts:366-371) yields `configure` for the merged source (already true for a `cliTokenEnv` oauth source).
- [ ] REFACTOR: Delete the orphaned `anthropic`-source comments and update the module doc-comment so the registry describes ONE Claude subscription.

### M2: Add the Anthropic Direct API (api-key) source; remove the OAuth-mints-a-key path

- [ ] RED: Add a `buildCatalogSnapshot` test asserting a new `api-key` source "Anthropic Direct API" under the Direct API family (peer to DeepSeek / Z.ai / MiniMax), with a static-key configured signal and NO OAuth/device-code action. <!-- D-002 -->
- [ ] GREEN: Add the Anthropic Direct API as a `PI_KEY_PROVIDERS` row (`pi-key.ts`, piProvider `anthropic`, a static `{ key }` auth entry — e.g. `anthropic-api`) so the source + roster provider derive from one row.
- [ ] RED: Add a `providerForSource` test asserting the new source dispatches to `piKeyProviderFromConfig` (direct `anthropic-messages`, plain key) — never `getOAuthApiKey`.
- [ ] GREEN: Confirm the api-key dispatch branch (catalog.ts:422-434) builds the Anthropic direct provider from the registry row.
- [ ] RED: Add a test asserting the OAuth-mints-a-key path is gone: `signInTargetFor("anthropic")` returns null and no `anthropicProvider`/`oauthCredentialResolver({ oauthName: "anthropic" })` provider is constructible.
- [ ] GREEN: Delete `anthropic.ts`, remove its catalog.ts import, and remove the `anthropic` `SIGN_IN_TARGETS` entry (provider-auth.ts:150-153) with its `anthropicLogin` helper.
- [ ] REFACTOR: Sweep dangling imports/exports and roster references so the direct API is a clean api-key peer with nothing left pointing at the removed OAuth provider.

**Gate 1→2:** all Phase 1 catalog + provider tests pass; snapshot reports one oauth Claude source + one api-key Anthropic source; nothing imports `anthropicProvider` or the `anthropic` sign-in target.

---

## Phase 2: Chooser wiring and pixel pass (web, Storybook-first)

**Goal:** The `configure` source action is wired end to end (no dead button) and the
auth-URL no longer overflows. Both built Storybook-first over the host read models.

### M3: Wire the dead `configure` source action

- [ ] RED: Add a `SourceAuthPanel` / `ModelChooser` story (or interaction test) for an api-key source needing setup, asserting "Configure" invokes `onSourceAction(sourceId, "configure")`.
- [ ] GREEN: Confirm the chooser already forwards `configure` (renders `source.actions`, calls `onSourceAction` — model-chooser.tsx:436, 470); the gap is the App handler.
- [ ] RED: Add an `app.tsx` handler test asserting `onSourceAction(id, "configure")` surfaces the host auth-store setup guidance (not a no-op) for BOTH the Direct-API source and the subscription source. <!-- D-003 -->
- [ ] GREEN: Add the `configure` branch to `onSourceAction` (app.tsx:973-982): open/keep the source detail's `SourceAuthPanel` guidance — never a paste form. Subscription → `claude setup-token` guidance; Direct-API → `~/.pi/auth.json` key guidance.
- [ ] RED: Add a test asserting no source action is a silent no-op — every offerable action (`refresh | authenticate | reauthenticate | configure`) triggers a defined effect.
- [ ] REFACTOR: Make the handler enumerate the `SourceAction` union exhaustively (compile-time exhaustiveness guard) so a future action can't silently no-op again.

### M4: Fix the auth-URL overflow and pixel pass

- [ ] RED: Add a `source-auth-panel.stories.tsx` fixture with a very long verification URL (device-code flow) and assert the panel does not overflow horizontally (URL wraps or scrolls within an `overflow-x-auto` container).
- [ ] GREEN: Fix the URL anchor block (source-auth-panel.tsx:155-170): `break-all` / wrapping or an `overflow-x-auto` container, keeping the external-link icon aligned. <!-- D-004 -->
- [ ] RED: Assert the link + short code-chip row stays within bounds at a narrow container width.
- [ ] GREEN: Adjust the flex row so the long link and the code chip lay out without pushing past the panel edge.
- [ ] REFACTOR: Pixel pass per the repo's pixel-perfect standard — spacing, alignment, wrapped-URL affordance — consistent in light and dark.

---

## Decisions

- **D-001** Collapse the two Claude OAuth sources into one "Claude Code subscription" (oauth, setup-token/SDK credential).
- **D-002** Add a separate "Anthropic Direct API" api-key source (plain key); remove the OAuth-mints-a-key-for-the-direct-API path.
- **D-003** Wire the dead `configure` source action so the Direct-API Configure and the subscription sign-in surface host auth-store guidance.
- **D-004** Fix the auth-URL horizontal overflow in `source-auth-panel.tsx`, pixel-perfect.

## Notes

- The change is registry + dispatch + one web handler + one CSS fix — no `SourceType` /
  `SourceAction` migration, because `oauth`, `api-key`, and `configure` already exist in
  `packages/session/src/model-source.ts`.
- Because the chooser is presentational over `SourceSummary` rows grouped by
  `SourceType`, removing the `anthropic` row and adding the api-key row re-groups the
  chooser with no web change beyond M3 and M4.
- The subscription→direct-API route (gated on the account's usage-charge setting) is an
  open item, not a blocker: the merged source ships routing via the SDK. See Open
  Questions in `implementation.md`.
