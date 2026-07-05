/**
 * Responsible for: the shared per-step generation timer. `genMs` runs from the FIRST GENERATED
 * token (reasoning or visible) to done, so tokens/sec covers the same span the output tokens were
 * produced in - timing from the first visible token alone undercounts reasoning models (hidden
 * reasoning runs first), and timing the whole request over-penalizes cloud latency. Shared by the
 * provider stream adapters (the pi-ai cloud + local paths) so the measurement can't drift between them.
 */

export interface GenerationTimer {
  /** Marks the first generated token; later marks are no-ops. */
  mark(): void;
  /** Wall ms from the first generated token (or the request start, when nothing streamed) to now. */
  genMs(): number;
}

/** Starts a timer at the request; `now` is injectable for deterministic tests. */
export function generationTimer(now: () => number = Date.now): GenerationTimer {
  const requestAt = now();

  let generationAt = 0;

  return {
    mark: () => {
      if (generationAt === 0) {
        generationAt = now();
      }
    },
    genMs: () => now() - (generationAt || requestAt),
  };
}
