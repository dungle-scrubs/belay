/**
 * Responsible for: the agent loop's stall watchdogs - the provider-stream idle timeout
 * (withStallTimeout) and the per-tool-call wall-clock timeout (withToolStallTimeout), plus their
 * env-tunable defaults.
 * Not for: deciding what happens after a stall failure - retry/reconnect and terminal handling
 * live in the loop (loop.ts).
 */
import { envNumber } from "@host/boot/env";
import type { ProviderError } from "@host/providers";
import { ProviderUnavailable } from "@host/providers";
import { warn } from "@host/transport/log";
import { Clock, Deferred, Duration, Effect, Ref, Stream } from "effect";

/**
 * Provider-stream idle watchdog (ms): if a model stream produces no event for this long, treat it as
 * a stalled (half-open) connection and fail it, so the loop retries or goes terminal instead of
 * hanging forever - the fix for the 18-minute "Working" stall where a half-open Codex stream sent no
 * tokens, close, or error. Env-overridable; set to 0 to disable. Default 90s (xhigh reasoning can
 * pause for a while, so the gap is generous - it only catches a genuinely dead stream).
 */
export const DEFAULT_STREAM_STALL_MS = envNumber("TREVOR_STREAM_STALL_MS", 90_000);

/**
 * Per-tool-call wall-clock watchdog (ms): the tool-side analog of the provider-stream idle watchdog
 * above, which only covers the MODEL stream - not tool execution. A tool that returns no result for
 * this long is treated as a hung call (a half-open socket, a wedged subprocess, a delegation waiting on
 * a dead child) and aborted, so the loop continues instead of latching "Working" forever. Generous by
 * default: bash self-bounds at 30s (run-shell.ts) and reads/greps/edits are local, so the ceiling only
 * trips on a genuine hang, never on legitimately slow work. Env-overridable; set to 0 to disable.
 * Default 300s.
 */
export const DEFAULT_TOOL_STALL_MS = envNumber("TREVOR_TOOL_STALL_MS", 300_000);

/**
 * Tools that block by design and must be EXEMPT from the per-tool stall watchdog: `ask_user` pauses the
 * turn on a human answer with no upper bound (a slow human is not a hung tool). Delegation tools are not
 * listed because the loop routes them to the injected runner (not `executeTool`), where the child turn's
 * own stream + tool watchdogs bound them transitively - capping them here too would double-bound a
 * legitimately long child.
 */
const UNBOUNDED_TOOLS: ReadonlySet<string> = new Set(["ask_user"]);

/**
 * Wraps a provider stream with the idle watchdog: a scoped fiber polls the time since the last event
 * and, past the configured stall timeout, fails the stream with a RETRYABLE ProviderUnavailable. The loop's
 * existing reconnect `catchAll` then retries (when nothing has streamed yet) or, once tokens have
 * flowed, surfaces it as a clear terminal error. A normal end, the stall failure, or an interrupt
 * (ESC/cancel) all close the stream scope and tear the watchdog down.
 */
export function withStallTimeout<A>(
  source: Stream.Stream<A, ProviderError>,
  providerName: string,
  streamStallMs: number,
): Stream.Stream<A, ProviderError> {
  if (streamStallMs <= 0) {
    return source;
  }
  return Stream.unwrapScoped(
    Effect.gen(function* () {
      const lastSeen = yield* Ref.make(yield* Clock.currentTimeMillis);
      const stalled = yield* Deferred.make<never, ProviderError>();
      const bump = Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.set(lastSeen, now)));
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          for (;;) {
            yield* Effect.sleep(Duration.millis(Math.min(streamStallMs, 5_000)));
            const idle = (yield* Clock.currentTimeMillis) - (yield* Ref.get(lastSeen));
            if (idle >= streamStallMs) {
              yield* Deferred.fail(
                stalled,
                new ProviderUnavailable({
                  provider: providerName,
                  detail: `model stream stalled (no output for ${Math.round(streamStallMs / 1000)}s)`,
                  retryable: true,
                }),
              );
              return;
            }
          }
        }),
      );
      const guarded = source.pipe(Stream.tap(() => bump));
      const failOnStall: Stream.Stream<never, ProviderError> = Stream.fromEffect(
        Deferred.await(stalled),
      );
      // haltStrategy "left": the merged stream ends when the SOURCE ends (we don't wait on the
      // never-resolving watchdog); a stall failure still propagates immediately from either side.
      return Stream.merge(guarded, failOnStall, { haltStrategy: "left" });
    }),
  );
}

/**
 * Wraps a single tool-call execution with the per-tool wall-clock watchdog (`toolStallMs`). Unlike the
 * provider-stream watchdog this does NOT fail the turn: `executeTool` resolves to a string and never
 * throws, so on timeout we resolve to an `error:` string the model reads as the tool result. The turn
 * keeps going - the other concurrent results in the batch still commit, and the model gets to react to
 * the timeout - rather than the whole turn going terminal or latching "Working" forever.
 *
 * `toolStallMs <= 0` disables it; tools in {@link UNBOUNDED_TOOLS} are passed through (they block by
 * design). The timeout interrupts the tool's Effect, which frees the loop; an underlying uncancelable
 * promise (a raw fetch, a detached subprocess) may still run to completion in the background, but it no
 * longer blocks the turn.
 */
export function withToolStallTimeout(
  name: string,
  effect: Effect.Effect<string>,
  toolStallMs: number,
): Effect.Effect<string> {
  if (toolStallMs <= 0 || UNBOUNDED_TOOLS.has(name)) {
    return effect;
  }
  return effect.pipe(
    Effect.timeoutTo({
      duration: Duration.millis(toolStallMs),
      onSuccess: (result: string) => result,
      onTimeout: () => {
        warn("tool", "stalled", { name, ms: toolStallMs });
        return (
          `error: tool "${name}" produced no result after ${Math.round(toolStallMs / 1000)}s and was ` +
          "aborted as a hung call; do not retry it blindly - try a different approach or a smaller scope"
        );
      },
    }),
  );
}
