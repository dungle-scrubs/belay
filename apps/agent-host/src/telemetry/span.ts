import {
  redactAttributeValue,
  type SpanName,
  type SpanStatus,
  safeAttributes,
  safeEmitSpan,
  type TelemetrySink,
} from "@trevor/session/telemetry";
import { Cause, Clock, Effect, Exit } from "effect";

/**
 * The host's Effect-aware span combinator (plan 13, M3). The shared `withSpan`/`withSpanSync` in
 * `@trevor/session/telemetry` are Promise/sync; the agent host runs on Effect, so its boundaries wrap in
 * this instead. It lives in the host (not the shared package) so `effect` never bundles into the
 * browser-facing telemetry module.
 *
 * `spanEffect(sink, name, attrs)(effect)` times `effect` and pushes ONE finished span on completion:
 * `ok` on success, `error` on failure/defect (with a redacted cause), and an `interrupted`-tagged error
 * span on cancellation - so a cancelled turn is observable, not silent. The sink call is guarded and the
 * exit is passed through unchanged: a span is observability, never flow control.
 */
export function spanEffect<A, E, R>(
  sink: TelemetrySink,
  name: SpanName,
  attributes: Readonly<Record<string, unknown>>,
): (effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> {
  const attrs = safeAttributes(attributes);
  const record = (status: SpanStatus, durationMs: number, error?: string): void => {
    safeEmitSpan(sink, {
      name,
      attributes: attrs,
      status,
      durationMs,
      ...(error ? { error } : {}),
    });
  };
  const recordExit = (exit: Exit.Exit<unknown, unknown>, durationMs: number): void => {
    if (Exit.isSuccess(exit)) {
      record("ok", durationMs);
    } else if (Cause.isInterruptedOnly(exit.cause)) {
      record("error", durationMs, "interrupted");
    } else {
      record("error", durationMs, redactAttributeValue(Cause.pretty(exit.cause)));
    }
  };
  return (effect) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      return yield* effect.pipe(
        Effect.onExit((exit) =>
          Effect.flatMap(Clock.currentTimeMillis, (endedAt) =>
            Effect.sync(() => recordExit(exit, endedAt - startedAt)),
          ),
        ),
      );
    });
}
