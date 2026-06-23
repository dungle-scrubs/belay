# apps/agent-host - Agent Instructions

The host: a Node + **Effect** Richter participant that runs the agent loop
(model <-> tools) for each turn. Layers on [`apps/AGENTS.md`](../AGENTS.md) and the
repo-root [`AGENTS.md`](../../AGENTS.md).

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
  validated (A-004, `scripts/spike-a004-interrupt.ts`) - **do not** add manual
  `signal?.aborted` checks or thread an `AbortSignal` through the pipeline; interrupt the
  fiber instead. The D-010 race-and-abandon fallback is held in reserve, not used.
- **Dependencies are services + `Layer`.** Emission is the `Emit` `Context.Tag` service
  (`src/services.ts`); `main` provides `EmitLive`, tests provide a collecting layer
  (`scripts/verify-turn.ts`). Add new cross-cutting collaborators as `Context.Tag` services
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

## Verifying

There is no unit-test runner yet; the host ships per-slice verification scripts. Run the
relevant ones after a change (they are the regression suite):

- `pnpm exec tsx scripts/verify-turn.ts` - the turn pipeline end to end (fake provider,
  multi-step tool loop, via a test `Emit` layer).
- `pnpm exec tsx scripts/verify-tools.ts` and `scripts/verify-bash-safety.ts` - the tools.
- `pnpm exec tsx scripts/spike-a004-interrupt.ts` - interrupt-based cancellation against a
  live LM Studio (skips if unreachable).

Plus `pnpm -r typecheck` and `pnpm biome check` (both run by the pre-commit hook).
