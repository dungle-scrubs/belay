/**
 * Responsible for: the pure retry policy for the `@`-mention picker's workspace file-index request
 * (plan 30, decision D-004) - whether the composer should ask the live leader for the index right now.
 * Kept pure + React-independent so the retry-on-leader-change behavior is unit-tested without
 * rendering the app: a request that is LOST (the leader dies or fails to answer before a failover)
 * must not permanently wedge the picker in "loading" for the rest of the session.
 * Not for: actually publishing the request (App's effect) or building the index (the host).
 */

/** The (session, leader) pair the composer has already asked for an index, awaiting an answer. */
export interface FileIndexAsked {
  readonly sessionId: string;
  readonly leaderId: string;
}

/**
 * Whether the composer should publish a new `file.index.requested` right now: there is an active
 * mention, the index is not ready yet, and a leader is present to answer. A request already sent for
 * the EXACT same (session, leader) pair is not repeated while still awaiting an answer - but a leader
 * CHANGE (failover) while still not ready always warrants a retry, since the prior leader may have died
 * before ever answering the original request.
 */
export function shouldRequestFileIndex(params: {
  readonly activeMentionQuery: string | null;
  readonly ready: boolean;
  readonly leaderId: string | null;
  readonly sessionId: string;
  readonly askedFor: FileIndexAsked | null;
}): boolean {
  const { activeMentionQuery, ready, leaderId, sessionId, askedFor } = params;
  if (activeMentionQuery === null || ready || !leaderId) {
    return false;
  }
  if (askedFor && askedFor.sessionId === sessionId && askedFor.leaderId === leaderId) {
    return false;
  }
  return true;
}
