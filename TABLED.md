# Trevor V2 — Tabled Features

> Features deliberately **set aside** — not on the active burndown ([FEATURES.md](./FEATURES.md)),
> but **not dropped** ([§3 DROP list](./FEATURES.md#3-the-drop-list--multi-user--collaboration)
> is permanent removal; this is "revisit deliberately later"). Each entry records what it is,
> where it lived, why it's tabled, and the trigger to reconsider.

---

## T-1. Routing classification (model-led)

**What it is.** Semantic, LLM-driven classification of free-text prompts into a structured
routing intent (`requestedRole`, `workKind`, `executionMode`, model/harness requirements).
The configured **router-role** model does the classification; the auto-bounded-child
escalation path sat on top of its output.

**Status in the old host.** **Disabled** via `routing.enabled:false` (turned off
2026-06-15 for solo-maintenance overhead). Dormant, **not deleted**: ~9K LOC + 76 tests.

**Where it lived (old host).**
- `server/rpc/prompt-classification.ts` — the gate / invocation
- `routing/router-eval.ts` — classifier eval harness (semantic score, false-positive guards) *(old H-097)*
- `packages/routing-contract/src/index.ts` — `buildRouteIntentClassificationPrompt`,
  `parseRouteIntentClassificationResponse` (dependency-free contract; makes it re-attachable)
- the auto-bounded-child escalation tied to classifier output

**What is NOT tabled (stays KEEP on the burndown).** Routing itself is **not** going away —
only the *model-led* classification step is. These remain active in V2:
- **Heuristic + fixed classification** (the always-on fallback paths) — old H-084 minus the model path
- Candidate selection & ranking, quality tiers, posture, work-kinds — H-080..H-083
- Validation modes / escalation / route outcomes / config / connectivity — H-087..H-096

So V2 ships with `routing.enabled:false` semantics by default: deterministic
heuristic/fixed routing, no LLM classifier.

**Protocol surface if revived.** `route.classifying` (model-led variant);
`classificationSource: "model"`. No new wire types needed — the contract already supports it.

**Why tabled, not dropped.** Real maintenance cost for one maintainer, and non-essential to
a working host — but the dependency-free `routing-contract` package keeps it cheap to
re-attach, and it may be worth it once there's a second maintainer or a measured routing-quality
need.

**Revisit trigger.** After slice **S6 (routing)** lands with heuristic/fixed classification
working *and* there's appetite + capacity for model-led routing quality. Re-attach via the
`routing-contract` prompt/parse pair behind the `routing.enabled` flag; restore the eval
harness as the gate before trusting it.

---

_Last updated: 2026-06-18._
