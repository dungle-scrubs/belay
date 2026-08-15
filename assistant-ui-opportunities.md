# Assistant-UI Opportunities for Belay

Plan `58.6-assistant-ui-pattern-audit` research deliverable. Research only: nothing in this
report changes code. Date: 2026-07-10.

## 1. Overview and how to read this report

This report audits every assistant-ui documentation surface (`llms.txt`) against Belay's
existing architecture and answers, case by case, whether Belay should adopt, adapt, keep its
own implementation, defer, or reject each pattern. There is deliberately **no library-wide
yes/no** (D-003): Belay already vendors several assistant-ui presentational components and
rejects the runtime family outright, and both of those are correct simultaneously.

Hard constraints inherited from the plan:

- **D-001**: plan 58.4 owns assistant-ui thread virtualization adoption. 58.4 has since shipped
  (Belay-owned virtual transcript, commit `ed835a97`). This report makes no virtualization
  recommendation; it only records non-virtualization performance lessons from the
  virtualization docs and routes scroll-owner decisions to the virtual-transcript surface.
- **D-002**: Belay's durable session log, Tether transport, host turn loop, model selection,
  artifact storage, tools, tangents, and transcript projection remain the source of truth.
  Migration/adapter work may be recommended for later; never implemented here.
- **D-003**: decisions are case by case.
- **Hard reject**: Assistant Cloud and hosted multi-user auth are rejected for Belay core
  (local-first, single-operator, state under `~/.local/state/belay`).

Verdict vocabulary (each pattern has exactly one):

| Verdict | Meaning |
|---|---|
| `adopt` | Take the assistant-ui artifact or policy as-is (already done or trivially safe) |
| `adapt` | Borrow the pattern/technique, implement Belay-owned; do not import runtime coupling |
| `keep-belay-owned` | Belay's equivalent is equal or stronger; keep it |
| `defer` | Credible future value; blocked on a stated condition |
| `reject` | Architectural conflict; reason of record given so it is not reopened |

The matrix (section 2) has 107 rows in 7 families: 4 adopt, 14 adapt, 36 keep-belay-owned,
27 defer, 26 reject. Every row cites at least one assistant-ui source and one Belay source
(or an explicit no-current-surface finding). A source-verification pass ran against the live
repo; where it contradicted the original research, **the observed source truth wins** and the
row carries a `[V#]` marker resolved in section 7.1.

A structural finding that recurs across families: `apps/web/src/components/assistant-ui/thread.tsx`
(544 lines) is a maintained-but-unwired copy of the full runtime-coupled surface (zero
importers). It quarantines every primitive Belay evaluated and declined to mount, and it
doubles as an in-repo reference implementation (e.g. the `content-visibility` intrinsic-size
estimates in row A5). The live app mounts **no** assistant-ui runtime: the complete live
`@assistant-ui/react` surface is one runtime hook (`useScrollLock` in
`apps/web/src/components/chat/hooks/use-collapsible-disclosure.ts:3`), two type-only imports,
and one idle-preloaded never-rendered markdown chunk (see rows D1, G9).

## 2. Full audit matrix

Verify-correction markers: `[V1]`-`[V7]`, detailed in section 7.1. Confidence shown is the
post-verification value.

### Family A - Thread and thread list

