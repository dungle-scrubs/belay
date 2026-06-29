/**
 * The one monorepo-wide "unknown -> displayable string" normalizer. `catch` binds an `unknown`,
 * and `error instanceof Error ? error.message : String(error)` is the same line re-spelled across
 * host, web, and cli. This is its single home so every surface turns a thrown value into a message
 * the same way. Lives in @trevor/session (the shared leaf every package already depends on) rather
 * than the host, whose `msg` is host-private; the host re-exports this as `msg` to keep its callers.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
