/**
 * Ensure the session exists before the host joins its stream, retrying through a
 * not-yet-ready store instead of crashing on the first failure. Under `pnpm dev` the
 * store and host start together and the host routinely wins the race to its first
 * request, so a single `ensureSession` attempt fails with "fetch failed" and the host
 * exits. The LIVE stream already self-heals (connect()'s onStatus reconnect); this gives
 * the INITIAL connect the same resilience. Pure and injectable (the ensure call, the
 * clock, and the retry hook are parameters) so it is unit-tested with no real store and
 * no process exit.
 */
export interface EnsureRetryOptions {
  /** Total attempts before giving up (default 30 -> ~30s with the default delay). */
  readonly attempts?: number;
  /** Delay between attempts in ms (default 1000). */
  readonly delayMs?: number;
  /** Called once per failed attempt that will be retried (not on the final throw). */
  readonly onRetry?: (attempt: number, error: unknown) => void;
  /** Sleep injection point for tests (default: real setTimeout). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export async function ensureSessionWithRetry(
  ensure: () => Promise<unknown>,
  opts: EnsureRetryOptions = {},
): Promise<void> {
  const attempts = opts.attempts ?? 30;
  const delayMs = opts.delayMs ?? 1000;
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; ; attempt += 1) {
    try {
      await ensure();
      return;
    } catch (error) {
      if (attempt >= attempts) {
        throw error;
      }
      opts.onRetry?.(attempt, error);
      await sleep(delayMs);
    }
  }
}
