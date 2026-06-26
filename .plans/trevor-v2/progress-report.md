# Trevor V2 - Progress Report

> Canonical source of truth for the active open checklist. Completed checklist detail lives in
> [progress-report-done.md](./progress-report-done.md) so routine planning turns do not need to load
> every checked item.

> **Scope.** This report tracks open or partial/gated work only. When an item or section is fully
> completed, move its detailed checklist to the done archive and leave only a summary/reference here.
> Current focus: D-044 session recall, D-092 image attachment UX, and D-060 internet connectivity
> awareness. Later roadmap items stay sequenced in the canonical implementation plan and are decomposed
> here only when picked up.

## Archived Completed Work

Completed checklist detail for Phase 1 through Phase 8, D-083-D-087, and the completed D-088-D-091
work is archived in [progress-report-done.md](./progress-report-done.md).

## Carry-Forward: partial/gated archived items

These rows remain visible because they are not fully completed, even though their surrounding feature checklists are archived.

- [~] D-088 sidebar git identity: live EZE repro for dirty file, ahead/behind branch, detached HEAD, and non-git cwd remains gated
- [~] D-090 explicit resume: launcher/supervisor spawning or reusing a matching host for a selected no-host session remains gated
- [~] D-091 managed worktrees: dedicated cwd-path advisory lock remains deferred beyond the existing per-session lock
- [~] D-091 managed worktrees: live two-host worktree smoke remains gated

## Next-Up: session recall

D-044 is captured in the implementation plan as model-decided recall over older project/session conversation
memory that is not already in the active prompt. "Session recall" keeps its name, but the scope is the current
project's durable session corpus: compacted-away detail in the current durable session plus other durable
sessions for the same project/workspace. It is not a slash command, not ambient memory, and not codebase search.
Source: `apps/agent-host/src/agent/compactor.ts`, `apps/agent-host/src/agent/history-projection.ts`,
session-store/Richter session APIs, future session inventory/project mapping, future recall tool and transcript
result component (D-044).

### M1: Recallable corpus and source metadata (D-044)

- [ ] Define the recallable record model for compacted-away current-session spans and other project sessions
- [ ] Use the launcher/resume project identity so "same project" means the same canonical root/workspace mapping
- [ ] Exclude recent turns that are already present in the active prompt projection
- [ ] Read compaction fold manifests as anchors for current-session compacted-away detail
- [ ] Read durable session summaries/events for other sessions in the same project without loading them into the active session
- [ ] Attach stable source pointers: session id/label, workspace/project, turn id or event range, timestamp, excerpt, score, and neighborhood bounds
- [ ] Treat missing, stale, corrupt, or inaccessible sessions as visible partial-search diagnostics, not silent absence

### M2: BM25 search and filters

- [ ] Build an on-demand lexical BM25 index over recallable conversation records, with no embeddings in the first cut
- [ ] Support structured filters for project/session, turn range, event type, tool name, and folded-span id
- [ ] Search compacted-away current-session detail and other same-project sessions in one query path
- [ ] Rank, cap, and deduplicate anchors so repeated excerpts from the same neighborhood do not dominate
- [ ] Return anchors with match score, source pointer, excerpt, and enough context keys for neighborhood expansion
- [ ] Unit tests cover ranking, filtering, dedupe, no-hit behavior, and exclusion of active-prompt turns

### M3: Neighborhood expansion and isolated recall subagent

- [ ] Expand each search anchor into a bounded neighborhood of surrounding turns/events
- [ ] Cap per-neighborhood size and total recall context so one long session cannot exhaust the recall budget
- [ ] Run the reasoning pass in an isolated subagent with its own context budget
- [ ] Give the recall subagent read-only access to recall neighborhoods and source metadata only
- [ ] Return distilled findings with citations instead of dumping raw neighborhoods into the main turn
- [ ] Tests cover anchor-to-neighborhood expansion, budget caps, citation preservation, and no mutation of the current durable session

### M4: Model-facing tool contract

- [ ] Add a `session_recall` model-facing tool with query, optional filters, and result caps
- [ ] Do not add a slash command in the first cut
- [ ] Add prompt/tool guidance so the model uses recall only when the user asks for older project/session memory
- [ ] Tool result includes query, searched-session count, searched-fold count, anchor count, neighborhood count, cited findings, and diagnostics
- [ ] Typed outcomes distinguish no hits, partial search, unavailable inventory, invalid filters, and internal failure
- [ ] Ambient/proactive remembering remains deferred and cannot inject recall results without a model tool call

### M5: Visible transcript rendering, Storybook first

- [ ] Build a Storybook-first `Session recall` result surface before live wiring
- [ ] Render the recall use visibly in the transcript as a tool/result, not hidden reasoning
- [ ] Show a compact activity summary such as sessions searched, folded spans searched, and neighborhoods found
- [ ] Show collapsed or compact source rows/snippets with session label, timestamp, and short excerpt
- [ ] Storybook states cover searching, no hits, one hit, multiple sessions, partial search, stale session, and error
- [ ] The first cut does not add a separate recall browser, drawer, modal, or global search UI
- [ ] Web tests cover result rendering, collapsed snippets, accessibility labels, and long-session/long-excerpt truncation

