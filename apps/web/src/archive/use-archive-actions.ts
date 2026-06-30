import { errorMessage, type PermanentDeleteResult } from "@trevor/session";
import { useCallback, useState } from "react";
import type { RowActionState } from "./archive-browser";

/**
 * The archive browser's live action controller (plan 04): owns the per-row async state for
 * unarchive + permanent delete and runs them against injected mutations, so App just renders the
 * `ArchiveBrowser` over the result. Row-scoped by sessionId - acting on one row never blanks another -
 * and on success it triggers a `refresh` (an inventory re-fetch) so the now-unarchived/purged row
 * drops on its own; only a rejection or transport error latches a row-scoped error. Injecting the
 * mutations keeps this hook testable without a transport or query client.
 */

export interface ArchiveActionDeps {
  /** Clears the archived flag (the existing `archiveSession(id, false)` publish). */
  readonly unarchive: (sessionId: string) => Promise<void>;
  /** Permanently purges the session's storage; resolves with the store's typed gate result. */
  readonly remove: (sessionId: string) => Promise<PermanentDeleteResult>;
  /** Re-fetches the inventory so a settled mutation's row drops/restores without waiting the poll. */
  readonly refresh: () => void;
}

export interface ArchiveActions {
  readonly actionState: Readonly<Record<string, RowActionState>>;
  readonly onUnarchive: (sessionId: string) => void;
  readonly onDelete: (sessionId: string) => void;
}

export function useArchiveActions(deps: ArchiveActionDeps): ArchiveActions {
  const { unarchive, remove, refresh } = deps;
  const [actionState, setActionState] = useState<Record<string, RowActionState>>({});

  const setRow = useCallback((sessionId: string, state: RowActionState | null) => {
    setActionState((prev) => {
      if (state === null) {
        if (!(sessionId in prev)) {
          return prev;
        }
        const { [sessionId]: _gone, ...rest } = prev;
        return rest;
      }
      return { ...prev, [sessionId]: state };
    });
  }, []);

  const onUnarchive = useCallback(
    (sessionId: string) => {
      setRow(sessionId, { kind: "unarchiving" });
      unarchive(sessionId)
        .then(() => {
          // The row leaves the archive set on the next inventory snapshot; drop its transient state.
          setRow(sessionId, null);
          refresh();
        })
        .catch((error: unknown) => {
          setRow(sessionId, { kind: "error", message: messageOf(error, "Unarchive failed.") });
        });
    },
    [unarchive, refresh, setRow],
  );

  const onDelete = useCallback(
    (sessionId: string) => {
      setRow(sessionId, { kind: "deleting" });
      remove(sessionId)
        .then((result) => {
          if (result.ok) {
            setRow(sessionId, null);
            refresh();
          } else {
            // The store rejected the purge (not archived, a live host, an active turn): show its reason.
            setRow(sessionId, { kind: "error", message: result.detail });
          }
        })
        .catch((error: unknown) => {
          setRow(sessionId, { kind: "error", message: messageOf(error, "Delete failed.") });
        });
    },
    [remove, refresh, setRow],
  );

  return { actionState, onUnarchive, onDelete };
}

/** A thrown transport error's message (via the shared `errorMessage`), or a friendly fallback when the
 *  throw carries none (e.g. a non-Error reject), since the row shows this text verbatim. */
function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? errorMessage(error) : fallback;
}
