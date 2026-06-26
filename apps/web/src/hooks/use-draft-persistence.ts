import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { readDraft, writeDraft } from "@/composer-storage";

/** Draft writes are debounced so typing doesn't hit storage on every keystroke. */
const DRAFT_DEBOUNCE_MS = 300;

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: setDraft is a stable setter.
  useEffect(() => {
    if (!sessionId) {
      return;
    }
    const saved = readDraft(storage, tabId, sessionId);
    if (saved) {
      // Don't overwrite a non-empty in-memory draft (e.g. one quoted/typed before the session id
      // resolved); restore only fills an empty composer.
      setDraft((current) => (current ? current : saved));
    }
    setRestoredSession(sessionId);
  }, [sessionId, tabId, storage]);

  useEffect(() => {
    if (!sessionId || restoredSession !== sessionId) {
      return;
    }
    const handle = setTimeout(
      () => writeDraft(storage, tabId, sessionId, draft),
      DRAFT_DEBOUNCE_MS,
    );
    return () => clearTimeout(handle);
  }, [draft, sessionId, restoredSession, tabId, storage]);
}
