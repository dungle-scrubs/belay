# Trevor V2 - Progress Report

> Canonical source of truth for the active open checklist. Completed checklist detail lives in
> [progress-report-done.md](./progress-report-done.md) so routine planning turns do not need to load
> every checked item.

> **Scope.** This report tracks open or partial/gated work only. When an item or section is fully
> completed, move its detailed checklist to the done archive and leave only a summary/reference here.
> Current focus: Next-Up: doctor health surface (D-073). Recently progressed: D-092 image attachment
> UX (M1-M6 done; manual EZE repros open) and D-060 internet
> connectivity (M1-M5 done bar explicit-UI-refresh wiring, structured probe logs, and the manual repro).
> Decomposed open sections: D-092 image attachment UX, D-060 internet connectivity
> awareness, D-093 session navigation sidebar, D-094 session lifecycle controls, and D-065 provider
> auth/catalog + full model chooser, D-076-D-079 provider-outage auto-reconnect recovery, and D-073 doctor
> health surface. Later roadmap items stay sequenced in the canonical implementation plan and are decomposed here
> only when picked up.

## Archived Completed Work

Completed checklist detail for Phase 1 through Phase 8, D-083-D-087, the completed D-088-D-091
work, and D-044 session recall is archived in [progress-report-done.md](./progress-report-done.md).

## Carry-Forward: partial/gated archived items

These rows remain visible because they are not fully completed, even though their surrounding feature checklists are archived.

- [~] D-088 sidebar git identity: live EZE repro for dirty file, ahead/behind branch, detached HEAD, and non-git cwd remains gated
- [~] D-090 explicit resume: launcher/supervisor spawning or reusing a matching host for a selected no-host session remains gated
- [~] D-091 managed worktrees: dedicated cwd-path advisory lock remains deferred beyond the existing per-session lock
- [~] D-091 managed worktrees: live two-host worktree smoke remains gated
- [~] D-044 session recall: live manual EZE repro (memory question answered only from compacted-away/sibling history shows the visible recall result before the answer) remains gated

## Next-Up: image attachment UX

D-092 is captured in the implementation plan as the user-facing image attachment layer over the existing
blob-backed artifact transport. V1's useful shape was `[Image #N]` tokens inserted at the cursor, kept in the
transcript, and stripped from provider text while images traveled out-of-band. V2 already has blob-store upload,
`ArtifactRef`, `user.message.artifacts`, queue artifact preservation, and host-side vision model resolution.
What remains is the Storybook-first UX: inline text tokens, Cmd+V image paste, token hover previews, queue
rendering, natural transcript image layout, and same-message carousel. Source:
`apps/web/src/hooks/use-composer.ts`, `apps/web/src/components/chat/prompt-input.tsx`,
`apps/web/src/components/chat/message.tsx`, `apps/web/src/ArtifactThumb.tsx`,
`apps/web/src/send-queue.ts`, `apps/web/src/transcript.ts`, `packages/session/src/protocol.ts`,
`apps/agent-host/src/agent/history-projection.ts`, `apps/agent-host/src/artifacts.ts`,
`apps/agent-host/src/providers/pi-ai.ts` (D-092).

### M1: Storybook composer token states first (D-092)

- [x] Build Storybook fixtures for image-token composer states before live wiring
- [x] Render `[Image #N]` ranges with attachment-token syntax highlighting while keeping normal text-composer behavior
- [x] Use an overlay or mirror layer so token highlighting and hover/focus targets exist without replacing the textarea with a rich editor
- [x] Stories cover token between words, token at start, token at end, multiple tokens, long prompt wrapping, upload in progress, upload error, and broken/unavailable preview
- [x] Token hover/focus preview story shows the image at max 300px wide and 300px tall with preserved aspect ratio
- [x] Storybook includes narrow/mobile and desktop composer widths so token highlighting tracks wrapping
- [x] Stories use production `ArtifactRef` fixtures and `artifactSrc`-compatible image URLs, not story-only fake markup

### M2: Token placement model and editing behavior

- [x] Define the draft attachment model that pairs visible `[Image #N]` tokens with uploaded `ArtifactRef`s
- [x] Insert image tokens at the current cursor or selection replacement point
- [x] Auto-add leading/trailing spaces so inserted tokens do not stick to adjacent words
- [x] Multiple-image paste/drop inserts ordered tokens and refs deterministically
- [x] Backspace next to a token removes the whole token and its artifact ref in one step
- [x] Delete next to a token removes the whole token and its artifact ref in one step
- [x] Removing a token keeps remaining text, refs, and displayed token numbers synchronized in reading order
- [x] Tests cover insertion at start/middle/end, selection replacement, auto spacing, multi-image insertion, and one-step deletion

### M3: Image intake, Cmd+V, and queue preservation

- [x] Cmd+V image paste reads clipboard image files and inserts tokens at the cursor reliably
- [x] File picker inserts tokens at the cursor after upload succeeds or shows a pending token state while upload is in flight
- [x] Drag/drop uploads images and inserts tokens at the current or last-known composer cursor position
- [x] Non-image files keep the existing file/document attachment behavior unless explicitly upgraded later
- [x] Shell mode leaves image tokens/attachments in the composer and never silently drops them
- [x] Queued prompts render the same `[Image #N]` text tokens and carry the matching artifact refs while waiting
- [x] Hard steer preserves queued token text and image refs together when collapsing the queue and draft
- [x] Tests cover Cmd+V paste, picker, drop, queued rendering, shell-mode preservation, and hard-steer preservation

### M4: Transcript image layout

- [x] Submitted user messages preserve `[Image #N]` token positions in the visible text
- [x] Images render in the same user transcript item as the submitted prompt
- [x] Images render at natural dimensions until constrained by story-approved responsive max width and max height
- [x] Images are contained, not cropped, and preserve original aspect ratio
- [x] Multiple images in one user message form one image set for layout and carousel behavior
- [x] Broken, missing, non-renderable, and non-image artifacts degrade to a file/link row without a broken image icon
- [x] Storybook states cover tiny, wide, tall, large, multiple images, long text with tokens, attachments-only prompt, and broken image
- [x] Web tests cover sizing classes/styles, image set grouping, token text preservation, and fallback rows

