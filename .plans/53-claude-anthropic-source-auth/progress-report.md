# Claude / Anthropic Source Auth — Progress Report

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks | 25 |
| Completed | 25 |
| Deferred / future-phase | 1 |
| Superseded | 0 |

**Current focus:** Done — M1-M4 complete. The registry now exposes ONE "Claude Code subscription"
oauth source (setup-token/SDK) plus a SEPARATE "Anthropic Direct API" `api-key` source; the
OAuth-mints-a-key path (`anthropic.ts` + its sign-in target) is deleted; the dead `configure` action is
wired through an exhaustive dispatcher; the auth-URL overflow wraps within the panel. `pnpm lint`,
`pnpm typecheck`, and `pnpm test` (4428 passed, 8 pre-existing gated skips) are all green.

**Blockers:** 0.

**Stage:** IMPLEMENTED (code + unit/Storybook tests, headless). One live-auth end-to-end verification
is deferred (needs live Anthropic credentials) — see Deferred follow-ups below.

---

## Phase 1: Consolidate the host source registry

**Goal:** One Claude subscription source (oauth, setup-token/SDK) and one Anthropic
Direct API source (api-key, plain key); the OAuth-mints-a-key path removed. The chooser
re-groups automatically because it is presentational.

### M1: Collapse the two Claude OAuth sources into one subscription source

- [x] RED: Add a `buildCatalogSnapshot` unit test asserting exactly ONE Claude source under the oauth ("Cloud subscriptions") family — id `claude-code`, label "Claude Code subscription" — and that the separate `anthropic` oauth source is gone. <!-- D-001 -->
- [x] GREEN: Remove the `anthropic` oauth `SourceDef` row (catalog.ts:76-81) and relabel the surviving `CLAUDE_CODE_SOURCE_ID` row to "Claude Code subscription"; keep its `cliTokenEnv` (setup-token) signal and `toolCapable: false`.
- [x] RED: Add a `providerForSource` test asserting the merged subscription source dispatches to the SDK provider (`claudeCodeProvider`), billed to the setup-token, for a Claude model id.
- [x] GREEN: Route the merged source through `claudeCodeProvider` (catalog.ts:384-436); drop the `source.sourceId === "anthropic"` → `anthropicProvider` branch (catalog.ts:399-401).
- [x] RED: Add a snapshot test asserting the merged source's configured signal is the setup-token env (`cliTokenPresent`) so its action projects to `configure`, not `authenticate`.
- [x] GREEN: Confirm the actions projection (catalog.ts:366-371) yields `configure` for the merged source (already true for a `cliTokenEnv` oauth source).
- [x] REFACTOR: Delete the orphaned `anthropic`-source comments and update the module doc-comment so the registry describes ONE Claude subscription.

### M2: Add the Anthropic Direct API (api-key) source; remove the OAuth-mints-a-key path

- [x] RED: Add a `buildCatalogSnapshot` test asserting a new `api-key` source "Anthropic Direct API" under the Direct API family (peer to DeepSeek / Z.ai / MiniMax), with a static-key configured signal and NO OAuth/device-code action. <!-- D-002 -->
- [x] GREEN: Add the Anthropic Direct API as a `PI_KEY_PROVIDERS` row (`pi-key.ts`, piProvider `anthropic`, a static `{ key }` auth entry — e.g. `anthropic-api`) so the source + roster provider derive from one row.
- [x] RED: Add a `providerForSource` test asserting the new source dispatches to `piKeyProviderFromConfig` (direct `anthropic-messages`, plain key) — never `getOAuthApiKey`.
- [x] GREEN: Confirm the api-key dispatch branch (catalog.ts:422-434) builds the Anthropic direct provider from the registry row.
- [x] RED: Add a test asserting the OAuth-mints-a-key path is gone: `signInTargetFor("anthropic")` returns null and no `anthropicProvider`/`oauthCredentialResolver({ oauthName: "anthropic" })` provider is constructible.
- [x] GREEN: Delete `anthropic.ts`, remove its catalog.ts import, and remove the `anthropic` `SIGN_IN_TARGETS` entry (provider-auth.ts:150-153) with its `anthropicLogin` helper.
- [x] REFACTOR: Sweep dangling imports/exports and roster references so the direct API is a clean api-key peer with nothing left pointing at the removed OAuth provider.

**Gate 1→2:** all Phase 1 catalog + provider tests pass; snapshot reports one oauth Claude source + one api-key Anthropic source; nothing imports `anthropicProvider` or the `anthropic` sign-in target.

---

## Phase 2: Chooser wiring and pixel pass (web, Storybook-first)

**Goal:** The `configure` source action is wired end to end (no dead button) and the
auth-URL no longer overflows. Both built Storybook-first over the host read models.

### M3: Wire the dead `configure` source action

- [x] RED: Add a `SourceAuthPanel` / `ModelChooser` story (or interaction test) for an api-key source needing setup, asserting "Configure" invokes `onSourceAction(sourceId, "configure")`.
- [x] GREEN: Confirm the chooser already forwards `configure` (renders `source.actions`, calls `onSourceAction` — model-chooser.tsx:436, 470); the gap is the App handler.
- [x] RED: Add an `app.tsx` handler test asserting `onSourceAction(id, "configure")` surfaces the host auth-store setup guidance (not a no-op) for BOTH the Direct-API source and the subscription source. <!-- D-003 -->
- [x] GREEN: Add the `configure` branch to `onSourceAction` (app.tsx:973-982): open/keep the source detail's `SourceAuthPanel` guidance — never a paste form. Subscription → `claude setup-token` guidance; Direct-API → `~/.pi/auth.json` key guidance.
- [x] RED: Add a test asserting no source action is a silent no-op — every offerable action (`refresh | authenticate | reauthenticate | configure`) triggers a defined effect.
- [x] REFACTOR: Make the handler enumerate the `SourceAction` union exhaustively (compile-time exhaustiveness guard) so a future action can't silently no-op again.

### M4: Fix the auth-URL overflow and pixel pass

- [x] RED: Add a `source-auth-panel.stories.tsx` fixture with a very long verification URL (device-code flow) and assert the panel does not overflow horizontally (URL wraps or scrolls within an `overflow-x-auto` container).
- [x] GREEN: Fix the URL anchor block (source-auth-panel.tsx:155-170): `break-all` / wrapping or an `overflow-x-auto` container, keeping the external-link icon aligned. <!-- D-004 -->
- [x] RED: Assert the link + short code-chip row stays within bounds at a narrow container width.
- [x] GREEN: Adjust the flex row so the long link and the code chip lay out without pushing past the panel edge.
- [x] REFACTOR: Pixel pass per the repo's pixel-perfect standard — spacing, alignment, wrapped-URL affordance — consistent in light and dark.

---

## Deferred follow-ups

- [ ] Live-auth end-to-end verification: sign in with a real `claude setup-token`, add a real Anthropic
  Direct API key to `~/.pi/auth.json` as `anthropic-api`, and confirm the merged subscription streams
  via the Agent SDK while the Direct API source streams via the plain key — plus the open billing
  question (whether the account's usage-charge setting affects the direct route). Deferred: needs live
  Anthropic credentials + owner confirmation of the account billing behavior. Not testable headless;
  the registry collapse, provider deletion, `configure` wiring, and overflow fix are all covered by the
  unit + Storybook tests that ship green in this cutoff.

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
