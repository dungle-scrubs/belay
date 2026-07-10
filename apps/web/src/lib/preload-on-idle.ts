/**
 * Wraps a dynamic import for a React.lazy surface so its chunk leaves the initial bundle WITHOUT
 * flashing a Suspense fallback on the hot path (Tier 5.1/5.2): the chunk is warmed during browser
 * idle time right after startup, so by the time the first consumer mounts it is virtually always
 * resolved. The returned thunk is what `lazy()` awaits; calling it earlier (or the idle warm-up
 * firing) starts the same single shared fetch - the import runs at most once.
 */
export function preloadOnIdle<T>(load: () => Promise<T>): () => Promise<T> {
  let loaded: Promise<T> | undefined;
  const ensure = () => {
    loaded ??= load();
    return loaded;
  };
  // No warm-up under vitest: the timer would import the chunk AFTER a fast test file tears its
  // jsdom environment down (an unhandled rejection), and tests want the deterministic on-demand
  // path through Suspense anyway.
  if (typeof window !== "undefined" && import.meta.env.MODE !== "test") {
    // Safari has no requestIdleCallback; a short timeout keeps the warm-up off the critical
    // startup path there instead.
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(() => void ensure());
    } else {
      window.setTimeout(() => void ensure(), 250);
    }
  }
  return ensure;
}