### M5: Same-message image carousel

- [x] Clicking any transcript image opens a centered dialog carousel for only the images in that user message
- [x] The dialog is large enough for inspection but not full screen
- [x] Carousel image sizing is responsive and preserves aspect ratio
- [x] Previous/next controls cycle through images in submitted order
- [x] Keyboard navigation supports ArrowLeft, ArrowRight, and Escape
- [x] Dialog shows image count/index and accessible image labels
- [x] Storybook states cover one image, many images, wide image, tall image, broken image, and narrow viewport
- [x] Web tests cover open, close, previous/next, keyboard navigation, and same-message scoping

### M6: Provider projection and protocol compatibility

- [x] Keep `ArtifactRef` as the durable blob reference; do not inline bytes into Richter events
- [x] Preserve old `user.message.artifacts` decode compatibility for sessions without placement metadata
- [x] Strip `[Image #N]` tokens from provider text when sending images as model image blocks
- [x] Preserve image order from token reading order when resolving image blocks
- [x] Where provider APIs support interleaved content blocks, project text/image order as closely as possible
- [x] Where provider APIs only support text plus image list, strip tokens from text and send images in token order
- [x] Non-vision providers receive a clear attachment note instead of literal token clutter
- [x] Tests cover old-event decode, provider text stripping, token-order image resolution, non-vision notes, and attachments-only prompts

### M7: Verification

- [x] Storybook reviewed before live app wiring for composer tokens, hover preview, queued prompt, transcript layout, and carousel
- [x] Unit tests cover token parser/editor behavior and placement-to-artifact synchronization
- [x] Web tests cover composer rendering, hover preview, queue rendering, transcript image layout, and carousel controls
- [x] Host tests cover provider projection over tokenized image prompts
- [ ] Manual EZE repro: Cmd+V an image between words, submit, verify transcript natural sizing, open carousel, and verify model receives the image without literal token clutter
- [ ] Manual EZE repro: queue an image prompt during an active turn and verify the queued token and artifact survive until publish

## Next-Up: internet connectivity awareness

D-060 is captured in the implementation plan as host-owned public-internet reachability status. It is not
provider health, not browser `navigator.onLine`, not local session-store/WebSocket presence, and not an automatic
local/cloud fallback mechanism. The first cut is advisory only: the host reports whether it appears able to reach
the public internet, the UI surfaces that near model/source selection, and `/doctor` explains the last probe.
Source: future host connectivity service, `apps/agent-host/src/main.ts`, `packages/session/src/protocol.ts`,
`apps/web/src/components/panel/SidePanel.tsx`, model/source UI surfaces, `/doctor`, and Storybook fixtures (D-060).

### M1: Host-owned status and probe semantics (D-060)

- [x] Define the internet snapshot as `online`, `offline`, or `unknown`, plus a transient `checking` flag while a probe is in flight
- [x] Make the host machine the source of truth for public-internet reachability
- [x] Treat browser `navigator.onLine` only as a possible UI comparison/debug hint, never as the host status
- [x] Probe with a small DNS plus HTTPS check against configured public endpoints
- [x] Treat LAN-up/WAN-down and captive-portal-like failures as `offline` when the public probe fails
- [x] Use `unknown` for no probe yet, disabled/misconfigured probe, or inconclusive probe results
- [x] Keep provider auth, provider rate limits, provider overload, model availability, and provider request failures out of this status
- [x] Store last checked time, snapshot age/staleness, sanitized last error, and probe target class

### M2: Refresh cadence and protocol

- [x] Probe on host startup and publish the first snapshot when available
- [x] Cache ordinary probe results for about 30 seconds to avoid constant network checks
- [ ] Allow an explicit UI refresh action that starts a new probe and exposes `checking`
- [x] Optionally start an async refresh before a cloud turn when the snapshot is stale
- [x] Never block a turn on internet-status refresh
- [x] Include the latest internet snapshot on `host.online`
- [x] Emit a small `host.internet` event on `checking` start, status change, and refresh completion
- [x] Keep internet-status events out of conversation memory and prompt history projection

### M3: Advisory UI and Storybook states

- [x] Build the internet-status UI Storybook-first before app wiring
- [x] Place the compact advisory near the model/source area, where cloud-vs-local expectation is visible
- [x] Keep the internet advisory visually distinct from host presence and session-store/WebSocket connection state
- [x] When a cloud model is selected and the host is offline, show a warning without disabling submit or changing model selection
- [x] When a local model is selected and the host is offline, keep the state neutral/advisory because local turns are unaffected
- [x] Storybook states cover online, offline, unknown, checking, stale, and refresh failure
- [x] Storybook states cover host disconnected, browser offline while host is online/unknown, cloud model selected while offline, and local model selected while offline
- [x] The model/source chooser can show stale status and a refresh action without turning the chooser into a connectivity dashboard
- [x] Web tests cover advisory placement, labels, cloud/offline warning, local/offline non-blocking state, and stale/checking rendering

### M4: Doctor and logging surface

- [x] `/doctor` reports internet status, checking state, last checked time, and snapshot age/staleness
- [x] `/doctor` reports DNS/HTTPS probe class and sanitized last error
- [x] `/doctor` omits credentials, auth headers, full request payloads, and any sensitive endpoint material
- [x] `/doctor` never reports a fallback target because D-060 has no fallback behavior
- [x] Host logs use structured, redacted probe fields for status changes and probe failures
- [x] `/doctor` distinguishes internet reachability from host presence, session-store connectivity, and provider health

### M5: No routing side effects and verification

