# Dynamic Workflows Runtime — Best-Guess Architecture

> A reverse-engineered outline of how the Claude Code **Dynamic Workflows** runtime
> is likely built, inferred from its observable contract (the `agent`/`parallel`/
> `pipeline`/`phase`/`log` primitives, schema-validated output, background execution,
> resume-by-runId, and the persisted `*.js` workflow scripts). This is an educated
> reconstruction, **not** official documentation — anything not directly observable
> is marked _(speculative)_.

---

## 1. The big picture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Main Claude Code session (the "main loop" you talk to)                │
│                                                                        │
│   user prompt ──► Claude authors a JS orchestration script             │
│                      │                                                  │
│                      ▼                                                  │
│              Workflow tool call  (script | scriptPath | name)          │
│                      │  returns immediately with { runId, scriptPath } │
│                      ▼                                                  │
└──────────────────────┼─────────────────────────────────────────────────┘
                       │  spawn detached / background
                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Workflow Runtime (separate execution context, runs in background)     │
│                                                                        │
│   1. Persist script  → session-dir/workflows/scripts/<name>-<runId>.js │
│   2. Parse + validate `export const meta`                              │
│   3. Build a sandboxed JS realm, inject globals:                       │
│        agent() parallel() pipeline() phase() log() workflow()          │
│        args  budget                                                     │
│   4. Execute the script body (async) under a Scheduler                 │
│   5. Stream progress events → /workflows UI + journal                  │
│   6. On completion → <task-notification> back to main loop             │
└──────────────────────┬─────────────────────────────────────────────────┘
                       │  each agent() = one subagent invocation
                       ▼
        ┌────────────────────────────────────────────┐
        │  Subagent pool (≤ 16 concurrent)            │
        │  each: fresh context, own tool loop,        │
        │  optional StructuredOutput tool, own model  │
        └────────────────────────────────────────────┘
```

The key architectural insight: **Claude writes the control flow as code, a
deterministic runtime executes that code, and the model only re-enters at the
leaves (`agent()` calls).** Orchestration logic (loops, conditionals, fan-out) is
deterministic JS; intelligence is confined to subagents. This is what makes runs
reproducible enough to resume.

---

## 2. Components

### 2.1 Script authoring & ingestion
- The **main loop** generates the script from natural language and passes it inline
  via the `script` param (or `scriptPath` / `name` for saved workflows).
- The runtime **persists every invocation** to
  `<session>/workflows/scripts/<meta.name>-<runId>.js` and returns that path —
  this is the artifact we found earlier. Persisting up-front is what enables
  edit-and-resume.
- `export const meta` is required and must be a **pure literal** _(so it can be
  statically parsed without executing the script)_ — used to populate the
  permission dialog and the `/workflows` progress tree before any code runs.

### 2.2 The sandboxed realm
- Script runs in an **isolated JS context** _(speculative: a V8 isolate / `vm`
  context, or a worker)_ — not a normal Node module. Evidence:
  - No `import`/`require`; primitives are **injected globals**.
  - `Date.now()`, `Math.random()`, argless `new Date()` are **disabled** —
    they would make resume non-deterministic. This strongly implies a curated
    global object rather than full Node.
  - No filesystem / Node API access from the script.
- Standard pure built-ins (`JSON`, `Math`, `Array`, …) are passed through.

### 2.3 Injected primitives (the "stdlib")
| Primitive | Role | Likely implementation |
|---|---|---|
| `agent(prompt, opts)` | spawn one subagent | enqueue a task on the Scheduler; `await` resolves to text, or schema-validated object |
| `parallel(thunks)` | barrier fan-out | `Promise.all` over scheduler-gated thunks; failures → `null` (never rejects) |
| `pipeline(items, ...stages)` | per-item staged flow, **no barrier** | each item gets an independent async chain; wall-clock = slowest single chain |
| `phase(title)` | progress grouping | mutates runtime "current phase" used to bucket subsequent agents in the UI |
| `log(msg)` | narrator line | emits a progress event |
| `workflow(ref, args)` | nested sub-workflow | re-enters runtime one level deep; shares cap/counter/budget |
| `args` | input value | verbatim pass-through of the tool's `args` |
| `budget` | token accounting | `{ total, spent(), remaining() }` over a shared pool |

### 2.4 The Scheduler / concurrency manager
- Enforces **≤ min(16, cores−2) concurrent** subagents; excess `agent()` calls
  **queue** and drain as slots free.
- Enforces a lifetime cap of **1000 total** agents per run (runaway backstop).
- `parallel()` and `pipeline()` both submit to the same gate — the cap is global
  to the run, not per-call. This is why you can hand `pipeline()` 100 items safely.
- _(speculative)_ Likely a simple semaphore + FIFO queue; `pipeline`'s
  no-barrier property means it submits each item's next stage the moment its prior
  stage resolves, rather than waiting on the slowest peer.

### 2.5 Subagent executor
- Each `agent()` = a **fresh-context** subagent with its own tool loop (the same
  machinery as the `Agent` tool: can call Read/Grep/Bash, search deferred tools,
  reach MCP servers).
- **Structured output:** when `schema` is supplied, the subagent is forced to call
  a synthetic `StructuredOutput` tool whose input schema = the provided JSON Schema.
  Validation happens **at the tool-call layer**, so the model auto-retries on
  mismatch and `agent()` returns a guaranteed-valid object. No parsing in the script.
- `opts.model` overrides the tier; default inherits the session model.
- `opts.isolation: 'worktree'` provisions a throwaway git worktree per agent so
  parallel file mutations don't collide; auto-removed if untouched.
- The subagent is told its **final message IS the return value** (not human-facing),
  which is why agents return raw data.

### 2.6 Progress & telemetry plane
- Runtime streams events (`phase` started, `agent` started/finished, `log` line)
  to the `/workflows` live view and to telemetry.
- `meta.phases[].title` are matched **by exact string** against `phase()` calls
  and `opts.phase` to build the tree; an unmatched phase string just gets its own
  group box (this is why "Stress-test" can be group-only via `opts.phase`).

### 2.7 Journaling & resume engine  ← the load-bearing part
- Every `agent()` result is appended to a **journal** (we saw `agent-<id>.jsonl`
  files in the transcript dir).
- A run is keyed by **`runId`**. Resume = relaunch with `{ scriptPath,
  resumeFromRunId }`:
  - The runtime replays the script and, for each `agent()` call, **matches on
    `(prompt, opts)`**. Unchanged calls return the cached journal result instantly.
  - The **first edited/new call and everything after it runs live** — i.e. the
    longest unchanged prefix is reused.
- This is the entire reason `Date.now()`/`random` are banned and `meta` must be a
  literal: **the script must be a deterministic function of `(source, args,
  journal)`** for prefix-matching to be sound. Same script + same args ⇒ 100% cache
  hit.

### 2.8 Budget governor
- A shared token pool for the turn (`budget.total`, set by a user "+500k"-style
  directive). `spent()` aggregates **main loop + all workflow agents**.
- The ceiling is **hard**: once `spent() ≥ total`, further `agent()` calls throw —
  enabling `while (budget.remaining() > N)` loops and `Math.floor(total/100k)`
  fleet-sizing.

### 2.9 Lifecycle / handoff back to main loop
- Workflow tool returns **immediately** (`{ runId, scriptPath }`); the run
  continues detached.
- On completion the harness re-invokes the main loop with a `<task-notification>` —
  the same background-task mechanism used elsewhere. The script's `return` value is
  surfaced as the result.

---

## 3. Execution model — worked example

For the `hector-python-lifecycle-design` workflow:

```
phase('Understand')         → UI group "Understand"
parallel([r1,r2,r3,r4])     → 4 readers submitted; gate admits ≤16, so all 4 run
                              barrier: await all → understand{}