### M6: Verification

- [ ] Tests prove recall searches compacted-away current-session detail but not active-prompt recent turns
- [ ] Tests prove recall searches other sessions for the same project and excludes unrelated projects
- [ ] Tests prove no `/resume`/session switch or transcript merge occurs while searching other sessions
- [ ] Tests prove citations point back to stable session/event ranges
- [ ] Tests prove no slash command is registered for recall
- [ ] Manual EZE repro: ask a memory question whose answer exists only in compacted-away or sibling-session history, and the visible `Session recall` result appears before the final answer

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

- [ ] Build Storybook fixtures for image-token composer states before live wiring
- [ ] Render `[Image #N]` ranges with attachment-token syntax highlighting while keeping normal text-composer behavior
- [ ] Use an overlay or mirror layer so token highlighting and hover/focus targets exist without replacing the textarea with a rich editor
- [ ] Stories cover token between words, token at start, token at end, multiple tokens, long prompt wrapping, upload in progress, upload error, and broken/unavailable preview
- [ ] Token hover/focus preview story shows the image at max 300px wide and 300px tall with preserved aspect ratio
- [ ] Storybook includes narrow/mobile and desktop composer widths so token highlighting tracks wrapping
- [ ] Stories use production `ArtifactRef` fixtures and `artifactSrc`-compatible image URLs, not story-only fake markup

### M2: Token placement model and editing behavior

- [ ] Define the draft attachment model that pairs visible `[Image #N]` tokens with uploaded `ArtifactRef`s
- [ ] Insert image tokens at the current cursor or selection replacement point
- [ ] Auto-add leading/trailing spaces so inserted tokens do not stick to adjacent words
- [ ] Multiple-image paste/drop inserts ordered tokens and refs deterministically
- [ ] Backspace next to a token removes the whole token and its artifact ref in one step
- [ ] Delete next to a token removes the whole token and its artifact ref in one step
- [ ] Removing a token keeps remaining text, refs, and displayed token numbers synchronized in reading order
- [ ] Tests cover insertion at start/middle/end, selection replacement, auto spacing, multi-image insertion, and one-step deletion

### M3: Image intake, Cmd+V, and queue preservation

- [ ] Cmd+V image paste reads clipboard image files and inserts tokens at the cursor reliably
- [ ] File picker inserts tokens at the cursor after upload succeeds or shows a pending token state while upload is in flight
- [ ] Drag/drop uploads images and inserts tokens at the current or last-known composer cursor position
- [ ] Non-image files keep the existing file/document attachment behavior unless explicitly upgraded later
- [ ] Shell mode leaves image tokens/attachments in the composer and never silently drops them
- [ ] Queued prompts render the same `[Image #N]` text tokens and carry the matching artifact refs while waiting
- [ ] Hard steer preserves queued token text and image refs together when collapsing the queue and draft
- [ ] Tests cover Cmd+V paste, picker, drop, queued rendering, shell-mode preservation, and hard-steer preservation

### M4: Transcript image layout

- [ ] Submitted user messages preserve `[Image #N]` token positions in the visible text
- [ ] Images render in the same user transcript item as the submitted prompt
- [ ] Images render at natural dimensions until constrained by story-approved responsive max width and max height
- [ ] Images are contained, not cropped, and preserve original aspect ratio
- [ ] Multiple images in one user message form one image set for layout and carousel behavior
- [ ] Broken, missing, non-renderable, and non-image artifacts degrade to a file/link row without a broken image icon
- [ ] Storybook states cover tiny, wide, tall, large, multiple images, long text with tokens, attachments-only prompt, and broken image
- [ ] Web tests cover sizing classes/styles, image set grouping, token text preservation, and fallback rows

### M5: Same-message image carousel

- [ ] Clicking any transcript image opens a centered dialog carousel for only the images in that user message
- [ ] The dialog is large enough for inspection but not full screen
- [ ] Carousel image sizing is responsive and preserves aspect ratio
- [ ] Previous/next controls cycle through images in submitted order
- [ ] Keyboard navigation supports ArrowLeft, ArrowRight, and Escape
- [ ] Dialog shows image count/index and accessible image labels
- [ ] Storybook states cover one image, many images, wide image, tall image, broken image, and narrow viewport
- [ ] Web tests cover open, close, previous/next, keyboard navigation, and same-message scoping

### M6: Provider projection and protocol compatibility

- [ ] Keep `ArtifactRef` as the durable blob reference; do not inline bytes into Richter events
- [ ] Preserve old `user.message.artifacts` decode compatibility for sessions without placement metadata
- [ ] Strip `[Image #N]` tokens from provider text when sending images as model image blocks
- [ ] Preserve image order from token reading order when resolving image blocks
- [ ] Where provider APIs support interleaved content blocks, project text/image order as closely as possible
- [ ] Where provider APIs only support text plus image list, strip tokens from text and send images in token order
- [ ] Non-vision providers receive a clear attachment note instead of literal token clutter
- [ ] Tests cover old-event decode, provider text stripping, token-order image resolution, non-vision notes, and attachments-only prompts