- [x] A selected local model remains local regardless of internet status
- [x] A selected cloud model remains cloud regardless of internet status
- [x] Cloud request failures do not trigger a local retry or change the selected model
- [x] Offline status does not emit or imply `assistant.providerFallback`
- [x] Local session-store or Richter disconnects do not imply internet offline
- [x] Tests cover browser `navigator.onLine` disagreeing with the host probe
- [x] Tests cover `checking`, stale snapshots, manual refresh, `host.online`, and `host.internet`
- [x] Web tests cover the Storybook-backed advisory states and cloud/local selected-model differences
- [ ] Manual EZE repro: simulate LAN-up/WAN-down or failed public probes, verify advisory UI and `/doctor`, and verify local/cloud model selection is unchanged

## Next-Up: session navigation sidebar

D-093 is captured in the implementation plan as the first-class session navigation slice of D-061. This is not
browser-created sessions, stop/kill/archive controls, or the broader host lifecycle model. It is the everyday
left-sidebar surface for switching among current-project sessions, while `/resume` remains the explicit
keyboard/search entry point over the same inventory and switch action. Source: existing D-090 session inventory
and switch path, `packages/session/src/inventory.ts`, `apps/web/src/App.tsx`,
`apps/web/src/components/panel/SidePanel.tsx`, future sidebar session-list components/stories, and session
transport activity folding (D-093).

### M1: Storybook-first sidebar surface (D-093)

- [x] Build the session navigation sidebar in Storybook before app wiring
- [x] Add an upper-left dashboard-style icon entry point that opens or focuses the session navigator
- [x] Keep the surface in the left-hand sidebar rather than a landing page, full dashboard, or command-only modal
- [x] Show the current selected session with a stable selected state
- [x] Rows show title or first prompt, branch or worktree when known, activity state, and last activity
- [x] Stories cover empty, current-only, many sessions, long titles, long cwd/branch, narrow viewport, and tall lists
- [x] Keep row heights, icon buttons, and labels stable so live status changes do not resize the sidebar
- [x] Storybook uses production-shaped `SessionSummary` fixtures instead of story-only row data

### M2: Current-project inventory and scope

- [x] Reuse the D-090 session inventory/read model where possible instead of inventing a second data path
- [x] Filter the sidebar list to the current project/root only
- [x] Do not show other project sessions in the current working directory context
- [x] Sort sessions by most recent activity, with no grouping in this cut
- [x] Represent stale or inactive host state without exposing "no-host session" as user-facing vocabulary
- [x] Empty and load-error states make clear that the list is scoped to the current project
- [x] Tests prove cross-project sessions are excluded even when they are more recent
- [x] Tests prove recency sorting within the current project

### M3: Live activity and recency projection

- [ ] Show running, queued, and settled states in session rows
- [ ] Keep activity visible for a session while the user is viewing another session
- [x] Update session row activity from durable events and live host/session presence without requiring transcript merge
- [x] Show when a session last settled after running work completes
- [x] Format relative time in seconds, minutes, hours, days, and weeks
- [x] Never render months in relative time
- [x] Render week labels through 10 weeks, then switch to a specific date
- [x] Tests cover running, queued, settled, seconds/minutes/hours/days/weeks, and date fallback

### M4: Navigation and safety semantics

- [ ] Selecting a session navigates to that durable session id through the same safe switch path as resume
- [ ] URL `?session=` remains a deep link and stays in sync with sidebar selection
- [ ] Switching never merges another session transcript into the current view
- [ ] Switching resets browser-local draft, queue, prompt-history navigation state, and session-scoped UI state
- [ ] Active execution in the current session blocks or disables switching with a clear reason
- [ ] Stale or inactive sessions open with visible limitations if no runnable host is attached
- [ ] Switching does not publish a command result or model-visible event into either session
- [ ] Tests cover switch, cancel/no-op, active-run block, stale/inactive selection, and no transcript/draft/queue leakage

### M5: Resume relationship and verification

- [ ] Keep `/resume` as an explicit keyboard/search command entry point, not the everyday visual session list
- [ ] Back `/resume` and sidebar navigation with the same current-project inventory and switch action
- [ ] Do not widen the sidebar or resume command view to global cross-project search in this slice
- [ ] Storybook covers the sidebar alongside the existing resume command modal relationship
- [ ] Web tests cover the dashboard icon entry point, sidebar row rendering, selection, and keyboard accessibility
- [ ] Manual EZE repro: start or queue work in one current-project session, switch to another, and verify the sidebar shows live activity plus settled relative time
- [ ] Manual EZE repro: verify sessions from another project never appear in the current project's sidebar list

## Next-Up: session lifecycle controls

D-094 is captured in the implementation plan as the lifecycle-control slice of D-061. It defines cancel vs stop
vs kill, archive vs delete, and the CLI/debug control surface. Normal UI keeps Escape/cancel as the ordinary
active-work action; stop, kill, archive, and unarchive are management operations, not primary chat/sidebar
commands. Source: launcher/host registry, session-store/Richter metadata, current cancel/interrupt flow,
`apps/trevor-cli`, host lifecycle ownership records, debug UI command surface, and D-093 sidebar filtering (D-094).

### M1: Cancel, stop, and kill semantics (D-094)

- [x] Define cancel as active-work cancellation that leaves the host attached and ready for another prompt
- [x] Define stop as graceful session-level shutdown
- [x] Stop cancels active work and records a clean terminal cancellation where possible
- [x] Stop clears queued work for that session
- [x] Stop asks the host to shut down cleanly and release runtime, lease, and ownership state
- [x] Passive browser disconnect does not stop the host
- [x] Define kill as force termination for a wedged or unresponsive host
- [x] Kill preserves durable history, while any in-flight turn may end as aborted or unknown if the host cannot write a clean event

### M2: Archive metadata and visibility