pipeline(SPECS, design, verify)
                            → spec A: design → (resolves) → verify, WHILE
                              spec B is still in design.  No barrier between
                              stages.  Each verify tagged phase:'Stress-test'.
phase('Synthesize')         → UI group "Synthesize"
agent(synthesize, schema)   → single lead-architect agent, schema-forced
return { understand, evaluated, synthesis }
```

Wall-clock ≈ (slowest reader) + (slowest single design→verify chain) +
(synthesize), **not** the sum of per-stage maxima — that's the `pipeline`
no-barrier win.

---

## 4. Design principles I infer the team optimized for

1. **Deterministic control flow, stochastic leaves.** Code does the orchestration;
   the model only fills `agent()` calls. Makes runs legible, resumable, testable.
2. **Resume is a first-class invariant, not a feature.** Almost every constraint
   (literal `meta`, no clocks/RNG, journaling, prefix-match) exists to make
   `resumeFromRunId` sound and cheap.
3. **Validation at the boundary.** Schema enforcement lives in the tool layer so
   the script never parses model output — failures retry instead of propagating.
4. **Fail-soft fan-out.** `parallel`/`pipeline` degrade a failed item to `null`
   rather than rejecting the whole batch — hence the ubiquitous `.filter(Boolean)`.
5. **Backpressure over blow-up.** A small concurrency gate + a large lifetime cap:
   submit freely, run boundedly.
6. **Shared, hard budget.** One token pool across main loop + workflows, enforced
   as a throwing ceiling so cost is bounded by construction.

---

## 5. Open questions / things I can't observe

- Isolation substrate: V8 isolate vs. worker thread vs. separate process? _(guess: isolate)_
- Is the journal the same store as the transcript `agent-*.jsonl`, or a projection of it?
- How nested `workflow()` budget/cap accounting is reconciled with the parent
  (docs say shared; mechanism unclear).
- Scheduler fairness: strict FIFO, or priority by phase/pipeline-position?
- Where the StructuredOutput retry budget is bounded (infinite retry would stall a slot).
- Whether `meta.phases` ordering is enforced or purely cosmetic for the UI tree.

---

_Reconstructed from the Workflow tool contract and an inspected workflow script.
Sections marked speculative are inference, not confirmed internals._
