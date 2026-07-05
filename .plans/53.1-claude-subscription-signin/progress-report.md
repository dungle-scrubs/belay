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

- [ ] RED: `signInTargetFor("anthropic")` test — returns a target with `oauthName:"anthropic"`
      driving `loginAnthropic` (seam injected); today returns `null`.
- [ ] GREEN: Restore `anthropicLogin` (adapt `loginAnthropic` `onAuth`/`onManualCodeInput`
      → host `onAuthUrl`/`requestCode`) + re-add the `anthropic` `SIGN_IN_TARGETS` entry.
- [ ] RED: `anthropicProvider` test — builds a pi-ai provider on the `anthropic` registry
      with the `oauthCredentialResolver({ oauthName:"anthropic" })` strategy.
- [ ] GREEN: Restore `anthropic.ts` from `3eadde0^` (loginAnthropic → `~/.pi/auth.json` →
      `getOAuthApiKey` → pi-ai `anthropic-messages`).
- [ ] REFACTOR: Update `anthropic.ts` + `provider-auth.ts` module doc-comments (ONE Claude
      OAuth subscription; both sign-in targets).

### M2: Make `anthropic` the single subscription source; delete the Agent-SDK route

- [ ] RED: `buildCatalogSnapshot` — exactly ONE oauth Claude source (`anthropic`, "Claude
      subscription"); unconfigured action is `["authenticate"]`, not `["configure"]`.
- [ ] GREEN: In `SOURCES` replace the `CLAUDE_CODE_SOURCE_ID` row with the `anthropic`
      oauth row (`oauthName:"anthropic"`, no `cliTokenEnv`).
- [ ] RED: `providerForSource` — `anthropic` dispatches to `anthropicProvider`, never
      `claudeCodeProvider`.
- [ ] GREEN: Restore the oauth `anthropic → anthropicProvider` branch; remove the
      `CLAUDE_CODE_SOURCE_ID → claudeCodeProvider` branch + import; restore `oauthPresent`
      configured-signal, drop the `cliTokenEnv` branch for this source.
- [ ] RED: Assert the Agent-SDK route is gone — no `claudeCodeProvider` constructible,
      nothing imports `claude-code.ts`.
- [ ] GREEN: Delete `claude-code.ts` + its test; sweep `CLAUDE_CODE_SOURCE_ID` /
      `CLAUDE_CODE_OAUTH_ENV` references.
- [ ] RED: `buildCatalogSnapshot` — Anthropic Direct api-key source still resolves from its
      distinct `piKeyAuthName` entry, unaffected by the restored OAuth entry.
- [ ] GREEN: Confirm `pi-key.ts` keeps Direct API on a distinct `authName`; adjust only on
      a real collision.
- [ ] REFACTOR: Update `catalog.ts` module doc/registry comments (ONE Claude OAuth
      subscription + Direct API peer); remove setup-token prose.

**Gate 1→2**

- [ ] One oauth Claude source (`anthropic`, action `authenticate`) + the Direct API row.
- [ ] `signInTargetFor("anthropic")` returns the `loginAnthropic` target.
- [ ] No symbol imports `claudeCodeProvider`; `claude-code.ts` deleted.
- [ ] `pnpm --filter @trevor/agent-host test` green.

---

## Phase 2 — Web: restore the in-app sign-in experience (Storybook-first)

### M3: Restore "Sign in" copy + device-code flow for the Claude source

- [ ] RED: `SourceAuthPanel` story/test for the `anthropic` oauth source — "Sign in"
      button (action `authenticate`) + "Sign in to Claude subscription" copy, NOT the
      setup-token copy.
- [ ] GREEN: Remove the dead oauth-`configure` special-case in `authCopy`
      (`source-auth-panel.tsx:97-101`).
- [ ] RED: Story/test that a `device-code` `SourceSignInState` renders the `DeviceCodeFlow`
      panel (URL + optional paste field), reusing the long-URL fixture (53 D-004 wrap).
- [ ] GREEN: Confirm the `sign-in` App command drives `signInSource` for `anthropic` and
      the panel renders the URL/code; wire only if a gap surfaces.
- [ ] REFACTOR: Refresh the Storybook visual baselines touched by the label/copy change.

### M4: Refine the Direct API copy; keep the overflow fix

- [ ] RED: `SourceAuthPanel` test for the Anthropic Direct api-key source — "add your key
      to `~/.pi/auth.json`" + "Configure" (not "Sign in"); no api-key source shows sign-in
      framing.
- [ ] GREEN: Tighten the api-key `authCopy` wording if any sign-in phrasing surfaces; keep
      the "keys stay in the host auth store" affordance.
- [ ] RED: Re-assert the long verification-URL wrap (53 D-004) at a narrow width.
- [ ] GREEN: No-op if green; else re-apply the wrap fix.
- [ ] REFACTOR: Pixel pass in light + dark; refresh affected baselines.

**Gate 2→done**

- [ ] Claude source renders "Sign in" and opens `loginAnthropic`; Direct API renders
      "Configure"/add-key, never sign-in.
- [ ] `pnpm --filter @trevor/web test` + Storybook baselines green.
- [ ] `pnpm typecheck` green across `agent-host`, `web`, `session`.

---

## Accepted / Deferred Follow-up

_None at authoring time._ The `claude setup-token` fallback (Escape Hatch 1) is a
conditional, not a scheduled task — built only if R-1 materializes for the owner's account.

## Superseded / Obsolete

_None._
