import {
  countRestartResumes,
  type ResumeInputs,
  type ResumeMarker,
} from "@host/session/session-lifecycle";
import { decodeTrevorEvent, type SessionEvent } from "@trevor/session";

/**
 * The durable-log projection the auto-resume path reads. The trailing-turn state, the last user
 * prompt, and the resume-marker streak are all backward scans over the SAME replayed log; here they
 * live beside the continuation-prefix encoding that the WRITER (`continueAfterStop`) and these READERS
 * share, so the writer/reader sync hazard closes by colocation and the projection is unit-testable
 * apart from a running host. The pure firing policy stays in session-lifecycle.ts.
 */

/** The prefix every host-issued continuation prompt shares; recognising it in the log is how the
 *  projection tells a restart-resume continuation apart from a genuine user prompt. */
export const CONTINUATION_PREFIX = "Continue from the paused turn.";
/** The reason a host-restart auto-resume stamps on its continuation, so the crash-loop bound can spot
 *  its own prior resumes in the durable log (see {@link resumeProjection}). */
export const RESTART_RESUME_REASON = "host restarted";
export const RESTART_RESUME_PREFIX = `${CONTINUATION_PREFIX} Reason: ${RESTART_RESUME_REASON}`;

/** A decoded `user.message`, the only event the resume projection inspects for prompts. */
export type DecodedUserMessage = Extract<
  ReturnType<typeof decodeTrevorEvent>,
  { type: "user.message" }
>;

/** The most recent `user.message` in the log, or null. */
export function lastUserPrompt(events: readonly SessionEvent[]): DecodedUserMessage | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const decoded = event ? decodeTrevorEvent(event) : null;
    if (decoded?.type === "user.message") {
      return decoded;
    }
  }
  return null;
}

/** The terminal state of the most recent turn (for the resume policy), plus whether a user prompt
 *  already follows it (so it is not the un-continued tail and must be left alone). */
export interface TrailingTurn {
  readonly runId: string;
  readonly interrupted: boolean;
  readonly cancelled: boolean;
  readonly stopCause?: string;
  readonly stopSummary?: string;
  readonly continued: boolean;
}

/** Scans history back to the most recent `assistant.completed`, noting whether any user prompt follows
 *  it. Null when no turn has completed yet. A pure read over the replayed log. */
export function trailingTurn(events: readonly SessionEvent[]): TrailingTurn | null {
  let continued = false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const decoded = event ? decodeTrevorEvent(event) : null;
    if (!decoded) {
      continue;
    }
    if (decoded.type === "user.message") {
      continued = true;
      continue;
    }
    if (decoded.type === "assistant.completed") {
      return {
        runId: decoded.runId,
        interrupted: decoded.interrupted,
        cancelled: decoded.cancelled,
        stopCause: decoded.stop?.cause,
        stopSummary: decoded.stop?.summary,
        continued,
      };
    }
  }
  return null;
}

/** The trailing resume-bound markers (oldest-to-newest), walking back only as far as the streak needs:
 *  a restart-resume continuation extends it; a genuine user prompt or a normal (non-interrupted)
 *  completion ends it. Interrupt completions and all streaming events between resumes are skipped. */
function trailingResumeMarkers(events: readonly SessionEvent[]): ResumeMarker[] {
  const markers: ResumeMarker[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const decoded = event ? decodeTrevorEvent(event) : null;
    if (!decoded) {
      continue;
    }
    let marker: ResumeMarker | null = null;
    if (decoded.type === "user.message") {
      marker = decoded.text.startsWith(RESTART_RESUME_PREFIX) ? "restart-resume" : "user-prompt";
    } else if (decoded.type === "assistant.completed" && !decoded.interrupted) {
      marker = "normal-completion";
    }
    if (!marker) {
      continue;
    }
    markers.push(marker);
    if (marker !== "restart-resume") {
      break; // a boundary: everything earlier is a prior, already-settled streak
    }
  }
  return markers.reverse();
}

/** Projects the durable log into the trailing turn plus the inputs the resume policy decides on (the
 *  `restartResumesSpent` bound is read from the log, so it survives the very restarts it guards). */
export function resumeProjection(events: readonly SessionEvent[]): {
  readonly turn: TrailingTurn | null;
  readonly inputs: ResumeInputs | null;
} {
  const turn = trailingTurn(events);
  if (!turn) {
    return { turn: null, inputs: null };
  }
  const inputs: ResumeInputs = {
    interrupted: turn.interrupted,
    cancelled: turn.cancelled,
    stopCause: turn.stopCause,
    lastWasContinuation: lastUserPrompt(events)?.text.startsWith(CONTINUATION_PREFIX) ?? false,
    restartResumesSpent: countRestartResumes(trailingResumeMarkers(events)),
  };
  return { turn, inputs };
}
