import { Effect, Exit, Stream } from "effect";
import type { AdmissionReleaseReason } from "./contract";
import type { AdmissionHandle } from "./runtime";

/**
 * The Effect bridge for admission (plan 11 M5/M6): wraps a local-model {@link Stream} so the generation
 * lease is acquired BEFORE the stream starts and released when the stream's scope closes - on normal
 * completion, on failure, or on interruption (a cancelled turn). The acquire runs as a scoped resource
 * (`acquireRelease`), so Effect guarantees the finalizer (release) runs exactly once no matter how the
 * stream ends. The acquire is interruptible via the AbortSignal Effect hands `Effect.promise`, so
 * cancelling a queued turn aborts its wait and frees the lease.
 */

/** Maps a stream-scope exit to the admission release reason: interrupted -> cancelled, failed ->
 *  provider_failure, otherwise success. */
export function releaseReason(exit: Exit.Exit<unknown, unknown>): AdmissionReleaseReason {
  if (Exit.isInterrupted(exit)) {
    return "cancelled";
  }
  if (Exit.isFailure(exit)) {
    return "provider_failure";
  }
  return "success";
}

/**
 * Wraps `makeStream` with admission. `acquire` is the Effect that resolves the held handle (the caller
 * builds it, e.g. reading the per-turn reporter from a fiber-local then awaiting the gate with an
 * interruption-wired AbortSignal); the inner stream then runs holding it, and the handle is released
 * with the exit-derived reason when the scope closes. With a no-op (fail-open) handle this is
 * transparent - the stream runs and the release does nothing.
 *
 * The acquire runs INTERRUPTIBLY (inside `uninterruptibleMask` + `restore`), unlike `acquireRelease`'s
 * uninterruptible acquire, so interrupting a turn that is QUEUED behind another generation aborts the
 * gate's wait signal and frees the queued slot immediately - instead of the cancel hanging until the
 * slot is finally won. The finalizer registration that follows acquire runs uninterruptibly, so a held
 * lease is always released exactly once when the scope closes (completion / failure / interruption).
 */
export function admittedStream<A, E>(
  acquire: Effect.Effect<AdmissionHandle>,
  makeStream: () => Stream.Stream<A, E>,
): Stream.Stream<A, E> {
  return Stream.unwrapScoped(
    Effect.uninterruptibleMask((restore) =>
      restore(acquire).pipe(
        Effect.tap((handle) =>
          Effect.addFinalizer((exit) => Effect.promise(() => handle.release(releaseReason(exit)))),
        ),
        Effect.map(() => makeStream()),
      ),
    ),
  );
}
