import {
  type AdmissionEstimate,
  type AdmissionOwner,
  type AdmissionPriority,
  type AdmissionRefusalClass,
  type AdmissionReleaseReason,
  NO_ESTIMATE,
} from "./contract";
import {
  ADMISSION_HEARTBEAT_MS,
  ADMISSION_POLL_MS,
  type AdmissionCaps,
  AdmissionStoreUnavailable,
  acquireAdmission,
  heartbeatAdmission,
  pollAdmission,
  releaseAdmission,
} from "./store";

/**
 * The admission RUNTIME facade (plan 11 M5/M6): turns the pure acquire/poll/release store into a
 * "wait until it's my turn, then hold it, releasably and cancellably" handle the provider integration
 * wraps around local-model work. It owns the cross-process WAIT loop (poll the shared queue until the
 * slot is mine), the active HEARTBEAT (so a long generation is never reaped as stale), and the
 * CANCELLATION path (an aborted wait removes the queued request; an aborted hold releases the lease).
 *
 * It is deliberately FAIL-OPEN for refusals: a context-budget refusal or an unreachable store yields a
 * no-op handle (logged via the injected reporter) and lets the work proceed, because admission is a
 * coordination + visibility layer, not a hard gate - it must never wedge a user turn shut. The genuine
 * serialization value (one generation at a time per resource) comes from the WAIT, which still applies.
 */

/** A held admission reservation: release it (idempotently) when the work ends. A no-op handle (refused /
 *  fail-open) releases to nothing. */
export interface AdmissionHandle {
  /** Whether a real lease is held (false for a fail-open no-op handle). */
  readonly held: boolean;
  /** The owner id of the held reservation (for correlation), or null for a no-op handle. */
  readonly ownerId: string | null;
  release(reason: AdmissionReleaseReason): Promise<void>;
}

/** A status callback the runtime invokes as a request moves through queued -> acquired (for events). */
export type AdmissionStatusListener = (status: AdmissionStatusUpdate) => void;

/** The target identity + priority every status update carries, so a listener can build the user-facing
 *  "waiting for {model}" event without re-deriving them. */
interface AdmissionStatusBase {
  readonly provider: string;
  readonly model: string;
  readonly priority: AdmissionPriority;
}

/** A status update emitted while waiting/holding, for the protocol + /doctor surfaces. */
export type AdmissionStatusUpdate =
  | (AdmissionStatusBase & { readonly phase: "queued"; readonly position: number })
  | (AdmissionStatusBase & { readonly phase: "acquired" })
  | (AdmissionStatusBase & { readonly phase: "refused"; readonly refusal: AdmissionRefusalClass });

/** What the runtime needs to acquire + hold admission for one unit of local-model work. */
export interface AdmitOptions {
  readonly key: string;
  readonly owner: AdmissionOwner;
  readonly priority: AdmissionPriority;
  readonly estimate?: AdmissionEstimate;
  readonly capacity?: number;
  /** Aborts the wait (cancels a queued request) and is observed by the caller's interrupt path. */
  readonly signal?: AbortSignal;
  /** Notified on queued/acquired/refused transitions (drives the status events). */
  readonly onStatus?: AdmissionStatusListener;
  /** How often to poll the queue while waiting (default {@link ADMISSION_HEARTBEAT_MS}). */
  readonly pollIntervalMs?: number;
  /** How often to heartbeat while holding (default {@link ADMISSION_HEARTBEAT_MS}). */
  readonly heartbeatIntervalMs?: number;
}

/** A reporter for the fail-open log line (injected so the core stays pure; the host passes its logger). */
export type AdmissionReporter = (event: string, detail: Record<string, unknown>) => void;

const NOOP_HANDLE: AdmissionHandle = {
  held: false,
  ownerId: null,
  release: async () => {},
};

/** The phase-specific status core; {@link notify} stamps the shared target identity + priority onto it. */
type StatusCore =
  | { readonly phase: "queued"; readonly position: number }
  | { readonly phase: "acquired" }
  | { readonly phase: "refused"; readonly refusal: AdmissionRefusalClass };

/** Invokes the caller's status listener with the target identity + priority filled in from the request. */
function notify(opts: AdmitOptions, update: StatusCore): void {
  opts.onStatus?.({
    ...update,
    provider: opts.owner.provider,
    model: opts.owner.model,
    priority: opts.priority,
  });
}

/** A poll-interval sleep that wakes IMMEDIATELY on abort (it races the injected sleep against the abort
 *  event), so cancelling a queued turn frees its slot at once instead of one poll interval later. */
function sleep(caps: AdmissionCaps, ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  if (!signal) {
    return caps.sleep(ms);
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    void caps.sleep(ms).then(done);
  });
}

