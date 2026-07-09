# Assistant-UI Pattern Audit - Research Plan

## 0. Hard Dependencies

- [x] `@assistant-ui/react` and `@assistant-ui/react-markdown` are already installed in
  `apps/web`.
- [x] Trevor already has assistant-ui-inspired or assistant-ui-backed components under
  `apps/web/src/components/assistant-ui`.
- [x] Plan 58.4 owns assistant-ui thread virtualization adoption. This research plan must not
  revisit or duplicate that work. <!-- D-001 -->
- [x] Trevor's durable session log, Tether transport, host turn loop, model selection, artifact
  storage, tools, tangents, and transcript projection remain the current source of truth during
  research. This plan may recommend later migration or adapter work, but it does not implement it.
  <!-- D-002 -->
- [x] Downstream accommodation: none. This plan produces research findings and follow-up plan
  candidates only; it does not change a runtime contract by itself.

## 1. Research Objective

Audit the complete assistant-ui documentation corpus in depth, not only the pages that already look
familiar from Trevor. The research must perform a thorough comparison between assistant-ui's
documented primitives, runtimes, adapters, tools, performance guidance, cloud/integration surfaces,
and Trevor's current equivalents or intentional gaps. The final output is the repo-root document
`ASSISTANT_UI_OPPORTUNITIES.md`, written so later model passes can challenge it with contrarian
opinions.

For each pattern, recommend one of:

| Verdict | Meaning |
|---------|---------|
| `adopt` | Use assistant-ui's primitive, component, hook, or adapter directly. |
| `adapt` | Borrow the pattern or wrap the primitive, but keep Trevor's source of truth. |
| `keep Trevor-owned` | Trevor already has stronger domain-specific behavior, so do not replace it. |
| `defer` | Worth revisiting after another numbered plan lands or after missing product constraints are known. |
| `reject` | Does not fit Trevor's architecture, privacy model, local-first model, or product surface. |

Each recommendation must cite both sides of the comparison:

- assistant-ui documentation page or API reference
- Trevor code, test, plan, or `CONTEXT.md` evidence
- performance implications where the assistant-ui docs or Trevor implementation suggest a meaningful
  rendering, streaming, state-management, bundle, reconnection, persistence, or scheduling difference
- risk if Trevor adopts it
- risk if Trevor ignores it
- concrete follow-up plan candidate when the verdict is `adopt` or `adapt`
- confidence level, uncertainty, and at least one contrarian question when the decision is important
  enough that a future model pass should re-check it

Do not treat assistant-ui as one library decision. The audit must be case-by-case because the docs
span UI primitives, runtimes, protocol adapters, cloud persistence, tool rendering, MCP, model
context, copilot APIs, observability visualizers, and migration tooling. <!-- D-003 -->

## 2. Initial Evidence Baseline

### assistant-ui Documentation Corpus

The audit starts from the official assistant-ui docs index and markdown corpus:

- `https://www.assistant-ui.com/docs`
- `https://www.assistant-ui.com/llms.txt`
- `https://www.assistant-ui.com/llms-full.txt`

`llms.txt` is the coverage ledger. Every linked page in that index must be classified as one of:

- compared in detail against Trevor
- grouped into a compared family with a named representative page
- explicitly out of scope for Trevor with a reason

The docs advertise these major areas that overlap Trevor:

- architecture: UI layer, runtime layer, backend/agent layer, protocol/integration layer, and persistence layer
- custom runtimes: `LocalRuntime`, `ExternalStoreRuntime`, `AssistantTransport`, and data-stream protocol
- guides: attachments, branching, chain of thought UI, context API, dictation, editing, headless
  composer input, image generation, input history, mentions, message timing, quote selected text,
  resumable streams, slash commands, suggestions, voice, and virtualization
- primitives: thread, thread list, composer, message, action bar, branch picker, attachment,
  selection toolbar, suggestion, error, and chain of thought
