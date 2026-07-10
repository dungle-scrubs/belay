# Progress Report - Session Auto-Title + Source-Card Favicon

**Plan:** `58.6.4-session-autotitle-and-source-favicon`
**Stage:** ready for implementation
**Current focus:** M1 - Session auto-titling (7)

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 11 |
| Checked (done) | 0 |
| Current-cutoff blockers (unchecked) | 11 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

## Current Cutoff

### M1 - Session auto-titling (7)

- [ ] Seams under test: the auto-title gate + the title-emit, given a host event sequence.
- [ ] RED: Gate fires exactly once on the first `assistant.completed`, only when no
      `session.title` exists; not when the user already renamed; a later manual rename
      still wins.
- [ ] GREEN: `buildTitlePrompt(history)` + a title job via `distillToBudget` /
      `providerOrDefault()` at cheapest reasoning, short token budget; emit `session.title`
      via host `emit` with a host producer id.
- [ ] GREEN: Wire the job into the `assistant.completed` branch (`main.ts:987`) behind the
      gate; re-entrancy guard; skip empty/errored turns.
- [ ] RED: A failed/empty title job emits nothing and leaves the derived title untouched.
- [ ] REFACTOR: Share structure with the compactor's summarize path if it reads cleaner.
- [ ] Verify: host unit tests + a manual host run (new session gets a title; manual rename
      overrides it).

### M2 - Lazy source-card favicon (4)

- [ ] Build `SourceFavicon`: `<img>` from same-origin `/favicon.ico`, `loading="lazy"`,
      `referrerPolicy="no-referrer"`, `onError` → neutral placeholder (mirror
      `artifact-thumb.tsx`); never a broken image.
- [ ] Dedupe `prettyUrl` into the shared module; render the favicon in `web-fetch.tsx`,
      `web-search.tsx`, `docs.tsx`.
- [ ] RED/behavioral: forced-broken favicon renders the placeholder; `source-recall` rows
      (no URL) render unchanged.
- [ ] Verify: story with web-search / web-fetch / docs favicons + one forced-broken fallback.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.
