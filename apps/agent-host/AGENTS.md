# apps/agent-host - Agent Instructions

The host: a Node + **Effect** Richter participant that runs the agent loop
(model <-> tools) for each turn. Layers on [`apps/AGENTS.md`](../AGENTS.md) and the
repo-root [`AGENTS.md`](../../AGENTS.md).

## Structure and naming (plan 22.1)

Every module has a predictable by-domain home; `ARCHITECTURE.md` is the map.

- **No loose files in `src/` root.** Only the composition root (`main.ts`) lives there;
  everything else belongs to a subsystem dir. Enforced by `test/structure.test.ts`.
- **Plural dir = a collection of peers** (`commands/`, `tools/`, `skills/`, `processes/`,
  `providers/`, `prefs/`, `subagents/`, `metrics/`, `worktrees/`). **Singular dir = one
  cohesive subsystem** (`boot/`, `transport/`, `session/`, `handoff/`, `agent/`, `doctor/`).
- **No catch-all dirs.** Never add `lib/`, `utils/`, `helpers/`, `misc/`, or `common/`; a
  leaf helper joins the subsystem that owns its concept.
- **Imports use the `@host/*` alias** (`@host/session/lease`) instead of deep relative
  paths; same-dir imports stay relative (`./lease`). No `index.ts` barrels - import the
  concrete module.
- **Every source file opens with a structured header** so modules are self-describing and
  doc-generatable, in this fixed shape (enforced by `test/header-check.test.ts`):

  ```ts
  /**
   * <optional summary prose - why the module exists, key constraints.>
   *
   * Responsible for: <what this module owns, one line.>
   * Not for: <the adjacent concern a reader might wrongly look for here, and where it lives.>
   */
  ```

  `Responsible for:` is required; `Not for:` is required only where the boundary is easy
  to confuse (its absence means "no adjacent concern worth disambiguating").

## The call graph is Effect - stay inside it

The host's turn pipeline and control plane have been migrated to Effect (stable v3
core). The apps-level "adopt Effect only where it pays" policy governs the *decision* to
adopt; here that decision is made and shipped. So for the host, the default flips: **new
code in the turn pipeline stays within the Effect program** rather than re-deciding per
file. Concretely, follow the patterns already in the tree:

- **Errors are `Data.TaggedError`** in the typed `E` channel, never bare `Error` +
  `try/catch`. See `src/providers/errors.ts`, `src/tools/errors.ts`, and `InvariantError`
  in `src/log.ts`. New failure modes get a named tagged error, not a string or a generic
  `Error`.
- **Streaming is `Stream`.** A provider step is `stream(): Stream<ProviderEvent,
  ProviderError>` (`src/providers/types.ts`, `pi-ai.ts`); the agent loop (`src/agent/loop.ts`)
  and `publishTurn` (`src/turn.ts`) compose Streams/Effects. Don't reintroduce
  `AsyncIterable` or hand-rolled async generators across the pipeline.
- **Cancellation is fiber interruption.** A turn is a forked fiber; `user.cancel`
  interrupts it (`src/main.ts`). The provider Stream's scope aborts the underlying request
  via an `Effect.addFinalizer` -> `AbortController.abort()` bridge in `streamPiAi`. This is
  validated by the hermetic interrupt test in `test/turn.test.ts` (a turn that hangs mid-stream
  is interrupted and closes with a cancelled completion) - **do not** add manual
  `signal?.aborted` checks or thread an `AbortSignal` through the pipeline; interrupt the
  fiber instead. The D-010 race-and-abandon fallback is held in reserve, not used.
- **Dependencies are services + `Layer`.** Emission is the `Emit` `Context.Tag` service
  (`src/services.ts`); `main` provides `EmitLive`, tests provide a collecting layer
  (`test/support/fake-provider.ts`). Add new cross-cutting collaborators as `Context.Tag` services
  with a live Layer and a test Layer - don't thread callbacks.
