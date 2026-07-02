import { Effect } from "effect";

/** Stream deltas are coalesced until this many chars accumulate, then flushed. */
const DELTA_FLUSH_CHARS = 40;

/**
 * Buffers streamed text on one channel, flushing once it crosses DELTA_FLUSH_CHARS or when
 * explicitly flushed at a boundary. add/flush are Effects; the pending buffer is read at run time
 * via Effect.suspend, so a flush always emits the latest accumulated text.
 */
export class DeltaBuffer {
  private pending = "";

  constructor(private readonly publish: (text: string) => Effect.Effect<void>) {}

  add(text: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.pending += text;
      return this.pending.length >= DELTA_FLUSH_CHARS ? this.flush() : Effect.void;
    });
  }

  flush(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (!this.pending) {
        return Effect.void;
      }
      const text = this.pending;
      this.pending = "";
      return this.publish(text);
    });
  }
}