- [x] Add or use a durable archived flag on session metadata rather than encoding archive state in transcript text
- [ ] Archive hides a session from the main UI, session sidebar, and normal current-project navigation
- [x] Archived sessions are excluded from the default resume/current-project command view
- [x] Archived sessions remain in Richter and are not deleted by archive
- [ ] Unarchive is required before normal opening or use from the main UI
- [x] Archived sessions can be discovered only through an explicit archive filter, archive browser, or CLI archived list
- [x] Permanent delete is deferred to an archive browser with strong confirmation
- [x] D-093 sidebar respects archived filtering and never shows archived rows by default

### M3: CLI lifecycle surface

- [x] `trevor list` shows non-archived current-project sessions by default
- [x] `trevor list --archived` shows archived sessions for the current project
- [x] `trevor open <session>` opens or resumes the selected session in the browser
- [x] `trevor open <session>` starts or attaches the matching host when possible
- [x] `trevor archive <session>` sets the archived flag without deleting the durable log
- [x] `trevor unarchive <session>` clears the archived flag
- [x] `trevor stop <session>` performs graceful session shutdown, including active and queued work handling
- [x] `trevor kill <session>` force terminates the session host runtime

### M4: UI and debug boundaries

- [ ] Normal UI keeps Escape/cancel as the primary active-work control
- [ ] Normal sidebar rows do not expose stop, kill, or archive as ordinary actions
- [ ] Debug mode may expose stop, kill, archive, and unarchive controls
- [ ] Debug stop/kill controls are gated or confirmed and clearly describe lifecycle effects
- [ ] Stale or inactive status is visible without implying the user must stop or kill anything
- [ ] Normal UI filters archived sessions out of D-093 and D-090 surfaces
- [x] Web tests assert stop, kill, and archive controls are absent from the normal sidebar

### M5: Verification

- [ ] Tests prove cancel and stop are different lifecycle operations
- [ ] Tests prove stop cancels active work, clears queued work, releases the host, and keeps the durable log
- [ ] Tests prove kill force terminates the host while preserving durable history
- [x] Tests prove archive and unarchive update metadata and filtering without deleting logs
- [x] Tests cover CLI list, list --archived, open, archive, unarchive, stop, and kill
- [ ] Tests cover debug-only UI exposure and normal-UI absence of lifecycle controls
- [ ] Manual EZE repro: cancel a turn, stop a session, archive/unarchive it, and verify the sidebar/resume filtering plus durable history behavior

## Next-Up: provider auth/catalog + full model chooser

D-065 is captured in the implementation plan as the full model-source and catalog chooser. This is not routing:
the first cut selects one active chat model source only. The full chooser replaces the transcript and prompt
area while sidebars may remain visible, and the current sidebar select becomes a split control: the larger left
region opens the full chooser, while the right chevron keeps a small categorized recent-model popup. Direct API
keys and env-derived secrets are owned by the host auth JSON store and are never pasted into the chooser. Source:
`packages/session/src/protocol.ts`, `apps/web/src/session/use-session.ts`, `apps/web/src/components/panel/SidePanel.tsx`,
future model-source/catalog read models, `apps/agent-host/src/providers`, pi-ai auth/catalog integration, and
Storybook chooser fixtures (D-065).

### M1: Source and catalog domain contract (D-065)

- [x] Define model sources as the product unit above provider adapters
- [x] Define source types for local runtimes, OAuth subscriptions, gateway catalogs, and direct API-key providers
- [x] Define stable model references as `{ sourceId, modelId }` plus selected reasoning
- [x] Define source summaries with status, model count, auth state, catalog freshness, and available actions
- [x] Define catalog entries with display name, source, local/cloud kind, capabilities, context length, pricing/cost tier when known, aliases, and freshness
- [x] Keep the host as the source of truth for source status, auth state, and catalog freshness
- [x] Keep browser hardcoded model lists out of the source/catalog contract
- [x] Preserve backward compatibility with the current `provider` string during migration
- [x] Tests cover source type decoding, source-state projection, catalog entry decoding, and provider-string compatibility

### M2: Storybook-first full chooser surface

- [ ] Build the full model chooser in Storybook before live app wiring
- [ ] Render the chooser in the transcript + prompt space, not as the small sidebar popup
- [ ] Keep left and right sidebars able to remain visible while the chooser is open
- [ ] Use container queries so the chooser adapts to the space left after sidebars, not only viewport width
- [ ] Build a source overview grouped by local, cloud subscription, direct API, and gateway catalog
- [ ] Source rows show status, model count, available action, and click-through affordance
- [ ] Clicking a source opens a narrowed source-detail view with back navigation
- [ ] Source-detail view shows source identity, status, auth/setup action, search, filters, and model rows
- [ ] Storybook states cover wide, narrow, both sidebars visible, long labels, empty, loading, stale, error, and many-source layouts

### M3: Sidebar split control and quick recent picker

- [ ] Split the active-model sidebar control into a larger full-chooser region and a right chevron region
- [ ] Clicking the larger left region opens the full chooser
- [ ] Clicking the right chevron opens the small quick picker
- [ ] Both clickable regions use `cursor-pointer`
- [ ] Add a visible vertical divider between the quick-popup chevron region and the full-chooser region
- [x] Keep the quick picker small and categorized
- [x] Limit the quick picker to recently used models instead of the full catalog
- [ ] Selecting from the quick picker uses the same selected-model contract as the full chooser
- [ ] Web tests cover split hit targets, keyboard/focus behavior, quick-popper contents, and full-chooser opening

### M4: Source detail browsing and large catalog behavior

- [x] Add a host-backed catalog query path with search text, filters, caps, and cursor or pagination support
- [ ] Never send every gateway model to the browser on every `host.online`
- [ ] Support filters for source, provider/family, configured-only, tools, vision, reasoning, local/cloud, context size, recent, pinned, and recommended
- [ ] Virtualize or otherwise bound long model lists in the UI
- [ ] Model rows show capability tags, context size, auth/availability status, catalog freshness, and supported reasoning levels
- [ ] Local source detail shows runtime reachable/unreachable, discovered/manual entries, and loaded/loading/available state when known
- [ ] Gateway and direct-provider source details show catalog loading, stale catalog, fetch failure, and retry states
- [ ] Empty states distinguish no configured models, no search matches, unavailable catalog, and source auth needed
- [ ] Tests cover thousands of models, filtering, pagination/cursoring, stale catalog, and bounded rendering

