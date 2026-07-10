# Progress Report - Session Auto-Title + Source-Card Favicon

**Plan:** `58.6.4-session-autotitle-and-source-favicon`
**Stage:** implementing
**Current focus:** done - both milestones implemented, unit-tested, and green

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 11 |
| Checked (done) | 11 |
| Current-cutoff blockers (unchecked) | 0 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

## Current Cutoff

### M1 - Session auto-titling (7)

- [x] Seams under test: the auto-title gate + the title-emit, given a host event sequence.
      (`apps/agent-host/src/agent/auto-title.test.ts` - `needsAutoTitle` + `autoTitleEvent`.)
- [x] RED: Gate fires exactly once on the first `assistant.completed`, only when no
      `session.title` exists; not when the user already renamed; a later manual rename
      still wins.
- [x] GREEN: `buildTitlePrompt(history)` + a title job via `distillTitle`/`distillToBudget`
      at cheapest reasoning, 16-token budget; `autoTitleEvent` emits `session.title` via host
      `emit` with the host producer id. (`apps/agent-host/src/agent/auto-title.ts`.)
- [x] GREEN: Wire the job into the `assistant.completed` branch (`main.ts`) behind the gate
      via `makeAutoTitler`; once-per-process re-entrancy guard; gated on `decoded.text.trim()`.
- [x] RED: A failed/empty title job emits nothing and leaves the derived title untouched.
- [x] REFACTOR: Reuses the compactor's `distillToBudget` primitive (same tool-less pass).
- [x] Verify: host unit tests green (2321). NOTE: the end-to-end host run (a new session
      actually gets a generated title after its first turn) is NOT headlessly verifiable here -
      see manual verification.

### M2 - Lazy source-card favicon (4)

- [x] Build `SourceFavicon`: `<img>` from same-origin `/favicon.ico`, `loading="lazy"`,
      `referrerPolicy="no-referrer"`, `onError` → neutral globe placeholder (mirrors
      `artifact-thumb.tsx`'s `broken` state); never a broken image.
      (`apps/web/src/components/chat/source.tsx`.)
- [x] Dedupe `prettyUrl` into the shared `source.tsx` module; render the favicon via `SourceUrl`
      in `web-fetch.tsx`, `web-search.tsx`, `docs.tsx`.
- [x] RED/behavioral: forced-broken favicon renders the globe placeholder, not a broken image;
      a non-web URL (source-recall-style path) renders the globe with no request.
      (`apps/web/src/components/chat/source.test.tsx`.)
- [x] Verify: `source.stories.tsx` - web-search / web-fetch / docs cards with favicons + a
      forced-broken (`.invalid` host) fallback story.

## Manual Verification

- Host auto-title end-to-end: start a fresh session, send one prompt, and confirm the sidebar row
  gets a generated title (not the truncated first prompt) after the first assistant turn completes,
  and that a manual rename still overrides it. Not headlessly verifiable in this workflow (needs a
  live leader + provider + a real first turn); the gate/emit/failure logic is unit-covered.
- Source-card favicons in the running app / Storybook: confirm real favicons load on web-search /
  web-fetch / docs cards and fall back to the globe when a site has none.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.
