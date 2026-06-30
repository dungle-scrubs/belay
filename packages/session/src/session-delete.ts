import type { SessionSummary } from "./inventory";

/**
 * The permanent-delete contract (plan 04): the typed result of purging an archived session's durable
 * storage, and the eligibility rule that gates it. PERMANENT delete is distinct from the soft-delete
 * `session.deleted` marker (which only hides a session, retaining the log) - this removes the session's
 * rows for good. The eligibility is a pure function over a session's summary, SHARED by the store (the
 * authoritative gate before it deletes) and the web (to disable + explain the delete affordance), so the
 * two can never disagree on what "deletable" means. Only an archived session with no live host and no
 * active turn may be purged.
 */

/** Why a permanent delete was rejected (vs. a generic backend failure). */
export type PermanentDeleteRejection = "not-found" | "not-archived" | "protected";

/** The result of a permanent-delete attempt. */
export type PermanentDeleteResult =
  | { readonly ok: true; readonly sessionId: string }
  | {
      readonly ok: false;
      /** A precondition rejection, or `failed` for a backend error. */
      readonly reason: PermanentDeleteRejection | "failed";
      readonly detail: string;
    };

/** The eligibility verdict: ok to delete, or a typed precondition rejection with a reason. */
export type DeleteEligibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PermanentDeleteRejection; readonly detail: string };

/**
 * Whether a session may be permanently deleted, as a typed verdict. A missing session is `not-found`; a
 * non-archived session is `not-archived` (only archived sessions can be purged); a session with a LIVE
 * host or an active (running/queued) turn is `protected`. Anything else is deletable.
 */
export function permanentDeleteEligibility(summary: SessionSummary | null): DeleteEligibility {
  if (!summary) {
    return { ok: false, reason: "not-found", detail: "session not found" };
  }
  if (!summary.archived) {
    return {
      ok: false,
      reason: "not-archived",
      detail: "only archived sessions can be permanently deleted",
    };
  }
  if (summary.host === "live") {
    return { ok: false, reason: "protected", detail: "a host is live on this session" };
  }
  if (summary.activity === "running" || summary.activity === "queued") {
    return { ok: false, reason: "protected", detail: "a turn is active on this session" };
  }
  return { ok: true };
}