- tools: backend tools, frontend tools, dynamic tools, tool UI, toolkits, generative UI,
  interactables, MCP apps, MCP servers, user-managed MCP, and multi-agent chat UI
- UI components: markdown, streamdown, syntax highlighting, Mermaid, diff viewer, sources,
  reasoning, tool fallback, tool group, model selector, context display, message timing,
  follow-up suggestions, quote, file/image attachments, thread list, voice, and MCP config
- cloud and integrations: Assistant Cloud persistence, AI SDK, LangGraph, LangChain, Mastra,
  AG-UI, A2A, Google ADK, OpenCode, Eve, auth integrations, and observability integrations
- utilities: `tw-shimmer`, `react-o11y`, heat graph
- copilot APIs: assistant frame, model context providers, intelligent components, assistant
  instructions
- migrations and stability guidance

### Trevor Surfaces Already Known To Overlap

The first code pass found current Trevor equivalents or partial equivalents:

- assistant-ui packages in `apps/web/package.json`
- assistant-ui wrapper components in `apps/web/src/components/assistant-ui`
- live transcript projection in `apps/web/src/transcript.ts`
- session read model in `apps/web/src/session/projection.ts`
- Tether transport binding in `apps/web/src/session/use-session.ts`
- prompt composer, slash command autocomplete, prompt history, file mentions, queued prompts, and
  Vim mode under `apps/web/src/components/chat` and `apps/web/src/app.tsx`
- model selection projection in `apps/web/src/model-selection.ts`
- tool rendering, status, diffs, web fetch/search, docs, source recall, LSP, MCP, and terminal rows
  under `apps/web/src/components/chat` and `apps/agent-host/src/tools`
- artifacts and blob-backed attachments under `apps/web/src/blob.ts`,
  `apps/web/src/artifact-thumb.tsx`, `apps/agent-host/src/artifacts`, and the blob-store e2e tests
- tangent branching in `packages/session/src/tangent.ts`, `apps/web/src/session/use-session.ts`,
  `apps/agent-host/src/session/tangent-adoption.ts`, and plan 58.3
- local model/provider admission, token and usage surfaces, context pressure, and `/doctor`
  diagnostics in `packages/session/src/breakdown.ts`, `apps/web/src/components/panel`, and
  `apps/agent-host/src/doctor`
- MCP runtime and model-facing `mcp` tool in `apps/agent-host/src/mcp` and
  `apps/agent-host/src/tools/mcp.ts`

## 3. Audit Matrix To Produce

The final research artifact must include a table with at least these rows. Rows may split further
when the docs reveal separate decisions.

