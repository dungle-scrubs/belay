import type { SessionEvent } from "./event";
import { isAnswerableProducer } from "./identity";
import { decodeTrevorEvent } from "./protocol-decode";

/**
 * The durable follow-up queue, derived purely from the session event log (plan 47). A prompt submitted
 * while a turn runs is published immediately as a `user.message` (the browser is no longer the
 * scheduler); the host defers it behind the active turn and drains the backlog in order. Because the
 * queue lives on the append-only log, a restarted / standby-takeover leader re-derives it from the log
 * alone - which is what makes the backlog survive client disconnect and host failover.
 *
 * This module is the single ordering rule both sides share: the host's leader catch-up (which runs each
 * pending prompt in order) and the web's queued-prompt panel (which renders + supersedes them) both call
 * {@link pendingFollowUps}, so they can never disagree about which prompts are still queued.
 *
 * Not for: WHEN a turn runs (the host's turn-scheduler) or the local recall ring (browser localStorage).
 */

/**
 * The `user.message` eventIds retracted by every `user.supersede` in the log (plan 47 D-003). A
 * superseded queued prompt drops out of catch-up and the prompt projection - the append-only-log
 * equivalent of removing it from the queue - while the supersede events themselves stay on the log, so
 * the retraction is auditable (fold vs unqueue vs recall).
 */
export function supersededMessageIds(events: readonly SessionEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    const decoded = decodeTrevorEvent(event);
    if (decoded?.type === "user.supersede") {
      for (const id of decoded.supersedes) {
        ids.add(id);
      }
    }
  }
  return ids;
}

/**
 * The still-queued follow-ups: every answerable `user.message` that no turn has claimed yet and that has
 * not been superseded, in submit (seq) order.
 *
 * "Claimed by a turn" is positional under the host's strict one-turn-at-a-time FIFO: each assistant run
 * (a distinct `assistant.started`/`assistant.completed` runId) consumes the oldest not-yet-claimed
 * prompt. A prompt a run has already claimed - even one orphaned before it completed (a crash/restart
 * mid-turn) - is never returned, so a restart can never loop re-running the same prompt (the attempt is
 * the watermark). A `/clear` resets the queue, matching the projection + scheduler `clearPending`.
 *
 * `selfProducerId` excludes the host's own `user.message` echoes; host CONTROL prompts (`${self}:control`)
 * stay answerable and queue like any browser prompt.
 */
export function pendingFollowUps(
  events: readonly SessionEvent[],
  selfProducerId?: string,
): SessionEvent[] {
  const superseded = supersededMessageIds(events);
  const unclaimed: SessionEvent[] = [];
  const claimedRuns = new Set<string>();
  for (const event of events) {
    const decoded = decodeTrevorEvent(event);
    if (!decoded) {
      continue;
    }
    if (decoded.type === "user.message") {
      if (!isAnswerableProducer(event.producerId, selfProducerId)) {
        continue; // the host's own echo, never a queued prompt
      }
      if (superseded.has(event.eventId)) {
        continue; // retracted on the log - not to run
      }
      unclaimed.push(event);
    } else if (decoded.type === "assistant.started" || decoded.type === "assistant.completed") {
      // A new run claims the oldest unclaimed prompt (FIFO). `started` + `completed` for one turn share
      // a runId, so the turn is counted once; a lost-started orphan completion still claims correctly.
      if (!claimedRuns.has(decoded.runId)) {
        claimedRuns.add(decoded.runId);
        unclaimed.shift();
      }
    } else if (
      decoded.type === "user.command" &&
      decoded.command === "/clear" &&
      isAnswerableProducer(event.producerId, selfProducerId)
    ) {
      // A /clear resets the conversation - the queued prompts before it are dropped (matching the host
      // projection reset + scheduler.clearPending), so a post-clear session starts with an empty queue.
      unclaimed.length = 0;
    }
  }
  return unclaimed;
}