- **Tools return `Effect<string, ToolError>`** (`src/tools/types.ts`); the executor renders
  the typed failure to one model-facing `error: …` line (`src/tools/index.ts`). A new tool
  fails in the `E` channel; it does not carry its own `try/catch`.
- **Run at the boundary only.** `Effect.runFork` / `runPromise` belong at the imperative
  edges (the Richter callbacks in `main.ts`, `/doctor` in `commands.ts`) - not sprinkled
  inside Effect code.

## Deliberately imperative - leave these plain

These are the host's edges; converting them to Effect is ceremony with no benefit and
fights their design. Do not "fix" them into Effect:

- The **Richter WebSocket connection + replay dispatch** in `src/main.ts` - the transport
  edge; the Effect program runs to it via `runFork`/`runPromise`.
- The **pure, time-injected lease state machine** (`src/lease.ts`) - driven by
  `tick()`/`observe()` with an injected clock, kept synchronous and unit-testable.
- The **`Ring` buffer** (`src/processes.ts`) and the **`log` / `warn` leaf logger**
  (`src/log.ts`) - thin synchronous utilities.

Observability tracing (`Effect.withSpan`, `Effect.log`) is a future add on the turn/tool
Effects when an OTel exporter is wanted; until then the plain `log`/`warn` leaf stays.

## Running the host locally

The host loads your code at process start and holds it for its lifetime - it does **not**
hot-apply source edits. After changing host code (anything the host imports under `src/`),
**restart the host** for the change to take effect. The durable event log survives a
restart, so the session continues from where it was; only the code is reloaded. There is no
in-app restart control - stop and relaunch the process yourself
(`pnpm --filter @trevor/agent-host start:op`, or whatever dev runner you use). `tsx watch`
restarts on a file change but not on a clean exit, so don't rely on a self-exit to relaunch.

Run **exactly one** host against a session. Multiple host processes contend for the same
session lease and churn leadership, and every leadership change reaps in-flight runs - so a
stray/orphaned host shows up as repeating bursts of `cancelled`/`interrupted` completions.
If you see that, check for more than one host (`ps -Ao pid,ppid,command | grep agent-host`,
watch for a process with `ppid 1`) and kill the extras.

## Testing

Follow the project-wide testing doctrine in the repo-root
[`AGENTS.md`](../../AGENTS.md) ("Testing"): tests are placed by scope, the runner is
Vitest with projects, and there is **one test system** - the old hand-run `scripts/verify-*`
regime has been folded into the tiers and removed. Host specifics:

- **Test Effect code by running it at the boundary.** `Effect.runPromise` / `runFork` inside a
  Vitest test (see `test/turn.test.ts`) is the default; reach for `@effect/vitest`'s
  `it.effect` for an Effect-native case. Do not eyeball a script's stdout.
- **Time-injected machines take the clock as an argument.** The lease state machine
  (`src/lease.ts`) is driven by `tick`/`observe` with an explicit time (`src/lease.test.ts`),
  so election, deferral, and ttl takeover are deterministic with no real waiting; use
  `@effect/vitest`'s `TestClock` for Effect-timed code.
- **Inject collaborators as test `Layer`s.** Provide `Emit` (`src/services.ts`) via a
  collecting layer to assert the emitted event sequence; the deterministic **fake provider**
  (`test/support/fake-provider.ts`) stands in for a model so a turn does not depend on a
  model choosing to call a tool.
- **Placement.** Unit tests co-locate (`src/**/foo.test.ts`); host **integration** tests
  (the real turn pipeline, tool fs, bash safety) live in `apps/agent-host/test/`; cross-service
  smoke lives in the top-level `e2e/` workspace.
- **Live LM Studio is a gated lane.** The live agent/context checks live in `e2e/live/` and
  skip with a stated reason when the live host env is absent; they never fail the run.

`pnpm -r typecheck` and `pnpm biome check` run on the pre-commit hook.