| assistant-ui pattern | Trevor equivalent to inspect | Expected starting hypothesis |
|----------------------|------------------------------|------------------------------|
| Architecture layers | session log, Tether, host loop, web projection | adapt vocabulary only; keep Trevor source of truth |
| `ExternalStoreRuntime` | `toTranscript`, `createSessionReadModel`, `streamTransport` | high-value adapter candidate for UI primitives, not durable state |
| `LocalRuntime` / `AssistantTransport` / data-stream | Tether protocol and host stream events | likely reject as runtime replacement; maybe adapt event conversion ideas |
| Thread primitive | current transcript surface and plan 58.4 | defer to 58.4 for virtualization; evaluate non-virtual thread affordances only |
| Thread list component and cloud thread persistence | sidebar session inventory and local session-store | adapt UI affordances; reject Assistant Cloud for Trevor-owned local persistence |
| Composer primitive and headless composer input | Trevor composer, Vim mode, queued prompts, command parsing | evaluate partial adoption only if Trevor behavior can remain source-owned |
| Composer trigger popovers, mentions, slash commands | slash menu, file mention menu, command palette | adapt shared trigger/popup primitives if they reduce duplicate autocomplete code |
| Input history | tab-scoped prompt recall in `sessionStorage` | keep Trevor-owned unless primitive can wrap current semantics |
| Suggested prompts and follow-up suggestions | starter UI, generated follow-up candidates if any | defer until product need is explicit |
| Attachments and attachment adapters | blob store, artifact refs, image carousel, message attachments | adapt adapter shape around Trevor blobs; do not move storage ownership |
| File/image UI components | `artifact-thumb`, `message-attachments`, assistant-ui attachment wrapper | adopt or adapt presentational pieces where behavior matches |
| Image generation rendering | Lucid/artifact panel, image carousel | adapt rendering only; generation stays tool/provider-owned |
| Quote selected text / selection toolbar | existing quote toolbar and tangent creation | keep Trevor-owned for tangent semantics; mine primitives/tests for cleanup |
| Message branching and editing | tangent sessions, prompt supersession, replay/switch boundary | likely keep Trevor-owned; branch picker may inspire UI only |
| Regenerate/reload action bar | turn replay, cancel, supersede, model switch | defer until Trevor has explicit regenerate semantics |
| Chain of thought / reasoning UI | reasoning rows and `Reasoning` component | adopt/adapt presentational primitive if current wrapper is incomplete |
| Tool UI and tool fallback | status-aware tool renderer, tool group, tool fallback | adapt UI composition; keep host tool contract and renderer registry |
| Toolkits, frontend tools, dynamic tools | host tools, MCP, hooks, browser commands | likely reject toolkit execution model; maybe adapt registration vocabulary |
| Generative UI JSON spec | Lucid artifacts, artifact panel, tool-rendered structured outputs | research carefully; possible adapt for bounded, allowlisted UI specs |
| Interactables / intelligent components | Lucid review loop, question surface, handoff approvals | possible adapt only with strict provenance and no hidden write path |
| MCP apps and user-managed MCP | host-owned MCP runtime and `mcp` tool | evaluate UI/config patterns; keep host-owned mediation |
| Multi-agent chat UI | delegation rows, inline agent rows, workflows | adapt visual structure if it fits Trevor delegation semantics |
| Model selector | current assistant-ui model selector wrapper and model-selection projection | adopt/adapt presentational code, keep Trevor model catalog semantics |
| Message timing and token stats | turn-status header, usage breakdown, context pressure | adapt display ideas; keep Trevor usage math |
| Context display | context pressure and panel breakdown | adapt UI if clearer than current panel; keep estimates source-owned |
| Markdown / streamdown / syntax highlighting / Mermaid / LaTeX | markdown body, markdown-text, diff viewer, mermaid dependency | compare component quality, streaming correctness, and bundle impact |
| Diff viewer | existing multi-edit and assistant-ui diff viewer | adopt one owner; identify duplicate diff renderers |
| Sources UI | web fetch/search/docs/source recall rows | adapt source card if it preserves attribution and redaction |
| Voice, dictation, speech | no core Trevor voice product yet | defer or reject unless user-facing need emerges |
| Realtime voice chat | no live audio transport | reject for now |
| DevTools | Trevor `/doctor`, debug mode, projections | adapt ideas for inspecting runtime state in browser |
| `react-o11y` | local OTel artifacts and `/doctor` | evaluate as optional trace tree UI for diagnostics |
| `tw-shimmer` | current shimmer usage | adopt if already installed and useful; avoid decorative overuse |
| RTL support | current CSS and shadcn wrappers | defer unless supporting RTL becomes a product goal |
| Assistant Cloud | local-first session-store, blob-store, private repo | reject managed persistence for Trevor core |
| AI SDK, LangGraph, Mastra, AG-UI, A2A, ADK, OpenCode runtimes | Trevor provider and host loop | reject as runtime replacement; mine protocol adapter patterns only |
| Auth integrations | local app/no hosted multi-user auth | reject for current Trevor |
| Copilot assistant frame/model context APIs | tool-proxy/browser tools, Lucid artifact review | research as future browser-embedded assistant surface; do not adopt blindly |
| CLI and component registry | current copied components and package pins | adapt update workflow if it reduces stale component drift |
| Migration/stability docs | dependency update process | adopt stability checklist for any assistant-ui API use |

