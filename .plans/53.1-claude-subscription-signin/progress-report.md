# 53.1 Claude Subscription Sign-In — Progress Report

**Stage:** ready

> **Current focus:** Phase 1 · M1 — restore the pi-ai Anthropic OAuth provider + sign-in target (M1 RED).

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks | 24 |
| Checked (done) | 0 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

Milestones: M1–M4 (4), across Phase 1 (host) and Phase 2 (web). All current-cutoff; no
deferred or superseded debt at authoring time. The 44.4 re-thread is tracked in plan
44.4's own progress report, not here.

---

## Phase 1 — Host: restore the OAuth route, retire the SDK route

### M1: Restore the pi-ai Anthropic OAuth provider + sign-in target

- [x] RED: `signInTargetFor("anthropic")` test — returns a target with `oauthName:"anthropic"`
      driving `loginAnthropic` (seam injected); today returns `null`.
- [x] GREEN: Restore `anthropicLogin` (adapt `loginAnthropic` `onAuth`/`onManualCodeInput`
      → host `onAuthUrl`/`requestCode`) + re-add the `anthropic` `SIGN_IN_TARGETS` entry.
- [x] RED: `anthropicProvider` test — builds a pi-ai provider on the `anthropic` registry
      with the `oauthCredentialResolver({ oauthName:"anthropic" })` strategy.
- [x] GREEN: Restore `anthropic.ts` from `3eadde0^` (loginAnthropic → `~/.pi/auth.json` →
      `getOAuthApiKey` → pi-ai `anthropic-messages`).
- [x] REFACTOR: Update `anthropic.ts` + `provider-auth.ts` module doc-comments (ONE Claude
      OAuth subscription; both sign-in targets).

### M2: Make `anthropic` the single subscription source; delete the Agent-SDK route

- [x] RED: `buildCatalogSnapshot` — exactly ONE oauth Claude source (`anthropic`, "Claude
      subscription"); unconfigured action is `["authenticate"]`, not `["configure"]`.
- [x] GREEN: In `SOURCES` replace the `CLAUDE_CODE_SOURCE_ID` row with the `anthropic`
      oauth row (`oauthName:"anthropic"`, no `cliTokenEnv`). (Restored tool-capable — see deviation note.)
- [x] RED: `providerForSource` — `anthropic` dispatches to `anthropicProvider`, never
      `claudeCodeProvider`.
- [x] GREEN: Restore the oauth `anthropic → anthropicProvider` branch; remove the
      `CLAUDE_CODE_SOURCE_ID → claudeCodeProvider` branch + import; restore `oauthPresent`
      configured-signal, drop the `cliTokenEnv` branch (+ dead `env` threading).
- [x] RED: Assert the Agent-SDK route is gone — no `claudeCodeProvider` constructible,
      nothing imports `claude-code.ts`.
- [x] GREEN: Delete `claude-code.ts` + its test; sweep `CLAUDE_CODE_SOURCE_ID` /
      `CLAUDE_CODE_OAUTH_ENV` / `cliTokenPresent` references (incl. comment-only mentions).
- [x] RED: `buildCatalogSnapshot` — Anthropic Direct api-key source resolves from its distinct
      `anthropic-api` id/entry, unaffected by the restored OAuth `anthropic` entry.
- [x] GREEN: Re-id the Direct API pi-key row (`key:"anthropic"→"anthropic-api"`); catalog source
      id now derives from `piKeyAuthName(def)`, freeing `anthropic` for the OAuth subscription.
- [x] REFACTOR: Update `catalog.ts` module doc/registry comments (ONE Claude OAuth
      subscription + Direct API peer); remove setup-token prose.

**Gate 1→2**

- [x] One oauth Claude source (`anthropic`, action `authenticate`) + the Direct API row (`anthropic-api`).
- [x] `signInTargetFor("anthropic")` returns the `loginAnthropic` target.
- [x] No symbol imports `claudeCodeProvider`; `claude-code.ts` deleted.
- [x] `pnpm --filter @trevor/agent-host test` green (unit + integration: 3666 passed, 4 skipped).

---

## Phase 2 — Web: restore the in-app sign-in experience (Storybook-first)

### M3: Restore "Sign in" copy + device-code flow for the Claude source

- [x] RED: `SourceAuthPanel` story/test for the `anthropic` oauth source — "Sign in"
      button (action `authenticate`) + "Sign in to Claude subscription" copy, NOT the
      setup-token copy.
- [x] GREEN: Remove the dead oauth-`configure` special-case in `authCopy`
      (`source-auth-panel.tsx`).
- [x] RED: Story/test that a `device-code` `SourceSignInState` renders the `DeviceCodeFlow`
      panel (URL + optional paste field), reusing the long-URL fixture (53 D-004 wrap).
- [x] GREEN: The `sign-in` App command already drives `signInSource` for `anthropic` (the
      `authenticate`→sign-in mapping is unchanged); the panel renders the emitted URL/code. No wiring gap.
- [x] REFACTOR: Refresh the Storybook visual baselines touched by the label/copy change (see Storybook baselines below).

### M4: Refine the Direct API copy; keep the overflow fix

- [x] RED: `SourceAuthPanel` test for the Anthropic Direct api-key source (`anthropic-api`) —
      "add your key to `~/.pi/auth.json`" + "Configure" (not "Sign in"); no api-key source shows
      sign-in framing.
- [x] GREEN: api-key `authCopy` wording already points at the host auth store with no sign-in phrasing;
      the "keys stay in the host auth store" affordance is retained.
- [x] RED: Re-assert the long verification-URL wrap (53 D-004) at a narrow width (kept + a Claude device-code case).
- [x] GREEN: Green — the D-004 wrap fix is untouched.
- [x] REFACTOR: Baselines refreshed via the pinned container (see Storybook baselines below).

**Gate 2→done**

- [x] Claude source renders "Sign in" and opens `loginAnthropic`; Direct API renders
      "Configure"/add-key, never sign-in.
- [x] `pnpm --filter @trevor/web test` green (878 tests) + Storybook baselines regenerated.
- [x] `pnpm typecheck` green across `agent-host`, `web`, `session` (full `pnpm -r typecheck`).

---

## Accepted / Deferred Follow-up

_None at authoring time._ The `claude setup-token` fallback (Escape Hatch 1) is a
conditional, not a scheduled task — built only if R-1 materializes for the owner's account.

## Superseded / Obsolete

_None._

## Storybook baselines

Regenerated in the pinned Playwright container (`v1.50.0-noble`) via
`tests/browser/update-storybook-baselines.sh`. The label/copy change touched exactly three
`SourceAuthPanel` baselines; the full-regen run also drifted 5 unrelated `chat-modelswitchmarker`
PNGs, which were `git checkout`-reverted so only the intended ones are committed:

- **removed** `chooser-sourceauthpanel--claude-subscription-setup.png` (the old oauth+configure story)
- **added** `chooser-sourceauthpanel--claude-subscription-sign-in.png` ("Sign in to Claude subscription")
- **added** `chooser-sourceauthpanel--claude-subscription-device-code.png` (loginAnthropic URL + paste
  field; the long URL still wraps, 53 D-004)

No `model-chooser` baseline changed: those stories render their own fixtures, not the live catalog.