### M5: Auth, setup, and no-secret UI boundary

- [ ] OAuth subscription sources expose sign-in and re-login actions through host-owned flows
- [ ] Provider-code or device-code flows can show links and accept non-key codes when the provider protocol requires it
- [ ] Direct API keys, env-derived credentials, and provider secrets live in the host auth JSON store
- [ ] The chooser never renders an API-key paste form
- [ ] Direct-provider rows show missing, configured, rejected, stale, and refresh states from the host auth JSON store
- [ ] Source detail can refresh auth/catalog state without blocking browsing other sources
- [ ] Local runtimes expose setup/open-runtime guidance without pretending to own local runtime installation
- [ ] Auth/setup failures remain scoped to that source and do not block browsing or selecting unrelated configured sources
- [ ] Tests cover OAuth signed-in/signed-out/expired, provider-code flow, host auth JSON states, and absence of API-key input fields

### M6: Selection, reasoning, preferences, and execution

- [x] First cut selects one active chat model only
- [ ] Do not add routing, prompt-intent model choice, connectivity-based switching, or provider-failure auto-switching
- [ ] Defer role-specific model assignment for autocomplete ghost text, compaction, summarization, subagents, and background helpers
- [x] Persist active model, default model, recent models, pinned models, and per-model reasoning selection
- [x] Reasoning choices are constrained by the selected model's detected reasoning surface
- [x] Support `off` when the selected model supports disabling reasoning
- [ ] Selecting a model updates both model reference and reasoning preference without losing current sidebar behavior
- [ ] User turn events move toward `{ sourceId, modelId, reasoning }` while preserving legacy provider compatibility during migration
- [x] Tests cover active/default/recent/pinned persistence, reasoning constraints, legacy provider compatibility, and no routing side effects

### M7: Verification

- [ ] Storybook reviewed before live wiring for source overview, source detail, auth states, quick picker, split sidebar control, and responsive widths
- [ ] Web tests cover the main chooser surface, source-detail navigation, responsive container behavior, split-control cursor/divider affordance, and accessibility labels
- [ ] Host tests cover source summaries, catalog queries, auth JSON status projection, catalog freshness, and source-scoped errors
- [ ] Protocol tests cover new source/catalog payloads, legacy provider decode, selected-model persistence, and query result caps
- [ ] Redaction tests prove keys, tokens, auth headers, and raw secret values never render in chooser state or logs
- [ ] Manual EZE repro: open full chooser from the sidebar label area, choose a local model, and verify a normal chat turn uses it
- [ ] Manual EZE repro: open the chevron quick picker and verify it shows only categorized recent models
- [ ] Manual EZE repro: show an OAuth expired source, re-login or provider-code flow, and verify no API-key paste form appears

## Next-Up: provider-outage auto-reconnect recovery

D-076-D-079 are captured in the implementation plan as bounded retry for transient provider outages. This is not
model routing and not provider fallback: Trevor retries the current model step only when the provider failure is
classified retryable and no text, thinking, or tool call has streamed yet. The implementation should use Effect's
typed error channel, structured concurrency, and deterministic schedules; provider adapters normalize inconsistent
OAuth, SDK, gateway, direct API, and local runtime failures into Trevor's taxonomy. Unknown or low-confidence
provider failure shapes are recorded as redacted, deduped observations under `TREVOR_HOME` (default
`~/.trevorV2`) so classifier rules can improve later. Source: `apps/agent-host/src/providers/errors.ts`,
`apps/agent-host/src/providers/error-classifier.ts`, `apps/agent-host/src/providers/pi-ai.ts`,
`apps/agent-host/src/turn.ts`, `apps/agent-host/src/agent/loop.ts`, `packages/session/src/protocol.ts`,
future provider-observation store, and `@effect/vitest` fake-provider tests (D-076-D-079).

### M1: Provider failure taxonomy and typed error contract (D-076-D-077)

- [ ] Replace or extend the retryable boolean with a normalized provider-failure classification where needed
- [ ] Classifications distinguish auth, transient transport, rate limited, provider overloaded, provider unavailable, local runtime unavailable, model unavailable, quota/billing, request rejected, context overflow, and unknown provider failure
- [ ] Each classified failure carries provider/source/model identity, phase, sanitized detail, retry policy, user action, and redacted evidence
- [ ] Keep provider failures in the Effect typed error channel through the provider and agent loop boundary
- [ ] Preserve `ProviderAuthError` and context-overflow behavior as dedicated non-retry paths
- [ ] Unknown or low-confidence provider failures default to non-retryable unless strongly classified otherwise
- [ ] Unit tests cover typed classification for auth, overflow, transient transport, rate limit, local runtime unavailable, gateway upstream unavailable, and unknown failures
- [ ] Unit tests prove raw SDK/API/local errors never leak secrets through the typed error payload

### M2: Provider-boundary normalization

- [ ] Normalize pi-ai stream event errors before they reach the turn loop
- [ ] Normalize thrown SDK errors, event errors, HTTP-like errors, and plain string errors through the same classifier seam
- [ ] Use structured provider fields when available before falling back to sanitized message matching
- [ ] Preserve retry-after, HTTP status, SDK error code/type, provider request id, gateway/upstream source, and local runtime error class when available
- [ ] Codex/OpenAI OAuth failures classify as auth or refresh/sign-in needed, not retryable transport
- [ ] Direct API-key failures classify as missing/rejected/quota/billing/request-rejected where evidence supports it
- [ ] Gateway providers preserve whether the failure came from the gateway or an upstream model provider when known
- [ ] Local providers distinguish runtime unreachable, model not loaded, model load failure, context-window mismatch, and transient stream interruption
- [ ] Tests cover Codex/OAuth, Anthropic-like OAuth, direct API-key, gateway, and local runtime shaped failures using sanitized fixtures