/**
 * Acquires admission for a unit of local-model work, WAITING in the cross-process queue until the slot
 * is granted, then returns a handle that heartbeats the hold until released. A context-budget refusal or
 * an unreachable store fails open to a no-op handle (the work proceeds) after reporting it. Aborting the
 * signal while queued cancels the request (removes it from the queue) and returns a no-op handle.
 */
export async function admit(
  opts: AdmitOptions,
  caps: AdmissionCaps,
  report: AdmissionReporter = () => {},
): Promise<AdmissionHandle> {
  const { key, owner } = opts;
  const pollIntervalMs = opts.pollIntervalMs ?? ADMISSION_POLL_MS;
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? ADMISSION_HEARTBEAT_MS;

  let outcome: Awaited<ReturnType<typeof acquireAdmission>>;
  try {
    outcome = await acquireAdmission(
      {
        key,
        owner,
        priority: opts.priority,
        estimate: opts.estimate ?? NO_ESTIMATE,
        capacity: opts.capacity,
      },
      caps,
    );
  } catch (cause) {
    // Store unreachable: fail open so the turn still runs, but say so.
    report("admission.store_unavailable", {
      key,
      provider: owner.provider,
      model: owner.model,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    notify(opts, { phase: "refused", refusal: "store_unavailable" });
    return NOOP_HANDLE;
  }

  if (outcome.status === "refused") {
    report("admission.refused", {
      key,
      provider: owner.provider,
      model: owner.model,
      refusal: outcome.refusal,
    });
    notify(opts, { phase: "refused", refusal: outcome.refusal });
    return NOOP_HANDLE;
  }

  if (outcome.status === "queued") {
    notify(opts, { phase: "queued", position: outcome.position });
    const acquired = await waitForSlot(opts, caps, pollIntervalMs, outcome.position, report);
    if (!acquired) {
      // Aborted while queued: the queue entry was released; proceed with nothing held.
      return NOOP_HANDLE;
    }
  }

  notify(opts, { phase: "acquired" });
  return heldHandle(key, owner.ownerId, caps, heartbeatIntervalMs);
}

/** The queue wait loop: poll until acquired, gone, or aborted. Returns whether the slot was granted.
 *  `lastPosition` seeds the dedup so a re-emitted "queued" status only fires when the position changes. */
async function waitForSlot(
  opts: AdmitOptions,
  caps: AdmissionCaps,
  pollIntervalMs: number,
  lastPosition: number,
  report: AdmissionReporter,
): Promise<boolean> {
  const { key, owner, signal } = opts;
  let position = lastPosition;
  for (;;) {
    if (signal?.aborted) {
      await releaseAdmission(key, owner.ownerId, caps).catch(() => {});
      return false;
    }
    await sleep(caps, pollIntervalMs, signal);
    if (signal?.aborted) {
      await releaseAdmission(key, owner.ownerId, caps).catch(() => {});
      return false;
    }
    let poll: Awaited<ReturnType<typeof pollAdmission>>;
    try {
      poll = await pollAdmission(key, owner.ownerId, caps);
    } catch (cause) {
      // Store blip mid-wait: fail open rather than wedging the queued turn forever.
      report("admission.poll_failed", {
        key,
        error: cause instanceof AdmissionStoreUnavailable ? cause.message : String(cause),
      });
      return false;
    }
    if (poll.status === "acquired") {
      return true;
    }
    if (poll.status === "gone") {
      // Reaped out from under us (our own heartbeat lapsed) - re-queue. If the re-acquire can't enqueue
      // us (refused / store blip), FAIL OPEN rather than spin forever on gone->refused->gone.
      const re = await acquireAdmission(
        {
          key,
          owner,
          priority: opts.priority,
          estimate: opts.estimate ?? NO_ESTIMATE,
          capacity: opts.capacity,
        },
        caps,
      ).catch(() => null);
      if (re?.status === "acquired") {
        return true;
      }
      if (!re || re.status === "refused") {
        return false;
      }
      position = re.position;
      // re-queued: keep polling.
    } else if (poll.position !== position) {
      // Only re-emit the waiting status when our place in line actually moved (avoids spamming the event
      // log + forking a status fiber on every poll of an unchanged position).
      position = poll.position;
      notify(opts, { phase: "queued", position });
    }
  }
}

/** Builds the active-hold handle: a heartbeat timer keeps the lease fresh until release clears it. */
function heldHandle(
  key: string,
  ownerId: string,
  caps: AdmissionCaps,
  heartbeatIntervalMs: number,
): AdmissionHandle {
  let released = false;
  const timer = setInterval(() => {
    void heartbeatAdmission(key, ownerId, caps).catch(() => {});
  }, heartbeatIntervalMs);
  // Don't keep the host process alive solely for an admission heartbeat.
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return {
    held: true,
    ownerId,
    release: async (_reason) => {
      if (released) {
        return;
      }
      released = true;
      clearInterval(timer);
      await releaseAdmission(key, ownerId, caps).catch(() => {});
    },
  };
}
