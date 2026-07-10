# Assistant-UI Pattern Audit

## Scope

This report audits the official assistant-ui documentation corpus against Trevor's current surfaces.
It is research only: it recommends follow-up plan candidates, but it does not implement an
assistant-ui runtime migration or replace Trevor-owned session, transport, tool, model, artifact, or
diagnostic contracts.

Thread virtualization is explicitly excluded. Plan `58.4` remains the owner for that adoption path.

Primary assistant-ui sources:

- [Docs index](https://www.assistant-ui.com/docs)
- [LLM docs index](https://www.assistant-ui.com/llms.txt)
- [Full LLM docs corpus](https://www.assistant-ui.com/llms-full.txt)

Permanent copy after completed-plan cleanup:

- `docs/research/assistant-ui-pattern-audit.md`

## Verdict Rubric

| Criterion | Question |
|-----------|----------|
| Source-of-truth fit | Can the assistant-ui primitive wrap Trevor state without owning it? |
| Local-first fit | Does the pattern avoid hosted persistence, hosted auth, or hidden remote state? |
| Accessibility | Does it improve keyboard, focus, screen-reader, or reduced-motion behavior? |
| Testability | Can Trevor verify it with current unit/web/browser lanes? |
| Runtime/bundle cost | Does it add meaningful bundle or runtime complexity? |
| API stability | Is the API stable or marked unstable/migration-prone? |
| Migration blast radius | Can it ship as a bounded component change rather than a protocol rewrite? |

Verdicts:

- `adopt`: use assistant-ui primitive/component/API directly.
- `adapt`: borrow the shape or wrap the primitive while preserving Trevor ownership.
- `keep Trevor-owned`: current Trevor behavior is stronger or more domain-specific.
- `defer`: worthwhile later, but blocked by another plan or missing product need.
- `reject`: conflicts with Trevor architecture, privacy, local-first storage, or product scope.

## Documentation Corpus Worksheet

| Docs category | Representative pages | Type | Trevor decision surface |
|---------------|----------------------|------|-------------------------|
| Architecture | `/docs/architecture.md`, `/docs/runtimes/concepts/architecture.md` | vocabulary/runtime boundaries | session log, `SessionTransport`, host loop, web projection |
| Cloud | `/docs/cloud.md`, `/docs/cloud/ai-sdk.md`, `/docs/cloud/authorization.md` | hosted persistence/auth/telemetry | local session-store, blob-store, private local app |
| Runtime concepts | `/docs/runtimes/custom/external-store.md`, `/local-runtime.md`, `/assistant-transport.md`, `/data-stream.md` | runtime/protocol | `@trevor/session`, `streamTransport`, host `assistant.*` events |
| Runtimes/integrations | AI SDK, LangGraph, LangChain, Mastra, A2A, AG-UI, ADK, OpenCode, Eve | protocol adapters | Trevor provider/host loop and shared `/sessions` protocol |
| Thread primitives | `/docs/primitives/thread.md`, `/docs/primitives/thread-list.md` | UI primitives | transcript, sidebar, archive/resume/worktree surfaces |
| Composer primitives | `/docs/primitives/composer.md`, headless composer guide, slash/mentions/history guides | UI primitives/hooks | `useComposer`, `PromptInput`, slash/file menus, Vim, queue |
| Message primitives | message, action bar, branch picker, error, suggestion | UI primitives | transcript rows, tangent/replay semantics, error rows |
| Attachments | attachment primitive, attachment guides/adapters, image generation | UI/adapter | blob-store `ArtifactRef`, composer uploads, image carousel |
| Selection/quote | selection toolbar and quote guides | UI primitive | quote toolbar plus tangent creation |
| Reasoning | chain-of-thought primitive/guide, reasoning component | UI primitive | `ReasoningTrace`, `assistant.thinking` rows |
| Tool UI/toolkits | backend/frontend/dynamic tools, tool UI, tool fallback/group, generative UI, interactables | tool execution/UI | host-owned tools, MCP, structured tool rows, Lucid |
| MCP/multi-agent | MCP apps, MCP servers, user-managed MCP, multi-agent chat UI | tools/UI | host MCP runtime, delegation rows, inline agent rows |
| Model/context/timing | model selector, model context, message timing, token stats, context display | UI/context | model catalog projection, usage breakdown, context pressure |
| Markdown/rendering | markdown, streamdown, syntax highlighting, Mermaid, LaTeX, diff viewer, sources | UI rendering | MarkdownBody, assistant-ui wrappers, diff/source rows |
| Voice | dictation, TTS, realtime voice | browser/audio | no current Trevor voice surface |
| Devtools/observability | DevTools, react-o11y, heat graph, observability integrations | diagnostics | `/doctor`, telemetry spans, debug panel |
| Copilots | assistant frame, model context providers, intelligent components, assistant instructions | embedded assistant APIs | tool-proxy/browser tools, Lucid review loop, future browser assistant |
| CLI/migrations/stability | assistant-ui CLI, registry, codemods, migration docs, deprecation policy | maintenance | copied wrappers, package pins, dependency update workflow |
| RTL/Ink/React Native | RTL support, terminal/mobile variants | platform support | not current Trevor product scope |

## Trevor Ownership Survey

| Boundary | Current owner evidence |
|----------|------------------------|
| Durable protocol/state | `packages/session`, `apps/web/src/session/use-session.ts`, `apps/web/src/session/projection.ts` |
| Transcript projection/rendering | `apps/web/src/transcript.ts`, `apps/web/src/transcript-rows.ts`, `apps/web/src/components/chat/virtual-transcript.tsx` |
| assistant-ui wrapper layer | `apps/web/src/components/assistant-ui/*`, `@assistant-ui/react`, `@assistant-ui/react-markdown` in `apps/web/package.json` |
| Composer/file intake | `apps/web/src/hooks/use-composer.ts`, `apps/web/src/components/chat/prompt-input.tsx`, composer draft token helpers |
| Slash/file menus | `apps/web/src/app.tsx`, command/file mention components under `apps/web/src/components/chat` |
| Model selection | `apps/web/src/model-selection.ts`, `apps/web/src/components/assistant-ui/model-selector.tsx`, `CONTEXT.md` catalog read entry |
| Attachments/artifacts | `apps/web/src/blob.ts`, `apps/web/src/artifact-thumb.tsx`, `apps/web/src/components/chat/message-attachments.tsx` |
| Reasoning | `apps/web/src/components/assistant-ui/reasoning.tsx`, `apps/web/src/components/chat/reasoning-trace.tsx` |
| Tool rendering | `apps/web/src/components/assistant-ui/tool-fallback.tsx`, `tool-group.tsx`, `apps/web/src/components/chat/tool-status.ts`, host tools in `apps/agent-host/src/tools` |
| Diffs | `apps/web/src/components/assistant-ui/diff-viewer.tsx`, `apps/web/src/components/chat/tool-diff.tsx`, `multi-edit-diff.tsx` |
| MCP | `apps/agent-host/src/mcp`, `apps/agent-host/src/tools/mcp.ts`, UI tool rows |
| Tangents/branching | `packages/session/src/tangent.ts`, `apps/web/src/session/use-session.ts`, `apps/agent-host/src/session/tangent-adoption.ts` |
| Diagnostics | `apps/agent-host/src/doctor`, `apps/web/src/components/chat/doctor`, `packages/session/src/metrics.ts` |
| Session/thread list | project sidebar, resume/archive/worktree components under `apps/web/src/sidebar`, `apps/web/src/resume`, `apps/web/src/worktrees` |
| Future-only/no surface | Voice, hosted auth, Assistant Cloud, React Native, Ink, broad copilot frame APIs |

## Adoption Matrix

| Pattern | assistant-ui evidence | Trevor evidence | Verdict | Rationale and risks |
|---------|-----------------------|-----------------|---------|---------------------|
| Architecture layers | `/docs/architecture.md` separates UI, runtime, backend, protocol, persistence | `use-session.ts`, `projection.ts`, host loop, `SessionTransport` over local session-store by default or Tether when configured | `adapt` | Use vocabulary for future plans. Do not move ownership. Adopting runtime ownership would blur Trevor's durable log and backend selection boundary; ignoring vocabulary keeps docs harder to compare. Follow-up: `58.16-assistant-ui-architecture-vocabulary-note`. |
| `ExternalStoreRuntime` | `/docs/runtimes/custom/external-store.md` | `createSessionReadModel`, `toTranscript`, `streamTransport` | `adapt` | Best candidate for assistant-ui primitives over Trevor state. Treat as UI adapter only. Risk adopting: assistant-ui may expect composer/thread ownership Trevor already has. Risk ignoring: copied wrappers drift. Follow-up: `58.8-assistant-ui-external-store-thread-adapter`. |
| `LocalRuntime` | `/docs/runtimes/custom/local-runtime.md` | durable session-store + host stream | `reject` | It owns local chat state while Trevor persists every event. It is useful as docs vocabulary, not implementation. |
| `AssistantTransport` / data-stream | `/docs/runtimes/custom/assistant-transport.md`, `/data-stream.md` | shared `/sessions` REST/WS contract and `assistant.*` events | `reject` | Runtime replacement would add a second protocol. Conversion ideas may inform adapters, but source of truth stays Trevor's `SessionTransport` contract. |
| Thread primitive | `/docs/primitives/thread.md` | `VirtualTranscript`, plan 58.4 | `defer` | Non-virtual affordances can be reviewed after 58.4. Virtualization remains excluded here. |
| Thread list / cloud persistence | `/docs/primitives/thread-list.md`, `/docs/cloud.md` | sidebar inventory, archive/resume/worktree rows | `adapt` | Borrow thread-list affordances for naming/empty states. Reject cloud persistence. Follow-up: `58.9-session-sidebar-thread-list-affordance-audit`. |
| Assistant Cloud | cloud docs and authorization docs | local session-store/blob-store, private local app | `reject` | Conflicts with local-first storage, private repo, and no hosted auth requirement. Risk ignoring is low because Trevor already has persistence. |
| Composer primitive/headless input | `/docs/primitives/composer.md`, `/docs/guides/headless-composer-input.md` | `useComposer`, `PromptInput`, Vim, image/paste tokens | `keep Trevor-owned` | Trevor composer has image tokens, large-paste tokens, shell lane, Vim suspension, queue semantics. Use assistant-ui only for isolated presentational ideas. Follow-up only if external-store adapter proves compatible. |
| Slash commands / mentions popovers | `/docs/guides/slash-commands.md`, `/docs/guides/mentions.md` | slash menu, file mention menu, command preview | `adapt` | Trevor has duplicate trigger/popup behavior. Borrow trigger abstraction if it reduces duplication without owning command semantics. Follow-up: `58.10-composer-trigger-popover-unification`. |
| Input history | `/docs/guides/input-history.md` | tab-scoped prompt history keyed by `webTabId` | `keep Trevor-owned` | Trevor's tab-scoped persistence is intentional. A primitive can wrap it only if it does not globalize history. |
| Suggestions | `/docs/guides/suggestions.md`, suggestion primitive | starter UI only; no durable suggestion product | `defer` | Product need is not explicit. Risk adopting now: decorative prompts without source. |
| Attachments/adapters | attachment primitive, attachment guide, custom adapter docs | blob-store uploads, `ArtifactRef`, `MessageAttachments` | `adapt` | Adapter shape is valuable, storage must remain blob-store. Follow-up: `58.11-artifact-attachment-adapter-shape`. |
| File/image components | attachment primitive and image guide | `ArtifactThumb`, `MessageImages`, carousel | `adapt` | Presentational cleanup may pay off; do not alter artifact refs. Follow-up: covered by `58.11-artifact-attachment-adapter-shape`. |
| Image generation rendering | image generation guide | artifact panel/image carousel/Lucid artifacts | `adapt` | Rendering patterns only. Generation stays provider/tool-owned. Follow-up: covered by `58.11-artifact-attachment-adapter-shape`. |
| Quote selected text | quote guide and selection toolbar primitive | `quote-selection-toolbar`, tangent creation | `keep Trevor-owned` | Trevor quote is tied to tangent semantics. Mine placement/accessibility tests only. |
| Branch picker/editing/regenerate | branch picker, branching/editing guides | tangent sessions, supersession, queue, no generic regenerate | `keep Trevor-owned` | assistant-ui branching is message-alternative UI; Trevor branches are isolated sessions. Reopen only after explicit regenerate semantics. |
| Action bar | action bar primitive | message/tool row controls | `defer` | Useful only when Trevor formalizes copy/regenerate/retry actions per row. |
| Error primitive | error primitive | transcript error rows, `assistant.completed.error`, provider diagnostics | `adapt` | Error presentation patterns can help, but typed failures remain Trevor-owned. Follow-up: covered by `58.14-browser-diagnostics-inspector-spike`. |
| Reasoning / chain of thought | reasoning/chain-of-thought docs and primitives | `ReasoningTrace`, assistant-ui `ReasoningGroup` wrapper | `adopt` | Trevor already adopted the presentational primitive shape. Keep it as the owner, continue hardening scroll/disclosure behavior locally. Follow-up: covered by `58.15-assistant-ui-wrapper-update-policy`. |
| Tool fallback/group | tool UI docs and primitives | `ToolFallback`, `ToolGroup`, `tool-status` | `adopt` | Already adopted as UI layer. Keep host tool contract separate. Follow-up: covered by `58.15-assistant-ui-wrapper-update-policy`. |
| Toolkits / frontend / dynamic tools | tools docs, toolkit migration docs | host tools, browser commands, MCP | `reject` | Execution model conflicts with host-owned mediation and provenance. Use vocabulary only for docs. |
| Generative UI JSON spec | `/docs/tools/generative-ui.md` | Lucid artifacts, artifact panel, structured tool outputs | `defer` | Interesting only with allowlisted components, provenance, and no hidden writes. Follow-up later: `59.1-allowlisted-generative-artifact-renderer-spike`. |
| Interactables/intelligent components | interactables and copilot docs | Lucid review loop, questions, handoff approvals | `defer` | Potential fit for review surfaces, but hidden read/write paths are risky. Needs a security/provenance plan first. |
| MCP apps | `/docs/tools/mcp-apps.md` | host-owned MCP runtime and `mcp` tool | `adapt` | UI/config patterns are relevant; server execution remains host-owned. Follow-up: `58.12-mcp-app-ui-pattern-spike`. |
| User-managed MCP | MCP docs | host MCP registry | `adapt` | Borrow config UX. Reject browser-side server mediation. Follow-up: covered by `58.12-mcp-app-ui-pattern-spike`. |
| Multi-agent chat UI | multi-agent docs | delegation rows, inline agent rows, workflow output | `adapt` | Visual grouping and handoff affordances can improve delegation readability. Follow-up: `58.13-delegation-row-ui-pattern-audit`. |
| Model selector | model selector component/docs | assistant-ui model selector wrapper, model catalog projection | `adopt` | Already a bounded presentational adoption. Catalog/default/favorites remain Trevor-owned. Follow-up: covered by `58.15-assistant-ui-wrapper-update-policy`. |
| Message timing/token stats | message timing docs | turn-status header, usage breakdown, context pressure | `adapt` | Display ideas are useful. Usage math remains `assistant.progress`/metrics-owned. Follow-up: covered by `58.14-browser-diagnostics-inspector-spike`. |
| Context display/model context | context API/model context docs | context pressure panel, model selection projection | `adapt` | UI can improve discoverability. Do not expose hidden model context providers as state owners. Follow-up: covered by `58.14-browser-diagnostics-inspector-spike`. |
| Markdown/streamdown/syntax | markdown docs, react-markdown package | `MarkdownText`, `MarkdownBody`, Mermaid stories/tests | `keep Trevor-owned` | Trevor already wraps markdown and Mermaid behavior. Compare upstream periodically; do not swap renderer without streaming/regression tests. |
| LaTeX | LaTeX guide | current markdown pipeline and KaTeX dependency | `defer` | No strong product need in current coding-agent transcript. |
| Diff viewer | diff viewer docs/component | `DiffViewer`, `ToolDiff`, `MultiEditDiff` | `adopt` | Already adopted as single diff owner for tool edits. Keep consolidating duplicate diff renderers around it. Follow-up: covered by `58.15-assistant-ui-wrapper-update-policy`. |
| Sources UI | sources component docs | web fetch/search/docs/source recall rows | `adapt` | Card pattern may help attribution, but redaction/source provenance stays Trevor-owned. Follow-up: `58.17-source-attribution-card-pattern-audit`. |
| Voice/dictation/TTS/realtime voice | voice, dictation, speech docs | no current voice product | `defer` | Browser APIs are plausible later, but not current scope. Realtime voice is effectively rejected until Trevor has an audio transport. |
| DevTools | `/docs/devtools.md` | `/doctor`, panel diagnostics, telemetry spans | `adapt` | The idea of a runtime inspector is high leverage. Do not import DevTools wholesale unless using assistant-ui runtime. Follow-up: `58.14-browser-diagnostics-inspector-spike`. |
| `react-o11y` / heat graph | utility docs | local OTel artifacts and `/doctor` | `defer` | Potential diagnostics UI, but needs compatibility proof and clear data source. |
| `tw-shimmer` | utility docs | current shimmer usage in tool/reasoning wrappers | `adopt` | Keep for restrained lifecycle shimmer only. Avoid decorative broad use. Follow-up: covered by `58.15-assistant-ui-wrapper-update-policy`. |
| CLI/registry/update workflow | CLI docs, component registry, update/codemod docs | copied wrappers under `components/assistant-ui` | `adapt` | Adopt an update checklist and diff review flow. Do not blindly run registry updates over Trevor-owned modifications. Follow-up: `58.15-assistant-ui-wrapper-update-policy`. |
| Migration/stability docs | deprecation and migration docs | dependency update process | `adopt` | Use stability/deprecation notes in future assistant-ui plan gates. |
| Auth integrations | Clerk/Auth.js/better-auth docs | no hosted multi-user auth | `reject` | Conflicts with current single-user local app scope. |
| AI SDK/LangGraph/LangChain/Mastra/AG-UI/A2A/ADK/OpenCode/Eve runtimes | runtime/integration docs | provider host loop and pi-ai/LM Studio/Codex integrations | `reject` | Runtime replacement is out of scope. Mine protocol mapping ideas only if a future adapter plan needs them. |
| Copilot assistant frame/model context APIs | copilot docs | tool-proxy/browser tools, Lucid review loop | `defer` | Useful future browser-embedded assistant direction, but too broad for current Trevor. Needs security and permission model first. |
| RTL | RTL docs | current CSS/shadcn wrappers | `defer` | No product goal yet. Add only when actual RTL support is planned. |
| Ink/React Native | Ink and React Native docs | Trevor web/CLI surfaces | `reject` | Different platform products. No current need. |

## Highest-Leverage Follow-Up Shortlist

Immediate candidates, ranked by long-term simplicity, robustness, and product leverage:

1. `58.8-assistant-ui-external-store-thread-adapter`
   - Verdict source: `ExternalStoreRuntime` is the only runtime pattern that might wrap Trevor-owned state.
   - Dependency: plan 58.4 virtualization outcome.
   - Smallest slice: prove one read-only thread primitive can render from `createSessionReadModel`
     without owning durable state or composer submit.

2. `58.10-composer-trigger-popover-unification`
   - Verdict source: slash commands and mentions share trigger/popup mechanics.
   - Dependency: none, but must preserve Vim, shell lane, prompt history, file search, and slash
     command precedence.
   - Smallest slice: one shared trigger-range/popup controller for slash and file mention menus.

3. `58.11-artifact-attachment-adapter-shape`
   - Verdict source: assistant-ui attachment adapter shape maps well to Trevor blob artifacts.
   - Dependency: none.
   - Smallest slice: adapter interface around `ArtifactRef` for composer chips and submitted message
     attachments, no storage change.

4. `58.12-mcp-app-ui-pattern-spike`
   - Verdict source: MCP app UI docs overlap Trevor MCP runtime.
   - Dependency: host MCP registry stability.
   - Smallest slice: one sandboxed read-only MCP resource preview, no browser-side server execution.

5. `58.14-browser-diagnostics-inspector-spike`
   - Verdict source: assistant-ui DevTools inspect runtime state/events.
   - Dependency: no assistant-ui runtime dependency; reads Trevor projections.
   - Smallest slice: browser-only inspector tab for current session read model and latest host
     announcement.

6. `58.15-assistant-ui-wrapper-update-policy`
   - Verdict source: CLI/registry/migration docs plus local copied wrappers.
   - Dependency: none.
   - Smallest slice: documented update checklist and scriptable diff check for assistant-ui wrappers.

Additional deferred candidates recorded for completeness:

- `58.9-session-sidebar-thread-list-affordance-audit` - compare assistant-ui thread-list affordances
  against Trevor's sidebar/archive/resume/worktree UI, without cloud persistence.
- `58.13-delegation-row-ui-pattern-audit` - adapt multi-agent visual grouping for Trevor delegation
  rows and inline agent rows.
- `58.16-assistant-ui-architecture-vocabulary-note` - add a small vocabulary bridge for UI/runtime/
  protocol/persistence terms without changing ownership.
- `58.17-source-attribution-card-pattern-audit` - compare assistant-ui source card affordances against
  Trevor web-fetch/search/docs/source recall rows.
- `59.1-allowlisted-generative-artifact-renderer-spike` - evaluate assistant-ui-style generative UI
  only as an allowlisted artifact renderer with provenance and no hidden writes.

Protocol/runtime migration candidates are intentionally separated from UI primitive candidates. The
runtime replacement class (`LocalRuntime`, `AssistantTransport`, data-stream, AI SDK/LangGraph/etc.)
is rejected for Trevor core unless a future plan scopes a pure conversion adapter that leaves the
shared `/sessions` protocol and durable session log authoritative.

## Rejected Patterns

- Assistant Cloud and cloud auth integrations: hosted persistence/auth conflicts with Trevor's
  local-first private app.
- `LocalRuntime`, `AssistantTransport`, data-stream as runtime replacements: conflict with the
  shared `/sessions` protocol and durable `assistant.*` events.
- Toolkits/frontend/dynamic tool execution model: host-owned mediation/provenance must remain the
  execution boundary.
- Runtime integrations as replacements: AI SDK, LangGraph, LangChain, Mastra, AG-UI, A2A, ADK,
  OpenCode, and Eve should not replace Trevor's provider host loop.
- React Native and Ink products: outside current Trevor platform.

## Deferred Patterns

- Thread primitive beyond virtualization: wait for plan 58.4.
- Suggested prompts: needs explicit product source.
- Regenerate/action bar: needs Trevor-specific replay/regenerate semantics.
- Generative UI/interactables/copilot APIs: need security/provenance plans.
- Voice/dictation/TTS: no current audio product.
- RTL: no current support goal.
- `react-o11y`/heat graph: needs diagnostics-source proof.
- LaTeX: no current need beyond markdown baseline.

## Running UI Inspection Notes

Browser inspection checklist:

- Composer and file intake
- Slash/file menus
- Quote toolbar and tangent affordance
- Model selector
- Tool rows and grouped tool output
- Reasoning disclosure
- Markdown, Mermaid, diffs, and sources
- Attachments and image carousel
- Session sidebar/resume/worktree rows
- Context/doctor panel
- Artifact panel

Observed through the current browser e2e lane after a fresh web build:

- App boot renders a published transcript.
- File mention flow opens the menu, inserts a mention, submits, and renders the transcript.
- Transcript scroll, jump, pinned streaming/tool rows, virtualized long transcript, sidebar resize,
  resume-host row, and worktree focus flows all pass in a real browser.

No screenshot is attached because the browser pass did not change a verdict. The UI evidence corrected
one process point: `pnpm test:e2e:browser` serves `apps/web/dist`, so future browser checks must run
`pnpm --filter @trevor/web build` first.

## Completion Cross-Check

- Every relevant assistant-ui docs category from `llms.txt` is represented except thread
  virtualization, which is reserved for plan 58.4.
- Every matrix row has an assistant-ui source category and either Trevor owner evidence or an explicit
  `no current surface` classification.
- Every row has exactly one verdict.
- Every `adopt` or `adapt` row with implementation value is covered by a concrete follow-up candidate
  or by an already-adopted Trevor owner.
- Hosted persistence/auth and runtime replacement patterns are evaluated against Trevor's
  local-first source-of-truth boundary.