### M3: Effect retry schedule and output-start safety gate

- [ ] Implement retry with Effect schedules or equivalent Effect-native structured concurrency
- [ ] Use a bounded per-step retry budget of three attempts with exponential backoff and jitter
- [ ] Keep retry budget independent of `MAX_STEPS`, overflow recovery budget, and turn queue state
- [ ] Track whether any text, thinking, tool call, or tool execution has started for the failed attempt
- [ ] Retry only when classified retryable and no output/tool activity has started
- [ ] Do not retry after partial text, thinking, tool call, or tool result activity because replay would duplicate work
- [ ] User cancel or fiber interruption bypasses retry and stays instant, including during a backoff sleep
- [ ] Tests use `@effect/vitest` and `TestClock` or equivalent fake time so retry timing is deterministic
- [ ] Tests cover pre-output retry success, exhausted retries, partial-output terminal failure, and cancel during backoff

### M4: User-visible reconnecting events and transcript rendering

- [ ] Emit `assistant.reconnecting` for each retry attempt with run id, attempt number, and sanitized detail
- [ ] Keep reconnecting events correlated with the active run id
- [ ] Flush pending text/thinking buffers before publishing reconnecting status
- [ ] Render reconnecting as a live status marker in the transcript or turn surface
- [ ] Terminal error block remains unchanged when retry budget is exhausted or the failure is non-retryable
- [ ] Do not emit reconnecting for auth failures, context overflow, user cancel, or unknown non-retryable failures
- [ ] Web tests cover reconnecting rendering, multiple attempts, exhausted retry, non-retryable terminal error, and cancellation

### M5: Redacted provider observation store

- [ ] Add a provider-failure observation store under `TREVOR_HOME` defaulting to `~/.trevorV2`
- [ ] Store unknown or low-confidence provider failure shapes as redacted, deduped observations
- [ ] Observation records include provider/source/model, auth mode, phase, status/code fields, sanitized message, top-level shape/field names, output-started flag, classifier verdict, retry decision, and fingerprint
- [ ] Deduplicate observations by stable fingerprint and track first seen, last seen, and count
- [ ] Do not store prompts, API keys, auth headers, raw response bodies, raw tool outputs, or raw provider payloads by default
- [ ] Observation writes are best effort and never fail the user turn
- [ ] `/doctor` or debug detail can report counts and fingerprints for unclassified provider observations without exposing secrets
- [ ] Tests cover redaction, dedupe, best-effort write failure, and `TREVOR_HOME` path override behavior

### M6: Doctor/debug surfaces and boundary observability

- [ ] Provider adapters expose inspectable debug info for last classified failure without leaking secrets
- [ ] Structured logs record provider failure classification, retry decision, attempt number, source/model, phase, and fingerprint
- [ ] Debug logs can include richer sanitized shape metadata behind a verbose provider/debug scope
- [ ] `/doctor` distinguishes provider auth failure, internet reachability, provider outage, local runtime status, and unknown provider failure shapes
- [ ] `/doctor` shows retry exhaustion separately from non-retryable terminal provider failures
- [ ] Observation diagnostics are available on demand and are never injected into normal model prompts automatically
- [ ] Tests cover doctor/debug output redaction, retry exhaustion reporting, and unknown-shape counts

### M7: Verification

- [ ] Fake provider fails N times before first token and then succeeds without user resend
- [ ] Fake provider fails after first text/thinking/tool call and does not retry
- [ ] Fake provider auth failure surfaces re-auth/actionable failure without retry
- [ ] Fake provider context overflow still follows overflow recovery and does not use outage retry
- [ ] Fake provider rate-limit or transient outage exhausts retry budget and surfaces a terminal error
- [ ] Local-provider unreachable/runtime-not-running case is classified and observed without pretending it is an internet outage
- [ ] Redaction tests prove prompts, keys, tokens, auth headers, and raw bodies do not enter logs, events, or observation records
- [ ] Manual EZE repro: simulate a pre-output transient stream drop and verify reconnecting status plus automatic recovery
- [ ] Manual EZE repro: simulate a new unknown provider error shape and verify a redacted observation appears under `~/.trevorV2`

## Next-Up: doctor health surface

D-073 is captured in the implementation plan as a structured V1-inspired `/doctor` health surface. `/doctor`
remains a host-owned immediate command with no model turn, but the default result should become a health and
repair dashboard rather than a raw debug dump. It should answer what is healthy, degraded, or broken; what
evidence supports that; and what the user can do next. Raw internals remain available only through debug/detail
surfaces such as full/json/detail output. Source: `apps/agent-host/src/commands.ts`,
`apps/agent-host/src/main.ts`, `apps/web/src/commands/doctor.ts`,
`apps/web/src/components/chat/doctor/*`, provider debug info, session/run diagnostics, D-060 internet status,
D-065 source/auth/catalog state, D-076 provider-failure observations, and Storybook `doctor.current` fixtures
(D-073).

### M1: Snapshot schema and host command contract (D-073)

- [x] Define a structured `doctor.current` snapshot schema with summary, areas, findings, evidence, next actions, timestamps, and stale/loading state
- [x] Keep `/doctor` as a host-owned immediate command with no model turn
- [x] Keep `/doctor` distinct from `host.debugInfo`: doctor is health and repair guidance, debug info is sanitized runtime internals
- [x] Use stable area ids, finding ids, status values, severities, labels, and next-action kinds
- [x] Include source paths or local paths only when relevant and sanitized
- [x] Add command variants or actions for refresh, full/detail, JSON view, copy report, and relevant settings/details
- [x] Default `/doctor` output omits raw provider structs, lease timestamps, low-level reload flags, raw auth state, and internal token caps unless directly needed for a finding
- [x] Tests cover schema decode, stable ids, no model turn, command variants, default-vs-full output, and command-result compatibility