| # | Pattern | assistant-ui source | Belay equivalent | Verdict | Perf note | Conf | Contrarian question |
|---|---|---|---|---|---|---|---|
| A1 | ThreadPrimitive Root/Viewport/ViewportFooter (scroll anchor, `turnAnchor="top"`, footer height registration) | `docs/primitives/thread` | `apps/web/src/components/chat/virtual-transcript.tsx` + scroll isolation (8f8497ea); 58.4 owns scroll | defer | Footer-height registration could stop sticky-composer/scroll fights on long turns; must be measured inside the virtual-transcript owner surface | high | For multi-screen turns, is bottom-snap worse reading UX than top-anchor; should the 58.4 surface A/B it? |
| A2 | ThreadPrimitive.Messages / MessageByIndex / Unstable_MessageById + unstable_useThreadMessageIds (id-keyed random access) | `docs/primitives/thread` | `apps/web/src/transcript.ts:1270` projector + row windowing | defer | n/a (virtualization perf is 58.4's scope per D-001) | high | n/a |
| A3 | ThreadPrimitive.Suggestions iterators | `docs/primitives/thread` | none - no starter-suggestion product | defer | n/a | high | n/a |
| A4 | ThreadPrimitive.ScrollToBottom (self-disables at bottom) | `docs/primitives/thread` | virtual-transcript scroll container | defer | Self-disabling avoids redundant scrollTo calls; value is UX not perf | medium | n/a |
| A5 | Viewport paint-skipping: CSS `content-visibility:auto` + `contain-intrinsic-size` (non-virtual perf lesson) `[V1]` | `docs/guides/virtualization` | No content-visibility in any LIVE path; dead `assistant-ui/thread.tsx:317/:446` carries a vendored reference impl with per-kind estimates (24px text / 60px user turns) | adapt | Applying to non-anchor row wrappers in virtual-transcript/transcript-row-view skips paint/layout for off-screen rows; smoother scroll on many/tall-row sessions | high | Do variable-height rows (diffs, tool output, reasoning) have stable enough intrinsic-size estimates to avoid visible scroll jumps? |
| A6 | components-prop memoization guidance (module-scope component objects) | `docs/ui/thread` | Already practiced: TranscriptRowView memo + rowConfig identity (`app.tsx:1492-1507`, efaeb708/ef395b2f) | keep-belay-owned | Already realized; memo skips untouched rows | high | n/a |
| A7 | Prebuilt `<Thread />` batteries-included component | `docs/ui/thread` | Live transcript composition; `assistant-ui/thread.tsx` dead | reject | n/a - architectural reject | high | Reason of record: requires AssistantRuntimeProvider as message source of truth (D-002 violation); Belay row kinds (compaction, delegation, shell, hook, limits, Lucid, question) have no part type |
| A8 | ThreadListPrimitive (active/archived split, LoadMore cursor dedupe) | `docs/primitives/thread-list` | cwd-scoped sidebar inventory (D-090 resume scope) | keep-belay-owned | LoadMore pagination only matters at per-cwd session counts Belay does not reach | high | n/a |
| A9 | ThreadListItemPrimitive (aria-current, fallback title, capability auto-disable) | `docs/primitives/thread-list` | sidebar right-click rename/archive/soft-delete menu | keep-belay-owned | n/a | high | n/a |
| A10 | ThreadListItemMorePrimitive (sharedFocusGroup: overflow menu joins list arrow-key nav) | `docs/primitives/thread-list` | right-click-only context menu; no keyboard path | adapt | n/a - accessibility/keyboard quality | medium | Is a keyboard-navigable overflow menu worth building when power users drive the sidebar via the command palette? |
| A11 | Prebuilt `<ThreadList />` / `<ThreadListSidebar />` | `docs/ui/thread-list` | Belay sidebar over local session inventory | reject | n/a | high | Reason of record: requires the assistant-ui runtime as session-list source of truth (D-002); soft-delete/resume semantics do not map to active/archived |
| A12 | useThreadRuntime subscribe/getState (subscription store) | `docs/api-reference/runtimes/thread-runtime` | `use-session.ts:270` replay-then-tail + `transcript.ts:1270` projector | keep-belay-owned | Belay already buffers replay into one commit and batches tail per frame; no documented advantage, lacks durable-log semantics | high | n/a |
| A13 | useThreadListRuntime (generateTitle, updateCustom) | `docs/api-reference/runtimes/thread-list-runtime` | session inventory; no LLM auto-title | keep-belay-owned | n/a | medium | Would host-side LLM session auto-titling (Belay-owned) improve sidebar scannability enough for its own small plan? |
| A14 | localId/remoteId + ThreadHistoryAdapter / RemoteThreadListAdapter / ExternalStoreThreadListAdapter | `docs/runtimes/concepts/threads` | `packages/session/src/transport.ts:7` + `apps/web/src/session/projection.ts:35` | defer | n/a - protocol/architecture study | medium | Could ExternalStoreThreadListAdapter mirror Belay's read model so primitives become available while the durable log stays sole source of truth - and is that mirror cheaper than bespoke rows? |
| A15 | ThreadList pagination + reload semantics (nextCursor, in-flight dedupe) | `docs/runtimes/concepts/threads` | cwd-scoped inventory, no pagination | defer | Cursor paging bounds payload only at list sizes Belay does not reach | high | n/a |
| A16 | Persistence adapter contract (flat `{id,parent_id,format,content}` append-only parent-pointer log) | `docs/integrations/persistence/custom-adapter` | `packages/session/src/protocol/events.ts:15` durable event log | defer | n/a - persistence shape study | medium | Is Belay's event taxonomy too rich to project losslessly into those rows, making an adapter a lossy view rather than a bridge? |
| A17 | Adapter composition model (per-slot capability activation) | `docs/runtimes/concepts/adapters` | transport + host turn loop + tools seams | defer | n/a - vocabulary/framing note | medium | n/a |
| A18 | Assistant Cloud persistence + hosted multi-user auth | `docs/cloud` | local session-store/blob-store, XDG state home | reject | n/a | high | Reason of record: hosted persistence + multi-user auth violates the local-first, no-hosted-auth constraint (hard reject) |
| A19 | DevTools runtime inspector (@assistant-ui/react-devtools) | `docs/devtools` | /doctor + /debug + inspectable projector | reject | Dev-only, prod-stripped either way | high | Reason of record: inspects assistant-ui runtime state Belay never mounts |

### Family B - Composer and input

| # | Pattern | assistant-ui source | Belay equivalent | Verdict | Perf note | Conf | Contrarian question |
|---|---|---|---|---|---|---|---|
| B1 | ComposerPrimitive (Root form, Send/Cancel gating, submitMode) | `docs/primitives/composer` | `prompt-input.tsx` (314 lines) + `app.tsx:969-1126` send/queue/vim wiring | keep-belay-owned | No perf angle; source-of-truth/behavior decision | high | Could queue + vim + hard-steer be expressed as isSendDisabled + a custom send adapter, or are they incompatible with a single-composer send model? |
| B2 | Headless composer input (unstable_useComposerInput: custom editor owns DOM, runtime owns send-gating) | `docs/guides/headless-composer-input` | prompt-input custom textarea + app.tsx gating | defer | Decouples DOM ownership from send-gating; relevant only if a runtime is ever adopted | medium | n/a |
| B3 | Input history recall (live-derived, non-persistent, resets on thread switch) `[V7]` | `docs/guides/input-history` | `apps/web/src/hooks/use-prompt-history.ts` (per-tab sessionStorage, records prompts + bang commands; wired `app.tsx:292-296`) | keep-belay-owned | Belay reads a stored ring; assistant-ui recomputes from thread state | high | n/a |
| B4 | @-mentions (trigger popover, directive `:type[label]{name=id}` serialization, live-completion debounce/cache/cancel) `[V7]` | `docs/guides/mentions` | `file-mention-menu.tsx` + `autocomplete-menu.tsx` + `apps/web/src/hooks/use-file-mention-menu.ts` | keep-belay-owned | Debounce+cancel+cache pattern would matter only for async/large mention sources; today local | medium | Is serializing mentions as directive text (audit trail visible to the model) a better contract than file-path insertion? |
| B5 | Slash commands (unstable_useSlashCommandAdapter, directive chips) `[V7]` | `docs/guides/slash-commands` | `command-menu.tsx` + `apps/web/src/built-in-commands.ts` + host command specs | keep-belay-owned | No perf angle | high | n/a |
| B6 | Unified composer trigger popover (one TriggerPopoverRoot coordinating @, /, custom) | `docs/api-reference/hooks/composer-triggers` | shared `autocomplete-menu.tsx` + three separately-named command surfaces (palette/menu/modal) | adapt | Architectural dedup; reduces divergent keyboard/aria logic across menus | medium | Does one trigger-popover controller remove enough duplication to justify the refactor, given the menus already share autocomplete-menu.tsx? |
| B7 | Suggested starter prompts (empty-thread gate) | `docs/guides/suggestions` | none | defer | n/a | high | n/a |
| B8 | SuggestionPrimitive (send vs populate) | `docs/primitives/suggestion` | none | defer | n/a | high | n/a |
| B9 | Follow-up suggestion chips (post-response, runtime-generated) | `docs/ui/follow-up-suggestions` | none - host emits no suggestions | defer | n/a | high | n/a |
| B10 | Attachment adapters (add/send/remove lifecycle, async-generator progress; base64 default) | `docs/guides/attachments` | `blob.ts` content-addressed blobs + `message-attachments.tsx` | keep-belay-owned | Belay already sidesteps the base64-in-memory bloat assistant-ui flags as its weak point | high | n/a |
| B11 | Voice dictation (WebSpeechDictationAdapter, interim/final segments) | `docs/guides/dictation` | none | defer | No reconnection handling documented for the browser adapter | high | n/a |
| B12 | Bidirectional realtime voice (RealtimeVoiceAdapter) | `docs/guides/voice` | none - no live audio transport | reject | Experimental, acknowledged reconnection gaps | high | Reason of record: no audio transport exists in Belay; belongs to a future voice/transport plan family, not a UI-primitive audit |

### Family C - Message, branching, reasoning

| # | Pattern | assistant-ui source | Belay equivalent | Verdict | Perf note | Conf | Contrarian question |
|---|---|---|---|---|---|---|---|
| C1 | MessagePrimitive (Parts/GroupedParts role+parts composition) `[V5]` | `docs/api-reference/primitives/message` | `transcript.ts:373` union (richer row kinds) + `message.tsx`; grouping is fully projection-owned (nothing live uses groupPartByType) | keep-belay-owned | Belay renders only relevant kinds per row and memoizes | high | n/a |
| C2 | MessagePartPrimitive.Text smooth typewriter streaming (SmoothOptions) | `docs/api-reference/primitives/message-part` | `markdown.tsx:179` useDeferredValue streaming; done-gated settle work | keep-belay-owned | useDeferredValue already batches streaming re-renders; a reveal layer adds cost for aesthetics | high | Would a subtle smooth-reveal improve perceived latency without betraying the raw terminal-honest streaming identity? |
| C3 | Message branching (in-thread branch array from edits/reloads) | `docs/guides/branching` | tangent sessions (`tangent.ts:48`, durable tangentOf lineage, explicit fold-back) | keep-belay-owned | n/a | high | For quick re-phrasings, is a full tangent session heavier than users want vs an inline branch; should Belay offer both? |
| C4 | BranchPickerPrimitive (hideWhenSingleBranch, boundary auto-disable) | `docs/api-reference/primitives/branch-picker` | tangent navigator; no in-message branch chrome | defer | n/a | medium | n/a |
| C5 | Message editing (edit = new branch, cancels in-flight run) | `docs/guides/editing` | supersede + send queue (`app.tsx:167`) + tangents | keep-belay-owned | n/a | high | n/a |
| C6 | ActionBarPrimitive (Copy/Edit/Reload; autohide, data-copied CSS states) | `docs/api-reference/primitives/action-bar` | per-row affordances in transcript-row-view/message.tsx | keep-belay-owned | Autohide keeps action chrome off most rows; replicable in CSS | medium | Does Belay want an explicit regenerate-last-turn action, and does it map to turn replay or a fresh run? (Not pre-empted here.) |
| C7 | Reasoning / chain-of-thought UI (auto-open on stream, auto-collapse on complete) `[V4]` | `docs/ui/reasoning` | LIVE: `reasoning-trace.tsx` ReasoningGroup + Belay MarkdownBody; scroll safety built on `useScrollLock` (`use-collapsible-disclosure.ts:3`), the one live assistant-ui runtime hook | adapt | Auto-open/collapse never writes the transcript viewport (plan 12.2); streaming preview pins only the trace's internal scroll box | high | n/a |
| C8 | Message timing / token stats (client-side estimate) | `docs/guides/message-timing` | `breakdown.ts:32` + turn-status header + `transcript.ts:1353` (server-derived, durable) | keep-belay-owned | Client-side capture would duplicate authoritative durable data with an estimate | high | n/a |
| C9 | Thread-level message component memoization (dup of A6) | `docs/ui/thread` | TranscriptRowView memo + rowConfig identity | keep-belay-owned | Already realized via render-isolation work | high | n/a |

### Family D - UI content rendering

| # | Pattern | assistant-ui source | Belay equivalent | Verdict | Perf note | Conf | Contrarian question |
|---|---|---|---|---|---|---|---|
| D1 | Markdown rendering (MarkdownText + @assistant-ui/react-markdown) `[V2]` | `docs/ui/markdown` | `markdown.tsx` via MarkdownBody, the single live owner. Drift: the second markdown stack is an idle-FETCHED, never-rendered chunk on every load (`markdown-text-lazy.tsx:12` preloadOnIdle pulls MarkdownTextPrimitive + remark-gfm; only render sites are dead) | keep-belay-owned | MarkdownBody defers highlight to settle and coalesces streaming deltas; swapping forfeits tuned behavior. Pruning the idle chunk is a startup win (section 5.2) | high | Should Belay drop the near-unused @assistant-ui/react-markdown dependency (keep/inline only the SyntaxHighlighterProps type)? |
| D2 | Streamdown renderer (block-based incremental parse, bundled Shiki/KaTeX/Mermaid) | `docs/ui/streamdown` | `markdown.tsx:186` whole-text re-lex per deferred frame | defer | Incremental block parse could cut per-delta CPU on multi-KB streaming messages; measurable only above some length; bundle cost of a second engine | medium | At what message length does whole-text re-lex-per-frame cost enough to justify Streamdown's bundle - has anyone profiled a 20KB streaming turn? |
| D3 | Syntax highlighting (react-shiki; defer-until-settle, per-language preload) | `docs/ui/syntax-highlighting` | `markdown.tsx:96` + `code-highlight.ts` (highlight.js, closed-fence gate, lazy engine) | keep-belay-owned | The core lesson (plain while streaming, highlight on settle, lazy grammars) is already implemented | high | Are highlight.js grammars materially worse than shiki for languages Belay users actually paste, or cosmetic? |
| D4 | Mermaid rendering (skeleton while streaming, degrade to raw source) `[V6]` | `docs/ui/mermaid` | `mermaid-block.tsx` + done-gate at `transcript-row-view.tsx:603`; verified: render errors degrade to raw source pre (`mermaid-block.tsx:292-294,378-388`) | keep-belay-owned | `mermaid={message.done}` already prevents re-parsing partial diagrams | high | Resolved: graceful degradation confirmed present |
| D5 | LaTeX / math (katex + remark-math; streaming-safe delimiter normalization) | `docs/guides/latex` | none - no katex dep; LLM math renders as raw LaTeX | defer | Delimiter normalization must run before the lexer; effect is correctness (no flicker), not throughput | medium | How often do coding-focused sessions actually emit LaTeX; is the katex bundle worth that frequency? |
| D6 | Diff viewer (standalone, no runtime dependency) | `docs/ui/diff-viewer` | ADOPTED: `assistant-ui/diff-viewer.tsx` (558 lines, copy-in owned; only a type import from react-markdown) via `tool-diff.tsx`/`multi-edit-diff.tsx`, now idle-preloaded (a65abd4b) | adopt | Single owned diff renderer; no runtime coupling means no state overhead | high | n/a |
| D7 | Sources UI (URL citation cards, lazy favicon + glyph fallback) | `docs/ui/sources` | `source-recall.tsx` code citations + web-search/web-fetch/docs rows (richer, redaction-aware) | keep-belay-owned | Lazy favicon with fallback avoids broken-image churn; borrowable if URL source cards are ever added | high | n/a |
| D8 | Model selector (cmdk combobox; sticky effort resolveModelEffort rule) `[V3]` | `docs/ui/model-selector` | LIVE UI is `panel-controls.tsx:68` over `model-selection.ts`; the vendored `model-selector.tsx` is stories-only (imports useAui). Verified: Belay already has per-model sticky effort (`model-preferences.ts:19-131`, tested) - stronger than resolveModelEffort | keep-belay-owned | cmdk tree-shakes; not a perf driver | high | Resolved: sticky-effort rule already exists Belay-owned; port follow-up dropped |
| D9 | Context display (Ring/Bar; fixed 65%/85% thresholds) | `docs/ui/context-display` | `context-pressure.ts` 4-level scale + fold preview (`side-panel.tsx:172-186`) | keep-belay-owned | Belay already supplies usage from its own tracking (the documented skip-fetch path) | high | n/a |
| D10 | File attachments (AttachmentAdapter; base64 flagged critical limitation) | `docs/guides/attachments` | `blob.ts` + `message-attachments.tsx` content-addressed ArtifactRefs | keep-belay-owned | Content-addressed blobs avoid the base64 data-URL bloat of the default adapter | high | n/a |
| D11 | Image attachments (SimpleImageAttachmentAdapter base64 for vision) | `docs/guides/attachments` | `message-images.tsx` + `image-carousel.tsx` + host artifact runtime | keep-belay-owned | Hash-resolved blobs avoid base64 memory bloat for large vision inputs | high | n/a |
| D12 | Image generation rendering (pending->complete state machine, zoom, regenerate) | `docs/guides/image-generation` | `artifact-thumb.tsx` + carousel; no generation product | defer | n/a - display-only | medium | n/a |
| D13 | Quote / selection toolbar (SelectionToolbarPrimitive; portal, composer.setQuote) | `docs/guides/quoting` | ADAPTED hand-built: `quote-selection-toolbar.tsx` (zero assistant-ui imports, createPortal + placement logic, tested) wired to tangent creation | adapt | Operates on a captured DOM selection so it works during streaming and auto-hides on scroll; already handled | high | n/a |

### Family E - Architecture, runtimes, transport, persistence, cloud

| # | Pattern | assistant-ui source | Belay equivalent | Verdict | Perf note | Conf | Contrarian question |
|---|---|---|---|---|---|---|---|
| E1 | Layered architecture (UI / runtime / backend / protocol / persistence) | `docs/architecture`, `docs/runtimes/concepts/architecture` | `SessionTransport` seam (`transport.ts:7`) + web read side + host loop already embody it | adapt | n/a - vocabulary only | high | n/a |
| E2 | Runtime decision tree (drop down a layer for control) | `docs/runtimes/pick-a-runtime` | SessionTransport is the single core runtime; local store vs Tether is a URL over one wire (`stream-transport.ts:27`) | keep-belay-owned | n/a | high | n/a |
| E3 | LocalRuntime + ChatModelAdapter (cumulative full-state per chunk; resumeRun) | `docs/runtimes/custom/local-runtime` | host turn loop emitters (`turn.ts:178`) + durable seq-log + incremental fold | reject | Negative if adopted: every chunk re-serializes the whole message vs appending one delta; regresses 10k-event replay | high | Reason of record: browser becomes generation-state owner; demotes the durable log to a mirror (D-002) |
| E4 | ExternalStoreRuntime + useExternalStoreRuntime (caller-owned arrays, capability activation) | `docs/runtimes/custom/external-store` | `projection.ts:35` read model + `toTranscript` feeding the bespoke transcript | adapt | Converter layer is neutral-to-negative unless it replaces (not layers on) existing row memoization; useShallow needed to avoid cascades | medium | Does binding projected rows to ExternalStoreRuntime reduce code, or just add a converter plus a thread-id-sync footgun on top of a projector that already emits render-ready rows? |
| E5 | DataStream protocol + useDataStreamRuntime (backoff, partial-content preservation) | `docs/runtimes/custom/data-stream` | replay-then-tail decode (`stream-transport.ts:27`) + afterSeq reconnect with backoff (`use-session.ts:308,348`) | reject | Redundant: deltas are persisted before render and reconnect already uses exponential backoff at afterSeq | high | Reason of record: a second streaming protocol beside the /sessions REST+WS contract; HITL tools unsupported |
| E6 | AssistantTransport (full agent-state snapshots, ephemeral command queue, Enterprise resumeApi) | `docs/runtimes/custom/assistant-transport` | durable seq-envelope deltas (`protocol/events.ts`) + durable follow-up queue (CONTEXT.md:103) | reject | Negative on the 10k+ event reload path: snapshots resend state or require diff machinery deltas make unnecessary | high | If Belay grows rich mutable workflow state that is not event-shaped, is this reject-forever or reject-until-workflow-UI? |
| E7 | Resumable Streams (Redis-backed stream ids, 24h TTL, resume on mount) | `docs/guides/resumable-streams` | afterSeq durable replay (`use-session.ts:306-316`) + host provider reconnect (`turn.ts:205,443`) | keep-belay-owned | Event-granular resume with zero extra per-chunk storage I/O vs byte-level per-chunk writes. Security lesson kept: bind any resume/stream id to the requester and treat as sensitive | high | When Tether is the transport, is there a mid-turn producer-survives-disconnect gap that byte buffering would close but afterSeq replay would not? |
| E8 | RemoteThreadListRuntime + Postgres/Drizzle persistence adapter (metadata/history split, initialize-before-append race) | `docs/runtimes/concepts/threads`, `docs/integrations/persistence/custom-adapter` | SessionSummary inventory + session.project marker + `history-projection.ts:33` already split metadata from full log | keep-belay-owned | Sidebar already renders from summaries without loading logs; pattern is confirmation, not improvement | medium | Does the supervisor-spawn/new-session path have the append-before-durable-init race the adapter guards against, and is that guard present today? |
| E9 | Adapter extension points (tiny interface; matching UI activates; zero cost when absent) | `docs/runtimes/concepts/adapters` | TOOL_RENDERERS registry (`tool-message.tsx:355`) + capability-gated intents (`use-session.ts:437`) already follow the shape | adapt | Capability-gated rendering keeps unused paths at zero cost; neutral perf, cleaner seams | medium | n/a |
| E10 | API stability tiering (unstable_ prefix; pin ranges, wrap call sites) | `docs/runtimes/concepts/stability` | assistant-ui pins `^0.14.23`/`^0.14.4` + vendored wrappers | adopt | n/a - dependency governance | high | n/a |
| E11 | Assistant Cloud + cloud runtime variants (useCloudChat, title-gen, telemetry) | `docs/cloud`, `docs/cloud/ai-sdk-assistant-ui` | local durable log + blob store; keys local | reject | Cloud variants add serialized round-trips (thread create, title-gen) on first message that the local store avoids | high | Reason of record: hosted persistence/auth breaks local-first (hard constraint). If multi-device roaming ever matters, it is Belay-owned sync, never Assistant Cloud |
| E12 | Cloud authorization + auth integrations (Clerk/Auth0/Supabase/Firebase/next-auth) | `docs/cloud/authorization`, `docs/integrations/auth/*` | no auth layer; identity is per-tab participant id (`transport.ts:20`) | reject | n/a | high | Reason of record: per-userId scoping solves a multi-tenant problem a single-user local tool does not have |
| E13 | AI SDK v6 runtime (AssistantChatTransport auto-forwards system msgs + frontend tools per request) | `docs/runtimes/ai-sdk/v6` | host turn loop owns provider calls; `history-projection.ts:33` curates the request | reject | Auto-forward-everything enlarges payloads vs Belay's curated projection with compaction pins | high | Reason of record: relocates provider invocation into an assistant-ui request path, displacing the host loop |
| E14 | LangGraph / LangChain useStream runtimes (graph state as source of truth) | `docs/runtimes/langgraph/overview`, `docs/runtimes/langchain` | host loop + Effect-native workflow runtime with journaled resume (CONTEXT.md:12) | reject | workflow.* journal events already give resumable orchestration state at lower weight | high | Reason of record: imports a second graph-state owner and framework lock-in with no missing capability |
| E15 | Mastra integration (via AI SDK, no dedicated adapter) | `docs/integrations/frameworks/mastra/overview` | Belay host is the agent server | reject | n/a | high | Reason of record: adopting Mastra means adopting the rejected AI SDK runtime path plus a foreign agent framework |
| E16 | AG-UI protocol adapter (STATE_SNAPSHOT/STATE_DELTA, CopilotKit interop) | `docs/runtimes/ag-ui/overview` | /sessions REST+WS + typed protocol events; Belay IS the agent | reject | n/a | high | Reason of record: reframes Belay as a client of a foreign agent, inverting the architecture |
| E17 | A2A protocol v1.0 adapter (task-state machine, artifact wire) | `docs/runtimes/a2a/overview` | delegation (`delegate.ts:96`) + workflow leaves, currently in-process | defer | n/a currently; revisit if delegation crosses a host boundary | medium | When the worktree fleet delegates across machines, is A2A's wire better than extending protocol/events.ts, or does the seq-log subsume it? |
| E18 | Google ADK runtime (first-class HITL confirmation/credential flows) | `docs/runtimes/google-adk/overview` | provider.question / ask_user (`protocol/events.ts:1488`) + handoff approvals | reject | ADK normalizes snake_case->camelCase per message; a cost Belay avoids by owning its event shape | high | Reason of record: external agent framework; the requires-action lesson is already partly present via provider.question.* |
| E19 | OpenCode runtime adapter (coding-agent sessions as threads; fork/revert; v0.0.3) | `docs/runtimes/opencode/overview` | Belay host over SessionTransport; tangent fork | defer | n/a | medium | If Belay exposes sessions to a non-Belay assistant-ui frontend, does the OpenCode ExternalStore+RemoteThreadList mapping generalize to the seq-log, or does durable-replay force a bespoke adapter? |
| E20 | Eve runtime (filesystem-first durable agent; continuation tokens; UI renders only) | `docs/runtimes/eve/overview` | Exactly Belay's separation: durable log owns state, web renders, afterSeq is the continuation (`use-session.ts:270`) | keep-belay-owned | Validation, not upgrade; Belay adds presence, follow-up queue, tangents. Eve routes credentials via Vercel AI Gateway by default | high | n/a |
| E21 | Cloudflare Agents (per-DO SQLite; setMessages round-trip, eventual consistency) | `docs/integrations/frameworks/cloudflare-agents/overview` | local transactional per-append log | reject | DO round-trip adds latency and eventual consistency the append-only log avoids | high | Reason of record: edge-hosted per-conversation persistence is incompatible with local-first single-machine storage |
| E22 | LLM gateway integration (OpenRouter/Portkey/LiteLLM via baseURL swap; keys server-side) | `docs/integrations/gateways` | `providers/openai-compat.ts` + catalog already do exactly this; keys host-side in ~/.pi/auth.json | keep-belay-owned | baseURL gateway hops already supported; nothing to adopt | high | n/a |
| E23 | Hosted-SaaS observability (LangSmith wrapAISDK; Helicone edge proxy) | `docs/integrations/observability/langsmith`, `.../helicone` | sanitized in-process metrics (`metrics.ts:16`) + /doctor | reject | Helicone adds a network hop to every provider call for data Belay already has locally | high | Reason of record: ships conversation content to a SaaS / external proxy, violating the sanitized-telemetry invariant |
| E24 | Langfuse observability (OTel, open-source, self-hostable span hierarchy) | `docs/integrations/observability/langfuse` | metrics rollup + /doctor; turn loop emit points as would-be span sites (`turn.ts:178`) | defer | Per-turn span overhead in the host loop, small if sampled, vs near-free in-process counters | medium | Can a self-hosted OTel trace carry the planner->tool->LLM hierarchy while honoring the no-conversation-content rule, or does useful tracing require content Belay refuses to export (making this reject)? |

### Family F - Tools, generative UI, MCP

| # | Pattern | assistant-ui source | Belay equivalent | Verdict | Perf note | Conf | Contrarian question |
|---|---|---|---|---|---|---|---|
| F1 | Toolkit authoring (defineToolkit + 'use generative' + bundler split of client/server) | `docs/tools/defining-tools` | `tools/types.ts:35` Tool<A> Effect Schema contract + `registry.ts:45` JSON-Schema derivation; all tools host-executed | reject | Bundle-split value is irrelevant: the web app never bundles executors (process separation already enforces it) | high | If Belay adds real browser-side tools (clipboard, DOM), does hand-rolling registration cost more than adopting just the frontend/human tool kinds? |
| F2 | Human tools (humanTool pauses at requires-action until addResult/resume) | `docs/tools/defining-tools` | ask_user tied to runId/callId, durable on the log, reaped on takeover | keep-belay-owned | n/a | high | n/a |
| F3 | Provider tools (providerTool executes inside the provider) | `docs/tools/defining-tools` | host-executed web_search/web_fetch with normalization/redaction/bounding (`web-search.ts:79`) | defer | Could remove one host round-trip, at the cost of normalization/redaction; marginal, provider-specific | medium | Are any provider-native tools now good enough to justify a passthrough lane that skips host normalization? |
| F4 | Dynamic tools (stubTool + browser execute closing over live React state) | `docs/tools/dynamic-tools` | none - tools are static host defs with durable lifecycle events | reject | n/a | high | Reason of record: client-state-dependent execution cannot be replayed from the durable log; all exports unstable_ |
| F5 | Tool UI render callback (args/status/result; render-null-until-complete; useToolArgsStatus) | `docs/tools/tool-ui` | TOOL_RENDERERS name-dispatched registry (`tool-message.tsx:355`), compile-time exhaustive; null-until-ready already in renderDiff/renderMultiEdit (`:88,:109`) | keep-belay-owned | Audit worth doing: confirm every renderer arm honors null-until-complete to avoid remount churn during arg streaming | high | n/a |
| F6 | useToolCallElapsed (1s-throttled elapsed for running tools) | `docs/api-reference/tools/status` | No elapsed on running tool rows; Belay already owns the exact 1s leaf clock (`hooks/use-elapsed-label.ts`, used by ActionShimmer/TurnStatusHeader) | adapt | Shared 1s leaf clock shows progress without per-frame re-render storms; reduces to passing tool.started timestamp into existing components | medium | Does elapsed on every running tool add noise, or should it appear only after N seconds as a stuck-tool signal? |
| F7 | ToolFallback catch-all component (collapsible Args/Result/Error/Approval, shimmer) | `docs/ui/tool-fallback` | Vendored `tool-fallback.tsx` currently dead; lsp_*/mcp render flat capped text (`tool-message.tsx:391-401`) | adapt | Collapsible + shimmer reduces on-screen DOM vs always-expanded monospace dumps | medium | (Wiring must strip two runtime couplings: Approval drives addResult/resume that would silently no-op, and useToolCallElapsed must be replaced with useElapsedLabel) |
| F8 | ToolGroup + GroupedParts + groupPartByType (consecutive tool-call collapsing) | `docs/ui/tool-group`, `docs/ui/part-grouping` | Projection-driven read-only concurrent-batch grouping + oversized-turn windowing (ef395b2f) | keep-belay-owned | Stable leaf identity keys across streaming avoid remount; already targeted by memoized rows | high | n/a |
| F9 | makeAssistantDataUI (named renderer for terminal data parts) | `docs/api-reference/tools/rendering` | none; workflow.* events have no web surface (confirmed gap) | defer | Could avoid a synthetic tool round-trip for pure UI payloads; no such payload exists yet | medium | When workflow rendering lands, is a data-part channel simpler than emitting durable workflow.* events the existing projector folds? |
| F10 | Legacy component tool APIs (makeAssistantTool etc., deprecated) | `docs/api-reference/tools/component-tools` | n/a - never used | reject | n/a | high | Reason of record: explicitly deprecated with <1 month notice tier |
| F11 | Generative UI (model-authored JSON spec vs component allowlist; $action registry) | `docs/tools/generative-ui` | Lucid artifacts + hand-built TOOL_RENDERERS | defer | Native parts render progressively as the spec streams vs whole-spec-at-completion via a tool bridge | medium | Does Belay want ANY model-authored UI, or is Lucid's human-authored-artifact model the deliberate boundary? |
| F12 | Interactables (auto-generated update_{name} tool streaming into component state) | `docs/tools/interactables` | explicit durable-log events only (no hidden write path invariant) | reject | Partial-field streaming is irrelevant without the hidden-write model | high | Is there an interactive-form case (handoff approval with inline edits) where an explicit durable form.submitted event captures the same UX? |
| F13 | Multi-agent orchestrator UI (read-only nested sub-agent thread, inherits parent renderers) | `docs/tools/multi-agent` | inline agent rows (`transcript.ts:893`), background delegation blocks (`:956`), support panel; workflows have no surface | adapt | Read-only nested rendering avoids making nested conversations independently interactive (state-cost saving) | medium | Should workflow structure render inline in the transcript at all, or belong in the support panel where running delegations surface? |
| F14 | toModelOutput ({__aui_modelContent} envelope; reader-before-writer hazard) | `docs/tools/backend` | centralized host `history-projection.ts:33`; tools return bounded text | keep-belay-owned | The envelope's rollout hazard across an append-only log is exactly the blast radius the central projector avoids | medium | n/a |
| F15 | Server-side MCP (fresh client per request, no reconnection, close in onFinish) | `docs/tools/mcp` | Host-lifetime lazy MCP runtime (`mcp/runtime.ts:30`): capability cache, redacted /doctor status, sampling budget, elicitation mediation | keep-belay-owned | Lazy host-lifetime connections avoid per-request connect latency while unused servers cost nothing; capability cache avoids re-discovery | high | Does the host-lifetime connection ever hold a dead socket the per-request model would side-step - is there a reconnection/backoff gap worth mining? |
| F16 | externalTool render pattern (structured args/result for tools executed elsewhere) | `docs/tools/mcp` | Web flattens rich structured MCP results (McpResourceContext server+uri+mime, per-server status) to capped text (`tool-message.tsx:391`) | adapt | Structured collapsible renderer (resource/prompt/status table) reduces flat-text DOM and improves scanability | high | n/a |
| F17 | User-managed MCP (browser connector manager, PKCE/DCR OAuth, McpConfigDialog) | `docs/tools/user-managed-mcp`, `docs/ui/mcp-config` | host-side file config read at startup (`mcp/config.ts`); statusSnapshot() exposes health | defer | Library defers auto-reconnect-with-backoff: dropped connections stay dropped | medium | Is file-based MCP config deliberate local-first simplicity, or a real operator friction point? |
| F18 | MCP credential storage (McpLocalStorage: plain-text tokens in localStorage) | `docs/tools/user-managed-mcp` | host-side secrets only (opchain / ~/.pi/auth.json) | reject | n/a | high | Reason of record: XSS-exposed browser token storage (by the library's own admission) contradicts host-side secret handling |
| F19 | MCP Apps (sandboxed cross-origin ui:// iframe widgets, JSON-RPC bridge, backend proxy auth) | `docs/tools/mcp-apps` | none; host fully mediates MCP (`mcp/mediation.ts`) | defer | 5s teardown timeout bounds hangs; stable host/handler refs required to avoid remount - relevant only if adopted | medium | If a valued MCP server ships a ui:// widget, is a sandboxed iframe acceptable in a local-first app, or is host-rendered structured output the boundary? |

### Family G - Utilities, copilot APIs, governance

| # | Pattern | assistant-ui source | Belay equivalent | Verdict | Perf note | Conf | Contrarian question |
|---|---|---|---|---|---|---|---|
| G1 | tw-shimmer (pure-CSS shimmer/skeleton) | `docs/utilities/tw-shimmer` | ADOPTED: dep at `package.json:42`, used in reasoning/tool-group/tool-fallback/panel/action-shimmer | adopt | Zero JS runtime cost beyond compiled CSS | high | n/a |
| G2 | react-o11y (headless LLM span-tree/waterfall inspector; experimental) | `docs/utilities/react-o11y` | /doctor; no span-timeline UI; no span source emitted | defer | Collapsed nodes excluded from DOM, live streaming without full re-render - good properties, but no data source exists | medium | Is a span waterfall worth an experimental dep, or do side-panel token/context surfaces plus /doctor already answer the latency questions Belay asks? |
| G3 | heat-graph (contribution heatmap) | `docs/utilities/heat-graph` | none - no activity-heatmap surface | reject | n/a | high | Reason of record: general-purpose visualization with no product home; not reopened as a nice-to-have |
| G4 | DevTools panel (shadow-root isolation, prod tree-shake, plugin tabs) | `docs/devtools` | /debug + /doctor + read model; no in-browser inspector | defer | Shadow-root isolation + prod tree-shake = zero end-user cost; a good template for a Belay-owned overlay | medium | Do web projector bugs happen often enough to justify a devtools panel, given the durable log can be replayed offline? |
| G5 | Assistant Frame API (cross-origin iframe model-context sharing) | `docs/copilots/assistant-frame` | none - single web app + local host over Tether | reject | n/a | high | Reason of record: no cross-origin embedded-iframe surface exists or is planned |
| G6 | Model context / copilot APIs (useAssistantInstructions, send-time provider-tree assembly) | `docs/copilots/model-context` | host-side request assembly from the durable log (`history-projection.ts:33`) + host tool registry | keep-belay-owned | Provider-tree assembly concatenates every mounted component's instructions per request (token cost scales with mounts); centralized host assembly keeps prompt size deterministic for the context-pressure math | high | Is there browser-only context (current UI view state) the host genuinely cannot see that would justify a narrow component-scoped channel? |
| G7 | makeAssistantVisible (outerHTML into context + model-dispatched synthetic DOM events) | `docs/copilots/make-assistant-visible` | none - model acts only through host tools over an auditable boundary | reject | outerHTML in system context scales with DOM size (prompt bloat + DOM privacy leak) | high | Is any UI-control task compelling enough for a mediated, provenance-logged version - and would that not be a host tool, not DOM injection? |
| G8 | assistant-ui CLI / component registry (source-first add/upgrade/codemod) | `docs/cli` | six vendored components under `components/assistant-ui/`; Belay already source-first | adapt | Source-first add deletes dead code as source (better tree-shaking); already Belay's posture | medium | Per vendored component, is the local modification worth the drift cost, or should some track upstream directly? |
| G9 | Deprecation policy and stability tiers (Experimental/Beta/Stable; unstable_ convention) | `docs/migrations/deprecation-policy` | pins + live imports of Beta/unstable_ surfaces (useScrollLock, type-only ReasoningMessagePartComponent/ToolCallMessagePartStatus, idle-loaded MarkdownTextPrimitive chunk) | adopt | Governs API churn risk, not runtime | high | n/a |
| G10 | Thread rendering perf baseline - non-virtualization lessons (content-visibility, stable identity, memoize-by-index) | `docs/guides/virtualization` | memoized rows + windowing (ef395b2f), scroll isolation (8f8497ea), leaf clocks (52526d29); content-visibility absent from live paths (see A5) | adapt | content-visibility + tuned contain-intrinsic-size skips off-screen paint/layout even without a virtualizer; must coordinate with the shipped 58.4 virtual transcript to avoid double-hiding | medium | Does content-visibility conflict with the shipped virtual transcript (double-hiding), and should it land inside that surface rather than beside it? |
| G11 | Assistant Cloud (hosted thread persistence + cloud-side multi-user auth; final family sweep) | `docs/cloud` | durable append-only log (`event.ts`), local stores, XDG state home | reject | "Messages save as they stream" is already Belay's property via the durable log; replay-then-tail already provides reconnection | high | Reason of record: hard constraint (local-first, single-operator); permanent reject |

## 3. Ranked M4 follow-up shortlist

Only candidates with clear payoff and low architectural risk, ranked by long-term simplicity,
robustness, and product leverage (not development cost). Proposed plan numbers from the research
rows are indicative only; several collide with already-used numbers (58.7 concurrent-worktrees
existed), so final numbers must be assigned by the planner at creation time per the plan-git
workflow.

### 3.1 Track A - adopt/adapt UI primitives and patterns (shortlisted)

1. **assistant-ui dependency governance: stability ledger + wrapper policy + drift check +
   render smoke tests** (rows E10, G8, G9, D6, C7; merges proposed 58.15/58.16/58.17 and the
   "presentational stability checklist"). Adopt. One small plan: a table in CONTEXT.md listing
   every live assistant-ui import with its stability tier (verified inventory: `useScrollLock`
   at `use-collapsible-disclosure.ts:3`; type-only `ReasoningMessagePartComponent` and
   `ToolCallMessagePartStatus`; the markdown-text chunk), exact pins, an `assistant-ui add
   --dry` drift diff for the six vendored components, and smoke tests asserting
   reasoning-trace + tool-diff/multi-edit-diff render across version bumps. Zero architectural
   risk; directly retires the "unstable API churns after adoption" risk. Note the vendored
   diff-viewer and markdown-text are now idle-preloaded (a65abd4b), a freshness detail for the
   smoke test.
2. **Prune the idle-fetched second markdown stack** (row D1, born of the Verify pass). Adapt
   (cleanup). `markdown-text-lazy.tsx:12` preloadOnIdle downloads the full
   MarkdownTextPrimitive + remark-gfm + dot.css chunk on every app startup and it never
   renders live (only render sites are the dead `Reasoning` export at `reasoning.tsx:315` and
   dead `thread.tsx:357`). Remove the preload + dead export, decide whether dead `thread.tsx`
   stays as a reference file (it also carries the A5 intrinsic-size estimates), and shrink
   `@assistant-ui/react-markdown` to the one type import. Pure simplicity + startup win.
3. **Running-tool elapsed clock** (row F6). Adapt. Smallest slice: pass the `tool.started` seq
   timestamp into the existing `useElapsedLabel`/ActionShimmer leaf-clock components on
   running tool rows. Verified to be a wiring task, not a new component. Product leverage: a
   slow tool becomes distinguishable from a stuck one.
4. **Structured MCP result rows** (row F16). Adapt. A TOOL_RENDERERS arm for the `mcp` tool
   rendering `status` as a per-server table and resource reads with uri/mime provenance,
   decoding the host's existing structured records (`mcp/runtime.ts:64`). Closes the confirmed
   flat-text gap; presentational only.
5. **Transcript paint-skipping via content-visibility** (rows A5, G10). Adapt, with a flagged
   conflict: must land inside or in explicit coordination with the shipped 58.4 virtual
   transcript to avoid double-hiding, and must not fight the anchor row's measured height.
   Smallest slice: `content-visibility:auto` + per-kind `contain-intrinsic-size` on non-anchor
   TranscriptRowView wrappers behind a flag, mining the 24px/60px estimates from dead
   `thread.tsx:317/:446`, measured on a 500-row session.

Second tier (real but lower leverage; not shortlisted for immediate follow-up):

- **ToolFallback as catch-all for lsp_*/un-specialized rows** (F7) - requires stripping two
  verified runtime couplings (Approval sub-part and useToolCallElapsed) before wiring.
- **Unify composer trigger popovers** (B6) - Belay-owned controller consolidating
  slash/file-mention/palette surfaces; no unstable assistant-ui dependency.
- **Keyboard-navigable sidebar session menu** (A10) - sharedFocusGroup pattern with Belay's
  own Radix components.
- **Expandable delegation/workflow rows** (F13) - read-only nested block via Belay's projector
  over the child session id; addresses the workflow-render gap.
- **null-until-complete audit across TOOL_RENDERERS arms** (F5) - checklist-sized.

### 3.2 Track B - protocol/runtime migration candidates (research only, D-002)

These are a different risk class and must never share an implementation plan with Track A.

1. **ExternalStore read-only adapter spike** (rows E4, A14). Storybook-only: render ONE
   existing session's `toTranscript` output through assistant-ui Thread/Message primitives via
   a read-only ExternalStore adapter, no intents wired, purely to measure render cost and map
   the thread-id-sync footgun. This is the single credible bridge to assistant-ui primitives
   that keeps the durable log the sole source of truth. Known hazards recorded in advance:
   immutability discipline, thread-id sync corruption footgun, useShallow re-render cascades,
   Belay row kinds with no part type.
2. **Persistence/thread-adapter mapping study** (rows A16, A17, E8). Whether Belay's event
   taxonomy projects losslessly into the `{id,parent_id,format,content}` adapter shape, and
   whether the initialize-before-first-append race guard exists on Belay's session-create
   path. Coupled to (1); no adoption implied.

Everything else in the runtime/protocol family is rejected (E3, E5, E6, E11-E16, E18, E21).

### 3.3 Conflicts with live plans

- **58.4 (assistant-ui thread virtualization)**: completed and shipped as the Belay-owned
  virtual transcript (`ed835a97`). D-001 still routes all scroll/virtualization decisions
  there: candidate A-track item 5 (content-visibility) and the deferred A1/A4 affordances
  (turnAnchor, ScrollToBottom, footer-height registration) must be designed against
  `virtual-transcript.tsx` as the scroll owner, not beside it.
- **58.2 (worktree sidebar surface), 58.3 (live output scroll parity), 58.5 (resume host on
  session select)**: all completed and retired; no live branch conflicts. Their shipped
  surfaces are the current owners the sidebar (A10) and scroll (A5/G10) candidates must
  respect.
- **50 (cli-headless-agent-surface, live)**: the only live plan owning session/transport
  behavior. Track B studies touch the same `SessionTransport` seam conceptually; they are
  web/Storybook-side and read-only, but any adapter study that proposes new transport-visible
  contracts must be sequenced after or coordinated with plan 50.

### 3.4 Follow-ups dropped by the Verify pass

- **Port resolveModelEffort sticky-effort rule** (row D8): dropped. Belay already implements a
  per-model sticky rule that is at least as strong (`model-preferences.ts:19-131`,
  `model-selection.ts:31-37`, tested at `model-preferences.test.ts:111`).

## 4. Rejected and deferred patterns

### 4.1 Rejected (architectural reason of record)

| Row | Pattern | Reason of record |
|---|---|---|
| A7 | Prebuilt `<Thread />` | Requires the assistant-ui runtime as message source of truth (D-002); Belay row kinds have no part type |
| A11 | Prebuilt `<ThreadList />` / sidebar | Requires the runtime as session-list source of truth; soft-delete/resume do not map to active/archived |
| A18, E11, G11 | Assistant Cloud (all appearances) | Hosted persistence + multi-user auth violate the local-first, single-operator constraint (hard reject, permanent) |
| A19 | DevTools runtime inspector | Inspects assistant-ui runtime state Belay never mounts |
| B12 | Bidirectional realtime voice | No audio transport in Belay; experimental adapter with undocumented reconnection; belongs to a future voice/transport family |
| E3 | LocalRuntime | Browser becomes generation-state owner; cumulative-state-per-chunk regresses the durable delta log |
| E5 | DataStream runtime | Second streaming protocol beside the /sessions REST+WS contract; HITL unsupported |
| E6 | AssistantTransport | Snapshot ops replace the ordered append-only log; ephemeral queue is weaker than the durable follow-up queue; Enterprise-gated resume |
| E12 | Cloud authorization / auth integrations | Per-userId scoping solves a multi-tenant problem a single-user local tool does not have |
| E13 | AI SDK v6 runtime | Relocates provider invocation out of the host turn loop; auto-forwarding inflates payloads the curated projection controls |
| E14 | LangGraph / LangChain runtimes | Second graph-state owner; Belay's journaled workflow runtime already provides resumable orchestration |
| E15 | Mastra | Routes through the rejected AI SDK path plus a foreign agent framework |
| E16 | AG-UI protocol | Reframes Belay as a client of a foreign agent, inverting the architecture |
| E18 | Google ADK runtime | External agent framework; HITL lesson already present via provider.question.* |
| E21 | Cloudflare Agents | Edge-hosted eventual-consistency persistence vs local transactional append-only log |
| E23 | LangSmith / Helicone | Exports conversation content to a SaaS / adds an external hop per provider call; violates sanitized telemetry |
| F1 | Toolkit authoring + bundler split | Process separation already guarantees executors never ship to the browser; rewrite of ~40 tools for zero local-first benefit |
| F4 | Dynamic browser tools | Client-state-dependent execution cannot be replayed from the durable log |
| F10 | Legacy component tool APIs | Deprecated by assistant-ui with <1 month notice tier |
| F12 | Interactables | Auto-generated hidden model->client write path with no durable provenance; all exports unstable_ |
| F18 | McpLocalStorage credential storage | Plain-text browser token storage (XSS-exposed by the library's own docs) vs host-side secrets |
| G3 | heat-graph | No product surface; recorded so it is not reopened |
| G5 | Assistant Frame | No cross-origin embedded-iframe surface exists or is planned |
| G7 | makeAssistantVisible | Model-driven synthetic DOM events with no session-log provenance; unbounded DOM in prompt |

### 4.2 Deferred (unblocking condition)

| Row | Pattern | Unblocks when |
|---|---|---|
| A1 | Viewport turnAnchor/footer registration | The virtual-transcript owner surface evaluates top-anchor and composer-height registration (58.4 successor work) |
| A2 | id-keyed message access | Any future revision of the shipped virtualization design needs id-keyed random access |
| A3, B7, B8 | Starter suggestions | An explicit starter-prompt/onboarding product need exists |
| A4 | ScrollToBottom affordance | Jump-to-latest is designed against Belay's own scroll owner |
| A14, A16, A17 | Thread/persistence/composition adapters | The Track B adapter-study plan runs (research only) |
| A15 | Thread-list pagination | Per-cwd session counts grow large or cross-project browsing ships |
| B2 | Headless composer input | A runtime adapter is ever adopted AND the API sheds its unstable_ prefix |
| B9 | Follow-up suggestion chips | A host-side suggestion generator plus a UI slot are decided as product |
| B11 | Voice dictation | Voice input becomes a stated product goal |
| C4 | BranchPicker chrome | Belay adds in-message variation navigation (coupled to the C3 decision) |
| D2 | Streamdown incremental parser | Profiling shows whole-text re-lex cost on long streaming turns justifies a second engine (measurement gate) |
| D5 | LaTeX/math | Math output is a demonstrated user need; then remark-math inside Belay's pipeline, not a renderer swap |
| D12 | Image generation rendering | An image-generation tool exists to render |
| E17 | A2A protocol | Delegation crosses a host/machine boundary (fleet direction) |
| E19 | OpenCode adapter prior art | Belay decides to expose sessions to an external assistant-ui frontend |
| E24 | Langfuse self-hosted tracing | A need for hierarchical traces beyond /doctor + metrics, plus a sanitized no-content span design |
| F3 | Provider-native tools | A provider capability materially beats the host tool AND a product need appears |
| F9 | Data-part UI channel | The workflow-render plan decides a side-payload channel beats durable workflow.* events |
| F11 | Generative UI | Lucid direction settles AND strict per-component prop-schema validation is designed (allowlist alone does not sanitize) |
| F17 | User-managed MCP UI | Product decision: in-app MCP management vs file config; smallest slice is a read-only status panel over statusSnapshot() |
| F19 | MCP Apps ui:// widgets | A valued MCP server ships widgets AND a host-side proxy auth boundary is designed |
| G2 | react-o11y timeline | Belay emits per-tool/turn spans and a diagnostics surface is decided; then compare vs a hand-rolled bar list |
| G4 | Belay devtools overlay | Recurring projector-debug pain justifies a dev-only shadow-root panel (modeled on the isolation approach, not the runtime bindings) |

## 5. Performance opportunities

Each tied to a concrete Belay surface with expected effect. Virtualization itself is 58.4's
(shipped) territory; nothing here re-opens it.

1. **Off-screen row paint-skipping** (A5/G10) - `virtual-transcript.tsx` /
   `transcript-row-view.tsx` non-anchor row wrappers. `content-visibility:auto` +
   per-kind `contain-intrinsic-size` lets the browser skip paint/layout for off-screen rows
   while they stay mounted. Expected effect: reduced scroll-time paint work on long/tall-row
   sessions, complementary to the shipped windowing. Risk: bad size estimates cause scrollbar
   jump; coordinate with the virtual transcript to avoid double-hiding. In-repo estimates to
   mine: dead `thread.tsx:317` (auto 24px text) and `:446` (auto 60px user turns).
2. **Kill the idle-fetched dead markdown chunk** (D1) - `markdown-text-lazy.tsx:12`
   preloadOnIdle downloads the full MarkdownTextPrimitive + remark-gfm + dot.css stack on
   every app startup and it never renders live. Expected effect: one fewer network fetch +
   parse on every load; removes a whole second markdown engine from the shipped surface.
3. **Streaming-markdown re-lex profiling gate** (D2) - `markdown.tsx:186`
   `markdownParts(deferredText)` re-lexes and re-sanitizes the entire message per deferred
   frame. Streamdown's block-incremental parse could cut per-delta CPU on multi-KB turns.
   Expected effect: unknown until measured; the follow-up is a benchmark, not an adoption.
4. **null-until-complete audit** (F5) - every TOOL_RENDERERS arm in `tool-message.tsx`.
   renderDiff/renderMultiEdit already defer until a path streams in; auditing the remaining
   arms prevents mount/unmount churn of expensive views during token-by-token arg streaming.
5. **1s leaf-clock elapsed on running tools** (F6) - running tool rows via existing
   `use-elapsed-label.ts`. Expected effect: progress feedback with zero per-frame re-render
   cost, consistent with the leaf-clock isolation work (52526d29).
6. **Collapsible fallback for flat-text tool rows** (F7/F16) - lsp_*/mcp rows currently render
   always-expanded capped monospace dumps. A collapsible structured renderer reduces on-screen
   DOM in tool-heavy turns.
7. **Already banked (no action)** - assistant-ui's headline perf lessons that Belay already
   implements: highlight-defer-to-settle + lazy grammar load (D3), mermaid done-gating (D4),
   row memoization + rowConfig identity + oversized-turn windowing (A6/C9/F8), content-addressed
   blobs instead of base64 attachments (B10/D10/D11), afterSeq event-granular resume with zero
   per-chunk storage I/O (E7), metadata/history split for the sidebar (E8), lazy host-lifetime
   MCP connections with capability cache (F15).
8. **Anti-patterns recorded as cautions** - LocalRuntime's cumulative full-state re-serialization
   per chunk (E3), AssistantChatTransport's auto-forwarding payload inflation (E13),
   provider-tree instruction assembly whose token cost scales with mounted components (G6),
   per-history-mutation edge round-trips (E21). These document why Belay's delta/projection
   design should not drift toward snapshot models.

## 6. Coverage ledger appendix

Every page from the assistant-ui `llms.txt` index is accounted for below: **270 pages** total - 53 `compare` (received their own matrix row or anchor a row directly), 165 `group` (folded into a named comparison family whose verdict covers them), and 52 `out-of-scope` (with reason). Thread virtualization adoption is delegated to plan 58.4; the virtualization guide is out-of-scope here, with its non-virtualization performance lessons recorded in matrix rows A5 and G10.

### 6.1 Compare pages (anchor a matrix row)

| Page | Family |
|---|---|
| `docs/architecture.md` | architecture-runtimes |
| `docs/cloud.md` | cloud-integrations |
| `docs/copilots/model-context.md` | utilities-copilot-migration |
| `docs/guides/attachments.md` | ui-content |
| `docs/guides/branching.md` | message-branch-reason |
| `docs/guides/chain-of-thought.md` | message-branch-reason |
| `docs/guides/dictation.md` | composer-input |
| `docs/guides/headless-composer-input.md` | composer-input |
| `docs/guides/image-generation.md` | ui-content |
| `docs/guides/mentions.md` | composer-input |
| `docs/guides/resumable-streams.md` | architecture-runtimes |
| `docs/guides/slash-commands.md` | composer-input |
| `docs/guides/suggestions.md` | composer-input |
| `docs/integrations/frameworks/mastra/overview.md` | cloud-integrations |
| `docs/migrations/v0-14.md` | utilities-copilot-migration |
| `docs/primitives/action-bar.md` | message-branch-reason |
| `docs/primitives/branch-picker.md` | message-branch-reason |
| `docs/primitives/composer.md` | composer-input |
| `docs/primitives/message.md` | message-branch-reason |
| `docs/primitives/thread-list.md` | thread-and-list |
| `docs/primitives/thread.md` | thread-and-list |
| `docs/runtimes/pick-a-runtime.md` | architecture-runtimes |
| `docs/runtimes/a2a/overview.md` | cloud-integrations |
| `docs/runtimes/ag-ui/overview.md` | cloud-integrations |
| `docs/runtimes/ai-sdk/overview.md` | cloud-integrations |
| `docs/runtimes/concepts/adapters.md` | architecture-runtimes |
| `docs/runtimes/concepts/architecture.md` | architecture-runtimes |
| `docs/runtimes/concepts/threads.md` | thread-and-list |
| `docs/runtimes/custom/assistant-transport.md` | architecture-runtimes |
| `docs/runtimes/custom/data-stream.md` | architecture-runtimes |
| `docs/runtimes/custom/external-store.md` | architecture-runtimes |
| `docs/runtimes/custom/local-runtime.md` | architecture-runtimes |
| `docs/runtimes/custom/overview.md` | architecture-runtimes |
| `docs/runtimes/google-adk/overview.md` | cloud-integrations |
| `docs/runtimes/langgraph/overview.md` | cloud-integrations |
| `docs/runtimes/opencode/overview.md` | cloud-integrations |
| `docs/tools/defining-tools.md` | tools-generative |
| `docs/tools/generative-ui.md` | tools-generative |
| `docs/tools/interactables.md` | tools-generative |
| `docs/tools/mcp-apps.md` | mcp |
| `docs/tools/mcp.md` | mcp |
| `docs/tools/multi-agent.md` | tools-generative |
| `docs/tools/tool-ui.md` | tools-generative |
| `docs/tools/user-managed-mcp.md` | mcp |
| `docs/ui/context-display.md` | ui-content |
| `docs/ui/diff-viewer.md` | ui-content |
| `docs/ui/markdown.md` | ui-content |
| `docs/ui/mcp-config.md` | mcp |
| `docs/ui/model-selector.md` | ui-content |
| `docs/ui/reasoning.md` | message-branch-reason |
| `docs/ui/streamdown.md` | ui-content |
| `docs/ui/thread-list.md` | thread-and-list |
| `docs/ui/thread.md` | thread-and-list |

### 6.2 Grouped pages (covered by a family verdict)

| Page | Family |
|---|---|
| `docs/cli.md` | utilities-copilot-migration |
| `docs/devtools.md` | utilities-copilot-migration |
| `docs/cloud/ai-sdk-assistant-ui.md` | cloud-integrations |
| `docs/cloud/ai-sdk.md` | cloud-integrations |
| `docs/cloud/authorization.md` | cloud-integrations |
| `docs/cloud/langgraph.md` | cloud-integrations |
| `docs/copilots/assistant-frame.md` | utilities-copilot-migration |
| `docs/copilots/make-assistant-visible.md` | utilities-copilot-migration |
| `docs/copilots/motivation.md` | utilities-copilot-migration |
| `docs/copilots/use-assistant-instructions.md` | utilities-copilot-migration |
| `docs/guides/context-api.md` | architecture-runtimes |
| `docs/guides/editing.md` | message-branch-reason |
| `docs/guides/input-history.md` | composer-input |
| `docs/guides/latex.md` | ui-content |
| `docs/guides/message-timing.md` | message-branch-reason |
| `docs/guides/quoting.md` | ui-content |
| `docs/guides/resumable-stream-deployment.md` | architecture-runtimes |
| `docs/guides/resumable-stream-stores.md` | architecture-runtimes |
| `docs/integrations.md` | cloud-integrations |
| `docs/integrations/attachments/custom-adapter.md` | ui-content |
| `docs/integrations/auth/better-auth.md` | cloud-integrations |
| `docs/integrations/auth/clerk.md` | cloud-integrations |
| `docs/integrations/auth/next-auth.md` | cloud-integrations |
| `docs/integrations/frameworks/ai-sdk.md` | cloud-integrations |
| `docs/integrations/gateways.md` | cloud-integrations |
| `docs/integrations/observability/helicone.md` | cloud-integrations |
| `docs/integrations/observability/langfuse.md` | cloud-integrations |
| `docs/integrations/observability/langsmith.md` | cloud-integrations |
| `docs/integrations/persistence/custom-adapter.md` | cloud-integrations |
| `docs/integrations/frameworks/cloudflare-agents/overview.md` | cloud-integrations |
| `docs/integrations/frameworks/mastra/full-stack.md` | cloud-integrations |
| `docs/integrations/frameworks/mastra/separate-server.md` | cloud-integrations |
| `docs/migrations/deprecation-policy.md` | utilities-copilot-migration |
| `docs/migrations/react-compatibility.md` | utilities-copilot-migration |
| `docs/migrations/react-langgraph-v0-7.md` | utilities-copilot-migration |
| `docs/migrations/toolkit-tools.md` | utilities-copilot-migration |
| `docs/migrations/v0-11.md` | utilities-copilot-migration |
| `docs/migrations/v0-12.md` | utilities-copilot-migration |
| `docs/primitives/assistant-modal.md` | thread-and-list |
| `docs/primitives/attachment.md` | ui-content |
| `docs/primitives/chain-of-thought.md` | message-branch-reason |
| `docs/primitives/error.md` | ui-content |
| `docs/primitives/selection-toolbar.md` | ui-content |
| `docs/primitives/suggestion.md` | composer-input |
| `docs/runtimes/langchain.md` | architecture-runtimes |
| `docs/runtimes/a2a/client-and-hooks.md` | architecture-runtimes |
| `docs/runtimes/a2a/quickstart.md` | architecture-runtimes |
| `docs/runtimes/ag-ui/quickstart.md` | architecture-runtimes |
| `docs/runtimes/ag-ui/runtime-options.md` | architecture-runtimes |
| `docs/runtimes/ai-sdk/v4-legacy.md` | utilities-copilot-migration |
| `docs/runtimes/ai-sdk/v5-legacy.md` | utilities-copilot-migration |
| `docs/runtimes/ai-sdk/v6.md` | cloud-integrations |
| `docs/runtimes/concepts/stability.md` | utilities-copilot-migration |
| `docs/runtimes/eve/overview.md` | cloud-integrations |
| `docs/runtimes/eve/quickstart.md` | cloud-integrations |
| `docs/runtimes/google-adk/api.md` | cloud-integrations |
| `docs/runtimes/google-adk/hooks.md` | cloud-integrations |
| `docs/runtimes/google-adk/quickstart.md` | cloud-integrations |
| `docs/runtimes/langgraph/generative-ui.md` | tools-generative |
| `docs/runtimes/langgraph/interrupts.md` | tools-generative |
| `docs/runtimes/langgraph/quickstart.md` | cloud-integrations |
| `docs/runtimes/langgraph/streaming.md` | cloud-integrations |
| `docs/runtimes/langgraph/threads.md` | cloud-integrations |
| `docs/runtimes/opencode/hooks.md` | cloud-integrations |
| `docs/runtimes/opencode/quickstart.md` | cloud-integrations |
| `docs/tools/backend.md` | tools-generative |
| `docs/tools/dynamic-tools.md` | tools-generative |
| `docs/tools.md` | tools-generative |
| `docs/tools/interactables-legacy.md` | tools-generative |
| `docs/ui/accordion.md` | ui-content |
| `docs/ui/assistant-modal.md` | thread-and-list |
| `docs/ui/assistant-sidebar.md` | thread-and-list |
| `docs/ui/attachment.md` | ui-content |
| `docs/ui/badge.md` | utilities-copilot-migration |
| `docs/ui/composer-trigger-popover.md` | composer-input |
| `docs/ui/directive-text.md` | composer-input |
| `docs/ui/dot-matrix.md` | utilities-copilot-migration |
| `docs/ui/file.md` | ui-content |
| `docs/ui/follow-up-suggestions.md` | composer-input |
| `docs/ui/image.md` | ui-content |
| `docs/ui/mermaid.md` | ui-content |
| `docs/ui/message-timing.md` | message-branch-reason |
| `docs/ui/number-roll.md` | utilities-copilot-migration |
| `docs/ui/part-grouping.md` | ui-content |
| `docs/ui/quote.md` | ui-content |
| `docs/ui/select.md` | utilities-copilot-migration |
| `docs/ui/sources.md` | ui-content |
| `docs/ui/syntax-highlighting.md` | ui-content |
| `docs/ui/tabs.md` | utilities-copilot-migration |
| `docs/ui/tool-fallback.md` | tools-generative |
| `docs/ui/tool-group.md` | tools-generative |
| `docs/utilities/heat-graph.md` | utilities-copilot-migration |
| `docs/utilities/react-o11y.md` | utilities-copilot-migration |
| `docs/utilities/tw-shimmer.md` | utilities-copilot-migration |
| `docs/api-reference/context-providers/assistant-runtime-provider.md` | architecture-runtimes |
| `docs/api-reference/context-providers.md` | architecture-runtimes |
| `docs/api-reference/context-providers/scoped-providers.md` | architecture-runtimes |
| `docs/api-reference/adapters/attachments.md` | ui-content |
| `docs/api-reference/adapters/feedback.md` | message-branch-reason |
| `docs/api-reference/adapters.md` | architecture-runtimes |
| `docs/api-reference/adapters/model.md` | architecture-runtimes |
| `docs/api-reference/adapters/persistence.md` | cloud-integrations |
| `docs/api-reference/adapters/runtime.md` | architecture-runtimes |
| `docs/api-reference/adapters/suggestions.md` | composer-input |
| `docs/api-reference/external-store.md` | architecture-runtimes |
| `docs/api-reference/external-store/message-conversion.md` | architecture-runtimes |
| `docs/api-reference/external-store/runtime.md` | architecture-runtimes |
| `docs/api-reference/generative-ui/actions.md` | tools-generative |
| `docs/api-reference/generative-ui/components.md` | tools-generative |
| `docs/api-reference/generative-ui.md` | tools-generative |
| `docs/api-reference/generative-ui/json-generative-ui.md` | tools-generative |
| `docs/api-reference/generative-ui/rendering.md` | tools-generative |
| `docs/api-reference/generative-ui/spec.md` | tools-generative |
| `docs/api-reference/generative-ui/tokens.md` | tools-generative |
| `docs/api-reference/integrations/cloud-ai-sdk.md` | cloud-integrations |
| `docs/api-reference/integrations/eve.md` | cloud-integrations |
| `docs/api-reference/integrations.md` | cloud-integrations |
| `docs/api-reference/integrations/react-ai-sdk.md` | cloud-integrations |
| `docs/api-reference/integrations/react-data-stream.md` | architecture-runtimes |
| `docs/api-reference/hooks/composer-triggers.md` | composer-input |
| `docs/api-reference/hooks/model-context.md` | utilities-copilot-migration |
| `docs/api-reference/hooks/runtimes.md` | architecture-runtimes |
| `docs/api-reference/hooks/utilities.md` | utilities-copilot-migration |
| `docs/api-reference/model-context/context.md` | utilities-copilot-migration |
| `docs/api-reference/model-context.md` | utilities-copilot-migration |
| `docs/api-reference/model-context/registry.md` | utilities-copilot-migration |
| `docs/api-reference/runtimes/assistant-runtime.md` | architecture-runtimes |
| `docs/api-reference/runtimes/attachment-runtime.md` | ui-content |
| `docs/api-reference/runtimes/composer-runtime.md` | composer-input |
| `docs/api-reference/runtimes/message-part-runtime.md` | message-branch-reason |
| `docs/api-reference/runtimes/message-runtime.md` | message-branch-reason |
| `docs/api-reference/runtimes/queue-state.md` | architecture-runtimes |
| `docs/api-reference/runtimes/thread-list-item-runtime.md` | thread-and-list |
| `docs/api-reference/runtimes/thread-list-runtime.md` | thread-and-list |
| `docs/api-reference/runtimes/thread-runtime.md` | thread-and-list |
| `docs/api-reference/primitives/action-bar-more.md` | message-branch-reason |
| `docs/api-reference/primitives/action-bar.md` | message-branch-reason |
| `docs/api-reference/primitives/assistant-modal.md` | thread-and-list |
| `docs/api-reference/primitives/attachment.md` | ui-content |
| `docs/api-reference/primitives/branch-picker.md` | message-branch-reason |
| `docs/api-reference/primitives/chain-of-thought.md` | message-branch-reason |
| `docs/api-reference/primitives/composer.md` | composer-input |
| `docs/api-reference/primitives/error.md` | ui-content |
| `docs/api-reference/primitives/message-part.md` | message-branch-reason |
| `docs/api-reference/primitives/message.md` | message-branch-reason |
| `docs/api-reference/primitives/queue-item.md` | architecture-runtimes |
| `docs/api-reference/primitives/selection-toolbar.md` | ui-content |
| `docs/api-reference/primitives/suggestion.md` | composer-input |
| `docs/api-reference/primitives/thread-list-item-more.md` | thread-and-list |
| `docs/api-reference/primitives/thread-list-item.md` | thread-and-list |
| `docs/api-reference/primitives/thread-list.md` | thread-and-list |
| `docs/api-reference/primitives/thread.md` | thread-and-list |
| `docs/api-reference/tools/component-tools.md` | tools-generative |
| `docs/api-reference/tools.md` | tools-generative |
| `docs/api-reference/tools/interactables-legacy.md` | tools-generative |
| `docs/api-reference/tools/interactables.md` | tools-generative |
| `docs/api-reference/tools/rendering.md` | tools-generative |
| `docs/api-reference/tools/status.md` | tools-generative |
| `docs/api-reference/tools/toolkits.md` | tools-generative |
| `docs/api-reference/transport/assistant-transport.md` | architecture-runtimes |
| `docs/api-reference/transport/frame.md` | utilities-copilot-migration |
| `docs/api-reference/transport.md` | architecture-runtimes |
| `docs/api-reference/utilities.md` | utilities-copilot-migration |
| `docs/api-reference/utilities/miscellaneous.md` | utilities-copilot-migration |
| `docs/api-reference/voice/speech-dictation.md` | composer-input |

### 6.3 Out-of-scope pages (with reason)

| Page | Reason |
|---|---|
| `docs.md` | top-level docs landing/index page, not a content page |
| `docs/installation.md` | pure setup/install instructions, no comparable UI/architecture surface |
| `docs/llm.md` | meta docs about AI-assisted tooling, not product surface |
| `docs/rtl.md` | cross-cutting i18n/RTL support note, not a distinct family surface |
| `docs/guides/chatgpt-subscription.md` | provider/auth setup recipe (ChatGPT via Codex OAuth), not a UI/architecture surface |
| `docs/guides.md` | guides index/landing page, not content itself |
| `docs/guides/speech.md` | text-to-speech output feature, no home in the 9 families (dictation covers input only) |
| `docs/guides/virtualization.md` | thread virtualization - explicitly out of scope, owned by plan 58.4 (non-virtualization perf lessons recorded in the matrix) |
| `docs/guides/voice.md` | realtime bidirectional voice chat, not covered by any of the 9 families |
| `docs/ink/adapters.md` | React Ink (terminal) platform-specific adapters, out of web assistant-ui scope |
| `docs/ink/custom-backend.md` | React Ink terminal platform, out of scope |
| `docs/ink/hooks.md` | React Ink terminal platform, out of scope |
| `docs/ink.md` | React Ink terminal platform overview, out of scope |
| `docs/ink/migration.md` | React Ink migration guide, out of scope |
| `docs/ink/primitives.md` | React Ink terminal primitives, out of scope |
| `docs/primitives.md` | primitives index/landing page summarizing the family, not distinct content |
| `docs/react-native/adapters.md` | React Native platform-specific adapters, out of web assistant-ui scope |
| `docs/react-native/custom-backend.md` | React Native platform, out of scope |
| `docs/react-native/hooks.md` | React Native platform, out of scope |
| `docs/react-native.md` | React Native platform overview, out of scope |
| `docs/react-native/migration.md` | React Native migration guide, out of scope |
| `docs/react-native/primitives.md` | React Native platform primitives, out of scope |
| `docs/runtimes/langgraph/tutorial/introduction.md` | multi-part end-to-end tutorial walkthrough, not a discrete surface page |
| `docs/runtimes/langgraph/tutorial/part-1.md` | tutorial walkthrough, not a discrete surface page |
| `docs/runtimes/langgraph/tutorial/part-2.md` | tutorial walkthrough, not a discrete surface page |
| `docs/runtimes/langgraph/tutorial/part-3.md` | tutorial walkthrough, not a discrete surface page |
| `docs/ui/scrollbar.md` | generic scrollbar styling utility, tied to virtualization/scroll concerns owned by plan 58.4 |
| `docs/ui/voice.md` | realtime voice session controls, no home among the 9 families |
| `docs/api-reference/overview.md` | API reference index page, not comparable product/UI content |
| `docs/api-reference/hooks.md` | hooks API reference index page, not distinct content |
| `docs/api-reference/hooks/primitives.md` | cross-cutting primitive-hooks reference incl. viewport/virtualization behavior, no single family fit |
| `docs/api-reference/hooks/state.md` | cross-cutting state-hooks reference spanning multiple families, no single family fit |
| `docs/api-reference/runtimes.md` | runtime state API reference index, not distinct content |
| `docs/api-reference/primitives/assistant-if.md` | generic conditional-rendering primitive spanning all state, no single family fit |
| `docs/api-reference/primitives/composition.md` | generic asChild composition mechanics, cross-cutting, no single family fit |
| `docs/api-reference/primitives.md` | primitives API reference index page, not distinct content |
| `docs/api-reference/voice.md` | realtime voice/dictation API reference, no family fit beyond the dictation guide already grouped |
| `docs/api-reference/voice/session.md` | realtime voice session API, no family fit |
| `examples/ai-sdk.md` | end-to-end example app, not a discrete docs surface page |
| `examples/artifacts.md` | end-to-end example app |
| `examples/chatgpt.md` | end-to-end example app |
| `examples/claude.md` | end-to-end example app |
| `examples/expo.md` | end-to-end example app, React Native platform |
| `examples/form-demo.md` | end-to-end example app |
| `examples/gemini.md` | end-to-end example app |
| `examples/generative-ui.md` | end-to-end example app (live demo), not a discrete docs surface page |
| `examples/grok.md` | end-to-end example app |
| `examples.md` | examples index/landing page |
| `examples/mem0.md` | end-to-end example app |
| `examples/modal.md` | end-to-end example app |
| `examples/perplexity.md` | end-to-end example app |
| `examples/stockbroker.md` | end-to-end example app / tutorial demo |


## 7. Uncertainty notes and contrarian-review prompts

### 7.1 Verify-pass corrections folded into the matrix

The source-verification pass contradicted the original research in seven places. Observed
source truth was preferred in every case; no verdict flipped, but evidence and follow-ups
changed:

- **[V1] (A5)** Original claim "no content-visibility anywhere in apps/web" was false: dead
  `assistant-ui/thread.tsx:317/:446` carries a vendored reference implementation with per-kind
  intrinsic-size estimates. Corrected to "none in any LIVE path"; the dead file is now cited as
  an asset for the follow-up.
- **[V2] (D1)** The second markdown stack is not "only a type import": it is an idle-FETCHED,
  never-rendered chunk on every load (`markdown-text-lazy.tsx` preloadOnIdle, commit a65abd4b).
  Pruning upgraded from minor dep hygiene to shortlist item 3.1(2).
- **[V3] (D8)** The claimed effort-reset UX gap does not exist: per-model sticky effort is
  already implemented and tested (`model-preferences.ts`). The port-resolveModelEffort
  follow-up was deleted (section 3.4).
- **[V4] (C7)** The live reasoning path uses no assistant-ui part components or grouping;
  `ReasoningMessagePartComponent` is a type-only import. The real live runtime dependency is
  `useScrollLock` (`use-collapsible-disclosure.ts:3`), which is therefore the pinned churn
  surface for the stability ledger, not the reasoning part API.
- **[V5] (C1)** "Belay already borrows groupPartByType" was wrong: it appears only in dead
  `thread.tsx`. Live grouping is fully projection-owned.
- **[V6] (D4)** The open question on mermaid error degradation was verified answered-yes
  (`mermaid-block.tsx:292-294,378-388`); confidence raised medium to high.
- **[V7] (B3/B4/B5)** Three citation paths were wrong by one directory level: the live files
  are `apps/web/src/hooks/use-prompt-history.ts`, `apps/web/src/hooks/use-file-mention-menu.ts`,
  and `apps/web/src/built-in-commands.ts`. All behavior claims held.

### 7.2 Remaining uncertainties

- **Medium-confidence rows** (18 of 107) are marked in the matrix; the largest cluster is the
  Track B adapter family (E4, A14, A16, A17, E8), where no spike has run and render-cost and
  lossiness claims are reasoned, not measured.
- **Streamdown (D2)** and **content-visibility (A5)** both carry unmeasured performance
  claims; each follow-up is gated on a benchmark before any adoption decision.
- **Dead `thread.tsx` intent** is inferred (evaluated-and-left-unwired) from git history
  (touched by a65abd4b), not from a recorded decision; if the intent was different, the A-family
  defer/reject framing should be re-examined.
- **Plan 50 interaction** is flagged from plan titles and the transport seam only; the live
  plan's actual scope was not deeply audited here.
- The matrix trusts assistant-ui docs' own maturity labels (unstable_/Beta/Enterprise); no
  independent verification of upstream stability was performed.

### 7.3 Contrarian-review prompts for future model passes

Carry these into any later review; each names the row whose verdict it attacks.

1. (A1) For multi-screen oversized turns, is Belay's bottom-snap actually worse reading UX
   than assistant-ui's default top-anchor, and should the virtual-transcript surface A/B it?
2. (A5) Do Belay's variable-height rows (diffs, tool output, reasoning) have stable enough
   intrinsic-size estimates that content-visibility will not cause visible scroll jumps?
3. (A13) Would host-side LLM session auto-titling (Belay-owned generateTitle) improve sidebar
   scannability enough to warrant its own small plan?
4. (A14/E4) Could an ExternalStore(ThreadList)Adapter mirror Belay's read model so assistant-ui
   primitives become available while the durable log stays sole source of truth - and is that
   mirror cheaper than Belay's bespoke rows, or just a converter plus a thread-id-sync footgun?
5. (A16) Is Belay's event taxonomy (compaction/delegation/tangent/hook/limits) too rich to
   project losslessly into `{id,parent_id,format,content}` rows, making any adapter a lossy
   view rather than a bridge?
6. (B1) Could queue + vim + hard-steer be expressed as isSendDisabled plus a custom send
   adapter, or are they fundamentally incompatible with a single-composer send model?
7. (B4) Is serializing mentions as directive text (an audit trail visible to the model) a
   better contract for context injection than file-path insertion?
8. (B6) Does consolidating slash + file-mention + palette behind one trigger-popover controller
   remove enough duplication to justify the refactor, given they already share
   autocomplete-menu.tsx?
9. (A10) Is a keyboard-navigable overflow menu worth building when power users drive the
   sidebar largely via the command palette?
10. (C2) Would a subtle smooth-reveal improve perceived latency without betraying the
    terminal-honest streaming identity?
11. (C3) For quick re-phrasings, is a full tangent session heavier than users want compared to
    an inline branch, and should Belay offer both?
12. (C6) Does Belay want an explicit regenerate-last-assistant-turn action, and does it map
    onto turn replay or a fresh run?
13. (D1) Should Belay drop @assistant-ui/react-markdown entirely (inlining the one type)?
14. (D2) At what message length does whole-text re-lex-per-frame actually cost enough to
    justify Streamdown's bundle and a second markdown engine?
15. (D3) Are highlight.js grammars materially worse than shiki for the languages Belay's
    users actually paste, or is the difference cosmetic?
16. (D5) How often do coding-focused sessions actually emit LaTeX; is the katex bundle worth it?
17. (E6) If Belay grows rich mutable workflow state that is not naturally event-shaped, is
    AssistantTransport's snapshot model a reject-forever or reject-until-workflow-UI?
18. (E7) When Tether is the transport, is there a mid-turn producer-survives-disconnect gap
    that byte-level buffering would close but afterSeq event replay would not?
19. (E8) Does the supervisor-spawn/new-session path have an append-before-durable-init race,
    and is a guard present today?
20. (E11) If multi-device session roaming ever becomes a goal, what is the smallest Belay-owned
    durable-log replication primitive that satisfies it without hosted auth?
21. (E17) When the worktree fleet delegates across machines, is A2A's task-state + artifact
    wire a better substrate than extending protocol/events.ts, or does the durable seq-log
    already subsume it?
22. (E24) Can a self-hosted OTel trace carry the planner->tool->LLM hierarchy while honoring
    the no-conversation-content rule, or does useful tracing inherently require content Belay
    refuses to export (flipping defer to reject)?
23. (F1) If Belay ever adds genuinely browser-executed tools (clipboard, DOM), does
    hand-rolling registration cost more than adopting just the toolkit's frontend/human kinds?
24. (F3) Are any provider-native tools (code interpreter, provider web search) now good enough
    to justify a passthrough lane that skips host normalization?
25. (F6) Does elapsed time on every running tool add noise, or should it appear only after an
    N-second threshold as a stuck-tool signal?
26. (F9) When workflow rendering lands, is a data-part channel actually simpler than emitting
    durable workflow.* events the existing projector folds?
27. (F11) Does Belay want ANY model-authored UI, or is Lucid's human-authored-artifact model
    the deliberate boundary that should stay?
28. (F12) Is there an interactive-form case (handoff approval with inline edits) where an
    explicit durable form.submitted event captures the same UX without a hidden write path?
29. (F13) Should workflow structure render inline in the transcript at all, or belong in the
    support panel where running delegations already surface?
30. (F15) Does Belay's host-lifetime MCP connection ever hold a dead socket the per-request
    model would side-step - is there a reconnection/backoff gap worth mining?
31. (F17) Is file-based MCP config a deliberate local-first simplicity, or a real operator
    friction point?
32. (F19) If a valued MCP server ships a ui:// widget, is a sandboxed iframe acceptable in a
    local-first app, or is host-rendered structured output the boundary?
33. (G2) Is a span waterfall worth an experimental dependency, or do the side-panel
    token/context surfaces plus /doctor already answer the latency questions Belay asks?
34. (G4) Do web projector bugs happen often enough to justify a devtools panel, given the
    durable log can already be replayed offline?
35. (G6) Is there a browser-only piece of context (current UI view state) the host genuinely
    cannot see that would justify a narrow component-scoped instruction channel?
36. (G7) Is there any UI-control task compelling enough to justify a mediated,
    provenance-logged assistant-visibility variant - and if so, would that not be a host tool?
37. (G8) For each vendored component, is Belay's local modification worth the drift cost, or
    should some (e.g. tool-fallback) track upstream directly instead of being forked?
38. (E19) If Belay exposes sessions to a non-Belay assistant-ui frontend, does the OpenCode
    ExternalStore+RemoteThreadList mapping generalize to the seq-log, or does durable-replay
    semantics force a bespoke adapter anyway?
