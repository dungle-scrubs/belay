/**
 * Parses a serial-worktree-implement request (plan 02, M1): the conversational trigger names an
 * ordered set of plans to implement one tree at a time, and this turns that free text into a validated,
 * de-duplicated, order-preserving queue of real plan ids. Pure over the injected list of available plan
 * dirs, so the parser is unit-tested without touching `.plans/`.
 *
 * A spec token is either a bare number (`03`, `4`, `03.1`) or a full plan id (`03-nested-command-menu`).
 * Each resolves to exactly one available plan by its numeric prefix; an unknown or ambiguous token fails
 * the whole parse (we never silently drop or guess a plan we are about to mutate a worktree for).
 */

/** A parsed queue, or a human-readable reason the request could not be turned into one. */
export type SerialQueueResult =
  | { readonly ok: true; readonly queue: readonly string[] }
  | { readonly ok: false; readonly error: string };

/** The leading numeric key of a plan dir name (`03.1-foo` -> `03.1`), or null when it has none. */
function planNumber(id: string): string | null {
  return id.match(/^(\d+(?:\.\d+)?)-/)?.[1] ?? null;
}

/** Pulls the candidate plan tokens out of the raw trigger text, in order. Accepts bare numbers and
 *  full `NN-name` ids; ignores connective words (and, then, comma, plan(s)). */
function tokenize(raw: string): string[] {
  return raw.toLowerCase().match(/\d+(?:\.\d+)?(?:-[a-z0-9-]+)?/g) ?? [];
}

/** Resolves one token to a single available plan id, or a reason it could not. */
function resolveToken(
  token: string,
  available: readonly string[],
): { readonly ok: true; readonly id: string } | { readonly ok: false; readonly error: string } {
  // A full id (carries a dash after the number) must match an available plan exactly.
  if (token.includes("-")) {
    return available.includes(token)
      ? { ok: true, id: token }
      : { ok: false, error: `unknown plan: ${token}` };
  }
  // A bare number resolves by numeric prefix; exactly one match is required.
  const matches = available.filter((id) => planNumber(id) === token);
  const [first] = matches;
  if (matches.length === 0 || !first) {
    return { ok: false, error: `no plan numbered ${token}` };
  }
  if (matches.length > 1) {
    return { ok: false, error: `ambiguous plan number ${token}: ${matches.join(", ")}` };
  }
  return { ok: true, id: first };
}

/**
 * Parses `raw` into an ordered queue of available plan ids. Order follows first appearance in the text;
 * a repeated plan is collapsed to its first position. An empty request or any unresolved token fails the
 * whole parse with a reason - the run never starts on a partially-understood queue.
 */
export function parseSerialQueue(raw: string, available: readonly string[]): SerialQueueResult {
  const tokens = tokenize(raw);
  if (tokens.length === 0) {
    return { ok: false, error: "no plans named - say which plans to implement, e.g. 03 04 05" };
  }
  const queue: string[] = [];
  for (const token of tokens) {
    const resolved = resolveToken(token, available);
    if (!resolved.ok) {
      return resolved;
    }
    if (!queue.includes(resolved.id)) {
      queue.push(resolved.id);
    }
  }
  return { ok: true, queue };
}