### M2: Diagnostic area coverage

- [x] Add Core area summary for app/host version, protocol skew, process health, and basic runtime readiness
- [x] Add Session/Run area summary for active run, queue, last termination reason, step limit, no-reply, overflow, and cancellation state
- [x] Add Providers/Models/Auth area summary for source status, selected model, auth missing/expired/rejected, catalog freshness, local runtime readiness, and provider retry exhaustion
- [x] Add Internet area summary from D-060 host-owned public-internet status and last probe details
- [x] Add Tools/Search area summary for core tool availability, `rg`, `ast_grep`, web search/fetch/docs dependencies, and tool failures when known
- [x] Add Web/Docs area summary for docs cache, web fetch/rendering availability, Jina/Firecrawl configuration, and stale corpora
- [x] Add MCP, LSP, and Hooks areas with unconfigured, unavailable, auth-needed, error, and timeout states
- [x] Add Storage/Roots area for `TREVOR_HOME`, local state/cache/share roots, writeability, migration debt, and observation-store status
- [x] Add Workspace area for cwd, git/worktree status, AGENTS context, managed worktrees, locks, and non-git states
- [x] Add Updates/Version area for package/build/version/update facts when available
- [x] Tests cover severity aggregation and at least one finding in each area

### M3: Bounded checks and redaction

- [x] Every live probe has a short per-check timeout and an overall `/doctor` budget
- [x] Slow probes degrade to `timeout` or `not_checked` with a next action instead of blocking the command
- [x] Reuse cached state when cached state is authoritative
- [x] `/doctor` does not run repairs, mutate config, load models, refresh OAuth, or rewrite local state unless a later explicit action is added
- [x] Redact API keys, OAuth tokens, auth headers, raw provider payloads, raw prompt text, raw tool outputs, and unbounded response bodies
- [x] Paths are abbreviated or sanitized where full paths are not needed
- [x] Findings include enough evidence to debug without leaking secrets
- [x] Tests cover redaction, timeout behavior, stale snapshot behavior, no mutation, and bounded overall runtime

### M4: Storybook-first dashboard surface

- [x] Build or verify the Trevor web diagnostic dashboard in Storybook before live wiring
- [x] Render `/doctor` as a dashboard, not terminal-shaped text
- [x] Include summary strip, severity filters, category/area layout, repeated findings, status icons, key-value rows, next actions, and expandable evidence/details
- [ ] Avoid nested cards and oversized hero treatment
- [ ] Support mobile one-column layout and desktop multi-column or dense responsive layout
- [ ] Use container/responsive behavior so long paths, labels, and evidence do not overflow
- [ ] Storybook states cover all-ok, mixed warnings/errors, many findings, all not-checked, loading/refreshing, stale snapshot, long paths, mobile, tablet, and desktop widths
- [ ] Storybook states cover provider auth missing, local runtime unreachable, cloud unreachable, internet disconnected, MCP auth-needed/error, LSP missing/diagnostic warning, hooks slow/trust changed, docs stale, storage root invalid, and workspace not Git
- [ ] Visual review verifies errors, warnings, and next actions stay visible at narrow and wide widths

### M5: Live web wiring and transcript behavior

- [x] Convert `doctor.current` command results into the structured dashboard renderer
- [x] Preserve command-result history and transcript ordering for `/doctor`
- [ ] `/doctor refresh` or refresh action updates the snapshot without starting a model turn
- [ ] Copy report and view JSON actions use sanitized structured data
- [x] Expanded details stay local to the doctor result and do not inject raw diagnostics into model prompt history
- [ ] Accessibility labels cover summary, filters, areas, findings, next actions, expand/collapse, refresh, copy, and JSON actions
- [x] Web tests cover rendering, filtering, refresh, copy report, JSON view, expand/collapse, transcript placement, and accessibility labels

### M6: Prompt/model guidance and diagnostics usage

- [ ] Model guidance treats `/doctor` output as host diagnostics when the user asks about Trevor health, setup, provider readiness, tool availability, or why a turn failed
- [ ] The model does not call `/doctor` as routine context gathering for ordinary coding work
- [ ] Doctor output can explain provider auth/catalog issues from D-065 without exposing secrets
- [ ] Doctor output can explain internet status from D-060 without conflating it with host/session connectivity
- [ ] Doctor output can explain provider-outage retry exhaustion and unknown provider observation counts from D-076
- [ ] Doctor output can explain archived/stale/inactive session states from D-093/D-094 when available
- [ ] Tests or evals cover model guidance, no routine doctor calls, and correct distinction between health areas

### M7: Verification

- [x] Host tests cover snapshot construction, area aggregation, bounded probes, no model turn, redaction, and command variants
- [ ] Web tests cover dashboard rendering, responsive behavior, severity filters, next actions, details, copy/JSON, and accessibility
- [ ] Storybook reviewed for every required state before live app wiring is considered complete
- [ ] Manual EZE repro: run `/doctor` with all-ok fixtures/state and verify concise healthy dashboard
- [ ] Manual EZE repro: simulate provider auth missing, internet offline, local runtime unavailable, and unknown provider observations, then verify actionable findings
- [ ] Manual EZE repro: verify `/doctor full` or JSON/detail view exposes sanitized evidence while default view stays readable
- [ ] Manual EZE repro: verify `/doctor` never triggers a model turn and does not mutate config or local state

## Next-Up: discovery registry + progressive skill drill-in

D-075 is captured in the implementation plan as a host-owned discovery protocol for skills first, later
extensible to slash commands, command families, and agents. The first cut keeps ambient skill awareness so the
model knows skills exist, but moves full skill bodies behind explicit drill-in tools. Source:
skill discovery roots from D-087, existing skill loading/parsing behavior, shell interpolation support,
agent/delegate skill validation, future `skills_list(query?, limit?)`, future `skill_view(skillId)`, and
registry-derived capability manifest D-074.

