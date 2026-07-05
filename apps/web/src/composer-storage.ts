/**
 * Tab-local composer persistence (D-083/D-084): the unsubmitted draft and the prompt-history recall
 * ring, kept in tab/session storage rather than the durable Tether log. Both are keyed by browser
 * tab id + session id, so distinct tabs and distinct sessions never see each other's drafts/history,
 * and survive a reload of the same tab. Every storage access is wrapped so private-mode / disabled
 * storage degrades to "no persistence" instead of breaking typing.
 *
 * Pure over an injected `Storage` (sessionStorage in the app, a fake in tests) so the read/write/cap/
 * de-dupe rules are unit-tested without a DOM. The hooks (use-draft-persistence, use-prompt-history)
 * own the React glue (restore-once, debounce, recall cursor); the policy lives here.
 */

const DRAFT_VERSION = 1;
const HISTORY_VERSION = 1;
/** The prompt-history recall ring is small - just enough to scroll back through a working session. */
export const HISTORY_CAP = 50;

interface DraftPayload {
  readonly v: number;
  readonly text: string;
}
interface HistoryPayload {
  readonly v: number;
  readonly items: readonly string[];
}

const draftKey = (tabId: string, sessionId: string): string => `trevor.draft.${tabId}.${sessionId}`;
const historyKey = (tabId: string, sessionId: string): string =>
  `trevor.history.${tabId}.${sessionId}`;

function safeGet(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // storage unavailable / quota exceeded: degrade to no-persistence, never throw into typing
  }
}
function safeRemove(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // ignore
  }
}

// --- draft persistence (D-083) ---

/** The persisted unsubmitted draft for this tab+session, or "" when none / unreadable / stale. */
export function readDraft(storage: Storage, tabId: string, sessionId: string): string {
  const raw = safeGet(storage, draftKey(tabId, sessionId));
  if (!raw) {
    return "";
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DraftPayload>;
    if (parsed && parsed.v === DRAFT_VERSION && typeof parsed.text === "string") {
      return parsed.text;
    }
  } catch {
    // malformed payload: treat as no draft
  }
  return "";
}

/** Persists the draft (a versioned payload), or clears the slot when the draft is empty. */
export function writeDraft(storage: Storage, tabId: string, sessionId: string, text: string): void {
  if (!text) {
    safeRemove(storage, draftKey(tabId, sessionId));
    return;
  }
  safeSet(storage, draftKey(tabId, sessionId), JSON.stringify({ v: DRAFT_VERSION, text }));
}

/** Drops the persisted draft for this tab+session (submit / `/clear` / explicit clear). */
export function clearDraft(storage: Storage, tabId: string, sessionId: string): void {
  safeRemove(storage, draftKey(tabId, sessionId));
}

// --- prompt history (D-084) ---

/** The recall ring for this tab+session, oldest first, or [] when none / unreadable / stale. */
export function readHistory(storage: Storage, tabId: string, sessionId: string): string[] {
  const raw = safeGet(storage, historyKey(tabId, sessionId));
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<HistoryPayload>;
    if (parsed && parsed.v === HISTORY_VERSION && Array.isArray(parsed.items)) {
      return parsed.items.filter((item): item is string => typeof item === "string");
    }
  } catch {
    // malformed payload: treat as empty history
  }
  return [];
}

/**
 * Appends one entry to the recall ring and returns the new ring. Empty/whitespace-only entries and an
 * adjacent duplicate of the newest entry are dropped (so holding Enter on the same prompt doesn't fill
 * the ring), and the ring is capped to the newest `HISTORY_CAP`.
 */
export function appendHistory(
  storage: Storage,
  tabId: string,
  sessionId: string,
  entry: string,
): string[] {
  const text = entry.trim();
  const items = readHistory(storage, tabId, sessionId);
  if (!text || items[items.length - 1] === text) {
    return items;
  }
  const next = [...items, text].slice(-HISTORY_CAP);
  safeSet(
    storage,
    historyKey(tabId, sessionId),
    JSON.stringify({ v: HISTORY_VERSION, items: next }),
  );
  return next;
}