## 4. Research Method

### M1: Documentation Corpus Map

Goal: produce a complete, deduplicated index of assistant-ui patterns and prove coverage of the
entire docs corpus.

1. RED: Create an audit worksheet under this plan's `artifacts/` directory with the categories from
   `llms.txt` and `llms-full.txt`, explicitly excluding virtualization adoption by reference to plan
   58.4 while still noting any non-virtualization performance lessons from the virtualization docs.
2. GREEN: Read the official markdown pages deeply enough to classify every `llms.txt` entry. Each
   entry must either receive its own comparison row, be grouped into a named comparison family, or be
   marked out of scope with a reason.
3. GREEN: Summarize each compared pattern with source URL, API/package names, maturity/stability
   notes, performance claims or implications, and whether it is UI-only, runtime, persistence,
   protocol, tool, performance, or cloud.
4. REFACTOR: Merge duplicate docs rows where a guide, primitive, UI component, and API reference all
   describe the same adoption decision.

### M2: Trevor Equivalent Survey

Goal: map every assistant-ui pattern to the exact Trevor owner or prove Trevor has no equivalent.

1. RED: Add a second worksheet section that requires each row to cite a Trevor file, test, plan, or
   `CONTEXT.md` entry before it can receive an adoption verdict.
2. GREEN: Survey `apps/web`, `apps/agent-host`, `packages/session`, `e2e`, and live numbered plans
   for each pattern's current owner.
3. GREEN: Mark rows with no Trevor equivalent as `no current surface` rather than stretching a weak
   analogy.
4. REFACTOR: Group rows by Trevor ownership boundary: transcript, composer, tools, artifacts, model
   selection, session/thread list, diagnostics, MCP, delegation/tangents, and future-only surfaces.

### M3: Case-By-Case Adoption Recommendations

Goal: decide what to adopt, adapt, keep, defer, or reject.

1. RED: Add an explicit verdict rubric to the worksheet: source-of-truth fit, local-first fit,
   accessibility, testability, bundle/runtime cost, streaming and scroll performance, reconnection or
   resumability behavior, API stability, and migration blast radius.
2. GREEN: Fill the adoption matrix for every row in section 3 with the five-way verdict and rationale.
3. GREEN: For every high-value assistant-ui capability, especially performance-related capabilities,
   state why Trevor should adopt, adapt, keep, defer, or reject it. Do not leave performance wins as
   generic claims; tie them to a concrete Trevor surface and expected effect.
4. GREEN: For every `adopt` or `adapt` verdict, add a follow-up candidate with a proposed numbered
   plan title, dependency, and smallest shippable slice.
5. GREEN: For every `reject` verdict, state the architectural reason so it is not reopened as vague
   library skepticism.
6. REFACTOR: Collapse weak recommendations. If a pattern only saves a few lines while weakening a
   Trevor invariant, mark it `keep Trevor-owned`.

### M4: Highest-Leverage Follow-Up Plan Set

Goal: turn the research into a short prioritized backlog, not a long wishlist.

1. RED: Add a ranked shortlist section that limits immediate follow-ups to the few recommendations
   with clear payoff and low architectural risk.
2. GREEN: Rank candidates by long-term simplicity, robustness, and product leverage, not development
   cost.
3. GREEN: Identify conflicts with live plans, especially 58.2, 58.3, 58.4, 58.5, 50, and any plan
   that owns session/thread behavior.
4. REFACTOR: Split "adopt UI primitive" candidates from "protocol/runtime migration" candidates so
   implementation plans do not mix unrelated risk classes.

### M5: Validate Research Against Running Trevor UI

Goal: verify recommendations against the product as it exists, not only source names.

1. RED: Define a browser inspection checklist for the current Trevor UI surfaces that overlap
   assistant-ui: composer, slash/file menus, quote toolbar, model selector, tool rows, reasoning,
   markdown/diffs, attachments, session sidebar, context panel, and artifact panel.