### M1: Skill registry source of truth

- [x] Define the host-owned skill registry read model for skill id, name, description, triggers, source path, root kind, status, and provenance
- [x] Read skills from the D-087 project-local, global, and configured root order
- [x] Preserve selected versus shadowed skill provenance when duplicate skill ids exist
- [x] Represent disabled, malformed, missing, and truncated skills explicitly instead of silently dropping them
- [x] Preserve existing skill body parsing and shell interpolation behavior unless intentionally superseded by this registry
- [x] Do not let Trevor web scan the filesystem or invent its own skill inventory
- [x] Unit tests cover root ordering, duplicate ids, disabled skills, malformed skills, and provenance fields
- [x] Unit tests prove registry output changes when source skill metadata changes

### M2: Compact ambient skill roster

- [x] Build a compact `Available skills` roster from the registry for tool-enabled turns
- [x] Include skill id, short description, and optional trigger summary in the ambient roster
- [x] Keep the ambient roster capped and budgeted
- [x] Mark roster truncation explicitly with counts or continuation metadata
- [x] Ensure the model can know relevant skills exist without loading full skill bodies
- [x] Do not put full skill bodies or huge dynamic inventories into normal prompts
- [x] Prompt tests cover relevant-skill awareness from the compact roster
- [x] Prompt tests cover truncated roster behavior without speculative all-skill loading

### M3: `skills_list` searchable metadata tool

- [x] Add `skills_list(query?, limit?)` over compact registry metadata
- [x] Return ids, descriptions, trigger summaries, source/provenance, status, match counts, and truncation metadata
- [x] Search across id, name, description, trigger summary, and relevant metadata fields
- [x] Enforce default and maximum limits so list results cannot bloat prompt context
- [x] Keep `skills_list` read-only and UI-agnostic
- [x] Handle empty query, no matches, disabled-only matches, malformed entries, and truncated matches clearly
- [x] Tests cover search ranking, limits, truncation, disabled/malformed entries, and no full-body return
- [x] Tests cover non-web clients calling `skills_list` without Trevor web involvement

### M4: `skill_view` full-body drill-in tool

- [x] Add `skill_view(skillId)` for loading exactly one selected skill body
- [x] Include full body, metadata, source/provenance, selected/shadowed status, and parse diagnostics when available
- [x] Reject unknown skill ids with a structured not-found result
- [x] Reject or clearly mark disabled skills without pretending they are usable
- [x] Do not auto-load neighboring, related, or all matching skill bodies
- [x] Preserve existing security and trust gates for shell interpolation inside skill bodies
- [x] Tests cover one-body loading, unknown id, disabled id, shadowed provenance, parse diagnostics, and interpolation gating

### M5: Prompt guidance and model behavior

- [x] Tell the model to call `skill_view` when a visible skill clearly matches the user request
- [x] Tell the model to call `skills_list(query)` when the compact roster is missing, truncated, too broad, or insufficient
- [x] Tell the model to load only the specific skill intended for use
- [x] Tell the model not to call `skill_view` for every listed skill
- [ ] Tell the model not to treat skills as mandatory when ordinary repository context and tools are enough
- [ ] Evals cover a relevant listed skill being opened exactly once
- [ ] Evals cover ordinary coding work proceeding without unnecessary skill loading

### M6: Compatibility and future registry shape

- [x] Keep the existing `skill(name)` tool temporarily as an alias or compatibility shim if needed
- [ ] Define migration behavior from `skill(name)` to `skills_list` plus `skill_view`
- [x] Shape registry records so slash commands, command families, and agents can join later without changing the skill contract
- [x] Do not include slash-command, command-family, or agent discovery in the first implementation slice
- [x] Expose the skill registry in a way D-074 capability manifests and `trevor-expert` can consume deterministically
- [x] Tests cover compatibility alias behavior or its intentional removal
- [x] Tests prove future resource-type fields do not leak bogus command or agent rows into the skills-only first cut

### M7: UI and verification

- [ ] If Trevor web renders skill discovery, build the discovery/list/detail states in Storybook before live wiring
- [ ] UI renders from host read models only
- [ ] Storybook covers compact roster, list search, no matches, disabled/malformed skills, truncated results, selected skill detail, and long descriptions
- [ ] Web tests cover read-model rendering without filesystem scans if a web surface is added
- [ ] Manual EZE repro: ask for a task matching a visible skill and verify the model opens only that skill
- [ ] Manual EZE repro: ask about an unclear skill area and verify the model searches metadata before viewing one skill

## Summary
- Archived completed checklist detail: [progress-report-done.md](./progress-report-done.md)
- Shipped (archived): D-044 session recall - 38 features, 37 completed, 1 gated manual EZE repro
- Live open follow-up (D-092 image attachment UX): 53 features, 51 completed, 2 remaining (manual EZE repros)
- Live open follow-up (D-060 internet connectivity awareness): 40 features, 38 completed, 2 remaining (explicit-UI-refresh wiring, manual EZE repro)
- Live open follow-up (D-093 session navigation sidebar): 39 features, 22 completed, 17 remaining (M1 surface + M2 scope + M3 recency)
- Live open follow-up (D-094 session lifecycle controls): 38 features, 25 completed, 13 remaining (M1 semantics; M2 archive; M3 CLI complete)
- Live open follow-up (D-065 provider auth/catalog + full model chooser): 62 features, 17 completed, 45 remaining
- Live open follow-up (D-076-D-079 provider-outage auto-reconnect recovery): 57 features, 0 completed, 57 remaining
- Live open follow-up (D-073 doctor health surface): 57 features, 35 completed, 22 remaining
- Live open follow-up (D-075 discovery registry + progressive skill drill-in): 51 features, 41 completed, 10 remaining
- Partial/gated carry-forward from archived D-088-D-091 and D-044: 5 items
- Remaining implementable work in this report: 168 unchecked items plus 5 partial/gated carry-forward items