### M7: Verification

- [ ] Storybook reviewed before live app wiring for composer tokens, hover preview, queued prompt, transcript layout, and carousel
- [ ] Unit tests cover token parser/editor behavior and placement-to-artifact synchronization
- [ ] Web tests cover composer rendering, hover preview, queue rendering, transcript image layout, and carousel controls
- [ ] Host tests cover provider projection over tokenized image prompts
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

- [ ] Define the internet snapshot as `online`, `offline`, or `unknown`, plus a transient `checking` flag while a probe is in flight
- [ ] Make the host machine the source of truth for public-internet reachability
- [ ] Treat browser `navigator.onLine` only as a possible UI comparison/debug hint, never as the host status
- [ ] Probe with a small DNS plus HTTPS check against configured public endpoints
- [ ] Treat LAN-up/WAN-down and captive-portal-like failures as `offline` when the public probe fails
- [ ] Use `unknown` for no probe yet, disabled/misconfigured probe, or inconclusive probe results
- [ ] Keep provider auth, provider rate limits, provider overload, model availability, and provider request failures out of this status
- [ ] Store last checked time, snapshot age/staleness, sanitized last error, and probe target class

### M2: Refresh cadence and protocol

- [ ] Probe on host startup and publish the first snapshot when available
- [ ] Cache ordinary probe results for about 30 seconds to avoid constant network checks
- [ ] Allow an explicit UI refresh action that starts a new probe and exposes `checking`
- [ ] Optionally start an async refresh before a cloud turn when the snapshot is stale
- [ ] Never block a turn on internet-status refresh
- [ ] Include the latest internet snapshot on `host.online`
- [ ] Emit a small `host.internet` event on `checking` start, status change, and refresh completion
- [ ] Keep internet-status events out of conversation memory and prompt history projection

### M3: Advisory UI and Storybook states

- [ ] Build the internet-status UI Storybook-first before app wiring
- [ ] Place the compact advisory near the model/source area, where cloud-vs-local expectation is visible
- [ ] Keep the internet advisory visually distinct from host presence and session-store/WebSocket connection state
- [ ] When a cloud model is selected and the host is offline, show a warning without disabling submit or changing model selection
- [ ] When a local model is selected and the host is offline, keep the state neutral/advisory because local turns are unaffected
- [ ] Storybook states cover online, offline, unknown, checking, stale, and refresh failure
- [ ] Storybook states cover host disconnected, browser offline while host is online/unknown, cloud model selected while offline, and local model selected while offline
- [ ] The model/source chooser can show stale status and a refresh action without turning the chooser into a connectivity dashboard
- [ ] Web tests cover advisory placement, labels, cloud/offline warning, local/offline non-blocking state, and stale/checking rendering

### M4: Doctor and logging surface

- [ ] `/doctor` reports internet status, checking state, last checked time, and snapshot age/staleness
- [ ] `/doctor` reports DNS/HTTPS probe class and sanitized last error
- [ ] `/doctor` omits credentials, auth headers, full request payloads, and any sensitive endpoint material
- [ ] `/doctor` never reports a fallback target because D-060 has no fallback behavior
- [ ] Host logs use structured, redacted probe fields for status changes and probe failures
- [ ] `/doctor` distinguishes internet reachability from host presence, session-store connectivity, and provider health

### M5: No routing side effects and verification

- [ ] A selected local model remains local regardless of internet status
- [ ] A selected cloud model remains cloud regardless of internet status
- [ ] Cloud request failures do not trigger a local retry or change the selected model
- [ ] Offline status does not emit or imply `assistant.providerFallback`
- [ ] Local session-store or Richter disconnects do not imply internet offline
- [ ] Tests cover browser `navigator.onLine` disagreeing with the host probe
- [ ] Tests cover `checking`, stale snapshots, manual refresh, `host.online`, and `host.internet`
- [ ] Web tests cover the Storybook-backed advisory states and cloud/local selected-model differences
- [ ] Manual EZE repro: simulate LAN-up/WAN-down or failed public probes, verify advisory UI and `/doctor`, and verify local/cloud model selection is unchanged

## Summary
- Archived completed checklist detail: [progress-report-done.md](./progress-report-done.md)
- Live open follow-up (D-044 session recall): 38 features, 0 completed, 38 remaining
- Live open follow-up (D-092 image attachment UX): 53 features, 0 completed, 53 remaining
- Live open follow-up (D-060 internet connectivity awareness): 40 features, 0 completed, 40 remaining
- Partial/gated carry-forward from archived D-088-D-091: 4 items
- Remaining implementable work in this report: 131 unchecked items plus 4 partial/gated carry-forward items
