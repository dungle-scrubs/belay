import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import { readDraft, writeDraft } from "@/composer-storage";

/** Draft writes are debounced so typing doesn't hit storage on every keystroke. */
const DRAFT_DEBOUNCE_MS = 300;

/**
 * A bare slash-command fragment ("/c", "/clear" - starts with "/", no space): the exact condition that
 * opens the composer's command menu. This is transient command typing, not a saved message, so it is
 * never persisted or restored - restoring one would pop the command menu when you switch sessions.
 */
function isCommandFragment(draft: string): boolean {
  return draft.startsWith("/") && !draft.includes(" ");
}

/**
 * Restores and persists the composer's unsubmitted draft per tab+session (D-083). On the first render
 * the session id is known, it restores a saved draft - but never clobbers a non-empty in-memory draft
 * (a draft already typed this load wins). Thereafter it debounces writes of the live draft, clearing
 * the slot when the draft goes empty (so a successful submit, `/clear`, or an explicit clear that
 * empties the composer also clears the stored draft). Writes are gated until the restore has run, so
 * the initial empty draft can never wipe the saved one. Storage failures degrade silently
 * (composer-storage wraps every access).
 */
export function useDraftPersistence({
  storage,
  tabId,
  sessionId,
  draft,
  setDraft,
}: {
  readonly storage: Storage;
  readonly tabId: string;
  readonly sessionId: string | null;
  readonly draft: string;
  readonly setDraft: Dispatch<SetStateAction<string>>;
}): void {
  // The session whose draft has been restored, so the write effect only runs after the restore (and
  // re-restores when the session id changes).
  const [restoredSession, setRestoredSession] = useState<string | null>(null);
  // The previously-restored session id, tracked synchronously so the effect can tell a FIRST restore
  // (fill an empty composer) apart from a genuine SWITCH (reset to the new session's own draft).
  const prevSessionRef = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setDraft is a stable setter.
  useEffect(() => {
    if (!sessionId) {
      return;
    }
    const savedRaw = readDraft(storage, tabId, sessionId) ?? "";
    // A bare command fragment in storage (e.g. a stale "/c" left by an old draft) is not restored, so
    // switching never resurrects it or pops the command menu; setting "" below also clears it on write.
    const saved = isCommandFragment(savedRaw) ? "" : savedRaw;
    const prev = prevSessionRef.current;
    if (prev === sessionId) {
      return;
    }
    prevSessionRef.current = sessionId;
    if (prev === null) {
      // First restore this load: fill only an empty composer (don't clobber a draft typed before the
      // session id resolved).
      setDraft((current) => (current ? current : saved));
    } else {
      // A genuine switch to a different session: reset to THAT session's saved draft (or empty), so the
      // previous session's text - and any open slash menu it triggered - never bleeds across.
      setDraft(saved);
    }
    setRestoredSession(sessionId);
  }, [sessionId, tabId, storage]);

  useEffect(() => {
    if (!sessionId || restoredSession !== sessionId) {
      return;
    }
    const handle = setTimeout(
      // A bare command fragment is transient, not a saved draft: persist "" for it (which also clears
      // any stale fragment already in the slot), so it can never be restored on a later switch.
      () => writeDraft(storage, tabId, sessionId, isCommandFragment(draft) ? "" : draft),
      DRAFT_DEBOUNCE_MS,
    );
    return () => clearTimeout(handle);
  }, [draft, sessionId, restoredSession, tabId, storage]);
}
