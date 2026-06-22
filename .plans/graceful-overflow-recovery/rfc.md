# RFC: Graceful, Automatic Context-Overflow Recovery (Trevor agent host)

Status: draft (forward plan — not for immediate implementation)
Scope: `apps/agent-host` (+ minor `apps/web` for user-facing messaging)

## Problem

A context overflow currently **stops the turn**. As of the detect-and-surface
work already shipped:

- `streamPiAi` (`src/providers/pi-ai.ts`) emits `ProviderEvent {type:"overflow", reason}`
  when the model is bounded by the context window — a `"length"` stop whose
  `input+output` fills ≥98% of the window, or pi-ai's `isContextOverflow`.
- `runAgent` (`src/agent/loop.ts`) forwards it as an `AgentEvent`.
- `main.ts` publishes an `assistant.overflow` Richter event (`{runId, reason}`).
- The web shows a "⚠ context overflow" notice.

The model's answer is truncated and the loop halts. The goal: an overflow should
be a cue to **make a live adjustment and continue**, not a dead end — preserve
momentum and still reach a useful answer.

## Goal

When an overflow is detected mid-turn, automatically: (1) decide on an
adjustment, (2) apply it to the in-loop conversation (or runtime), (3) retry the
step, (4) communicate what happened — all bounded so it can't loop forever.

## Current shape (facts to build on)

- The loop is bounded by `MAX_STEPS` in `agent/loop.ts`; each step calls
  `provider.stream(conversation, TOOL_DEFS, reasoning)`.
- The per-turn `conversation` (in `runAgent`) accumulates assistant turns,
  full tool-call args, and **full** tool results (the 4000-char slice is only
  on the published `tool.completed` event, not in the model-facing history).
  Large tool results are the most likely overflow driver.
- Persistent cross-turn `history` is rebuilt from the Richter event log in
  `main.ts` (user + assistant text only; tool results are not persisted).
- Providers expose `contextWindow` via the usage event and a per-model
  reasoning level. Local qwen (LM Studio): `loaded_context_length` is the real
  wall, now 262144. Cloud gpt (codex): fixed model window.

## Design space (decide during planning — not yet chosen)

- **(a) Compact/summarize older turns**, then retry the step. Where does the
  summarizer run — host orchestration vs a provider call? Cheap heuristic vs a
  model summarization pass?
- **(b) Drop/truncate the largest in-loop tool results** (cheapest; targets the
  most common cause). Keep head/tail, elide the middle with a marker.
- **(c) Reduce reasoning effort / thinking budget** for the retry — thinking
  tokens are a large, discardable consumer for local qwen.
- **(d) Raise the loaded LM Studio context** via `lms load -c <tokens>` when the
  machine has headroom (local only; heavy; one-time, not per-turn).

These are not mutually exclusive — likely an escalation ladder (cheapest first:
b → c → a → d), bounded.

## Control flow to specify

detect → decide → adjust → retry, with:

- **Bounded retries**: a per-turn overflow-recovery budget (e.g. ≤2 adjustments)
  separate from `MAX_STEPS`, so recovery can't spin.
- **Escalation order**: which adjustment is tried first and when to escalate.
- **Where compaction lives**: host (orchestrator owns conversation) vs provider.
  Leaning host — it owns the loop and the conversation array.
- **Local vs cloud divergence**: (d) is local-only; (c) only helps when thinking
  is on; cloud relies on (a)/(b). The decision function must branch on provider.
- **User communication**: replace the dead-end notice with a live status —
  e.g. `assistant.compacted {runId, action, detail}` → "compacted N older turns
  and continued" / "trimmed M tool results and continued". Distinguish recovered
  vs gave-up.
- **Failure mode**: if recovery exhausts its budget, surface a clear terminal
  overflow (today's behavior) rather than silently truncating.

## Observability (required for this change)

This changes loop/provider runtime behavior, so per the observability doctrine:
recovery decisions must be inspectable — structured log/event per adjustment
(trigger, chosen action, tokens reclaimed, retry outcome), correlated by runId,
and surfaced to the user. Add the recovery counters to the usage/inspection
surface.

## Non-goals

- No persistent-history compaction across turns (this RFC is per-turn, in-loop).
- No automatic model swapping.
- No change to the already-shipped detection/surfacing path beyond replacing the
  terminal notice with the recovery status when recovery succeeds.

## Open questions

1. Summarization fidelity vs cost for (a) — heuristic vs model pass.
2. Token-accounting source of truth for "how much to reclaim" — the usage event
   is post-hoc; do we need a pre-flight token estimate to size the trim?
3. Should (d) (raise loaded context) be in-scope for an agent host to trigger, or
   left as an operator action?
