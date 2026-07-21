# Native OpenAI Compaction - Implementation Plan (stub)

> **Status: intentionally light.** This plan records a promising OpenAI-specific
> context-management direction without committing Trevor to an API shape or migration.
> Resolve section 4 before creating implementation milestones. <!-- D-001 -->

## 0. Hard Dependencies

- [x] Trevor's provider-neutral cross-turn compaction is shipped: it writes a durable,
  portable `context.compacted` event, keeps the full session log intact, and replays a
  rolling summary plus recent turns.
- [ ] OPEN: confirm that Trevor's current ChatGPT Codex OAuth endpoint supports native
  Responses compaction and that pi-ai can expose both the request controls and returned
  opaque compaction items without relying on undocumented Trevor-side payload injection.

## 1. Objective

Evaluate and, if the evidence supports it, add OpenAI-native Responses compaction for
compatible OpenAI models so long sessions can preserve provider reasoning and state in
OpenAI's encrypted compaction item instead of relying exclusively on Trevor's plain-text
rolling summary. The detailed integration shape is deliberately undecided. <!-- D-001 -->

## 2. Current Baseline

Trevor currently compacts every provider through the same host-owned mechanism:

- `compaction-planner.ts` triggers near 80% of the effective context window and plans a
  fold toward 50%.
- `compactor.ts` asks the active provider for a roughly 1,000-token rolling summary.
- `history-projection.ts` replaces the folded prompt prefix with that portable summary
  while retaining the complete durable event log for transcript display and recall.
- the Codex source uses pi-ai's `openai-codex-responses` transport over ChatGPT OAuth,
  not a direct API-key client against the public OpenAI Responses endpoint.

<!-- D-002 --> This mechanism remains Trevor's canonical baseline and cross-provider
fallback unless the native path proves compatible with durable replay, provider switches,
forks, recall, and the current Codex OAuth transport.

## 3. Possible Direction (not yet committed architecture)

- Introduce an explicit provider capability for native compaction rather than checking a
  model or provider string inside the agent loop.
- For a compatible OpenAI provider, capture and durably persist the opaque compaction
  checkpoint returned by Responses, then replay it only through that compatible provider.
- Keep the full Trevor event log unchanged. When native state is unavailable or the user
  switches providers, fall back to Trevor's portable rolling-summary fold.
- Compare server-side `context_management` against the standalone `/responses/compact`
  endpoint before selecting either route.

These bullets are hypotheses for the design pass, not accepted implementation decisions.

## 4. Open Questions (flesh out before milestones)

- Does `https://chatgpt.com/backend-api/codex/responses` support the documented public
  Responses compaction contract for Codex OAuth, or is native compaction available only
  through `api.openai.com/v1/responses`?
- Does pi-ai expose `context_management`, compaction output items, and exact stateless
  replay? If not, should support land upstream in pi-ai before Trevor changes?
- Should Trevor first add a direct OpenAI API-key provider and limit native compaction to
  that provider?
- What durable protocol/event shape stores a provider-specific opaque checkpoint without
  making it part of the portable `ChatMessage[]` contract?
- How do native checkpoints behave across host restart, session fork, model change,
  provider change, `/clear`, manual `/compact`, export, and source recall?
- Does Trevor use stateless input-array chaining or `previous_response_id` continuation?
  How does that choice interact with `store: false`, WebSocket reuse, and replay after a
  process restart?
- When should native compaction trigger, and how does its token accounting coexist with
  Trevor's context meter, preflight guard, overflow recovery, and current 80%/50% policy?
- What eval demonstrates that native compaction improves retained state, reasoning
  continuity, cost, or latency enough to justify provider-specific complexity?
- What user-visible and diagnostic evidence distinguishes a native checkpoint from a
  Trevor rolling-summary fold without exposing opaque encrypted contents?

## 5. Non-Goals

- No undocumented payload injection into the current Codex backend.
- No removal of Trevor's provider-neutral compaction or full durable event history.
- No assumption that an opaque OpenAI checkpoint is portable to LM Studio, Anthropic, or
  another OpenAI model/API surface.
- No implementation until the compatibility, persistence, switching, and evaluation
  questions above are resolved.

## 6. Current Cutoff

### Flesh out this plan

**Testing:** test-after (research/design spike - there is no behavior-bearing
implementation in the current cutoff).

1. Verify the supported OpenAI and pi-ai contracts with official documentation and a
   minimal, non-production experiment.
2. Decide the provider capability, durable checkpoint, replay, and fallback boundaries.
3. Define representative long-session evals and failure/restart cases.
4. Replace this stub with concrete RED/GREEN/REFACTOR milestones if the result is a go.

## 7. Validation Commands

```sh
npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "66-native-openai-compaction"
npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-convergence --plan "66-native-openai-compaction" --streak 3
```

## 8. Decisions

Canonical decisions are in `plan.db`.

- D-001: deliberately-light exploration stub; no implementation commitment yet.
- D-002: Trevor's portable rolling-summary compaction remains the canonical baseline and
  cross-provider fallback.
- D-003: fresh top-level plan 66; no plan is currently in flight and the backlog ends at 65.