2. GREEN: Run the local app or Storybook and inspect the overlapping surfaces. Use Codex computer-use
   if browser automation is helpful.
3. GREEN: Update any recommendation that looks wrong once the actual UI behavior is observed.
4. REFACTOR: Attach screenshots or concise notes only when they change a verdict; avoid turning the
   plan artifact into a visual archive.

### M6: Final Report And Plan Closure

Goal: leave a reusable research deliverable that future implementation plans can consume.

1. RED: Add the final report at repo root as `ASSISTANT_UI_OPPORTUNITIES.md` with the full matrix,
   ranked recommendations, rejected patterns, deferred patterns, performance opportunities, source
   links, uncertainty notes, and contrarian-review prompts for later model passes.
2. GREEN: Cross-check the report against the assistant-ui docs index so every docs page is accounted
   for as compared, grouped, or explicitly out of scope. Virtualization adoption remains delegated to
   plan 58.4, but any broader performance lessons from that docs area must still be recorded.
3. GREEN: Cross-check report recommendations against Trevor code/plans so every verdict has local
   evidence.
4. GREEN: Record follow-up plan candidates in the progress report's accepted/deferred section.
5. REFACTOR: Update `CONTEXT.md` only if the research introduces stable Trevor vocabulary that later
   plans should share.

## 5. Non-Goals

- No implementation of assistant-ui adoption.
- No migration of Trevor's durable transcript, session list, tools, artifacts, or model selection into
  assistant-ui runtime state during this plan.
- No Assistant Cloud adoption.
- No thread virtualization adoption recommendation beyond pointing to plan 58.4; non-virtualization
  performance lessons from assistant-ui docs still belong in `ASSISTANT_UI_OPPORTUNITIES.md`.
- No broad redesign of Trevor's chat UI.
- No dependency upgrades unless the research proves the currently installed assistant-ui version blocks
  accurate evaluation.

## 6. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| The audit becomes a feature wishlist instead of decisions | high | medium | M3 forces a five-way verdict and local evidence for every row | research |
| Runtime/cloud docs bias the plan toward replacing Trevor's source of truth | high | medium | D-002 keeps Trevor-owned protocol and storage as the baseline | research |
| Existing assistant-ui wrappers are assumed correct because they already exist | medium | medium | M2 and M5 inspect code and running UI before recommendations | research |
| assistant-ui unstable APIs churn after adoption | medium | medium | M3 includes stability as a rubric and M6 records API maturity | research |
| The matrix misses a relevant docs area | high | medium | M1 treats `llms.txt` as a coverage ledger and M6 requires every docs page to be compared, grouped, or explicitly out of scope | research |
| Performance opportunities stay too abstract to act on | high | medium | M3 requires each performance claim to name the Trevor surface, expected effect, evidence, and follow-up plan slice | research |
| Later contrarian reviews lack enough context to challenge the report | medium | medium | M6 requires uncertainty notes and contrarian-review prompts in `ASSISTANT_UI_OPPORTUNITIES.md` | research |

## 7. Validation Commands

```sh
npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "58.6-assistant-ui-pattern-audit"
npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-convergence --plan "58.6-assistant-ui-pattern-audit" --streak 3
pnpm lint
pnpm typecheck
pnpm test:web
```

For the research-only plan, `pnpm lint`, `pnpm typecheck`, and `pnpm test:web` are final confidence
checks only if implementation or docs-link edits touch source or shared docs. The required completion
gate is the repo-root `ASSISTANT_UI_OPPORTUNITIES.md` report plus planner convergence.

## 8. Decisions

Canonical decisions are in `plan.db`.

- D-001: plan 58.4 owns assistant-ui thread virtualization, so this plan excludes it.
- D-002: this is a research-only audit plan.
- D-003: adoption decisions are case-by-case, not all-or-nothing.
