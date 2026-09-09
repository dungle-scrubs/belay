/** One-time client-state migration for the Trevor -> Belay rename.
 *
 * Every browser-persisted key was prefixed with the product name, so the rename would otherwise
 * orphan them silently - no error, just an empty composer, lost per-session input history, and a
 * reset layout. This copies each `trevor.*` key to its `belay.*` equivalent and drops the original.
 *
 * Prefix-based rather than an explicit key list, so the session-scoped keys (`trevor.draft.<tab>.<id>`,
 * `trevor.history.<tab>.<id>`) migrate without enumerating live tab/session ids.
 *
 * BOTH stores are scanned: layout and model preferences sit in localStorage, but composer drafts and
 * prompt history are tab-scoped in sessionStorage (`app.tsx` passes `window.sessionStorage` to
 * `useDraftPersistence`/`usePromptHistory`). Scanning only localStorage would silently drop the
 * half-typed prompt this migration exists to preserve.
 *
 * Idempotent: an already-migrated key is never overwritten, and the old key is removed either way,
 * so a second run is a no-op. Safe to delete once every browser that used Trevor has loaded Belay.
 */

const OLD_PREFIX = "trevor.";
const NEW_PREFIX = "belay.";
const OLD_IDENTITY_KEY = "trevor-web-identity";
const NEW_IDENTITY_KEY = "belay-web-identity";

/** Moves one key, preferring an existing destination so a re-run cannot clobber newer state.
 *
 * Never throws: copying transiently doubles usage, so a near-full store can raise QuotaExceededError,
 * and storage access itself throws outright under some privacy settings. This runs at module scope
 * before the app mounts, where an escaping error would be a blank page - losing one key's state is a
 * far better failure than losing the app. */
function moveKey(store: Storage, from: string, to: string): boolean {
  try {
    const value = store.getItem(from);

    if (value === null) {
      return false;
    }

    if (store.getItem(to) === null) {
      store.setItem(to, value);
    }

    store.removeItem(from);
    return true;
  } catch {
    return false;
  }
}

/** Snapshots matching keys via the canonical Storage API. Indices shift as keys are removed, so the
 *  list is materialized before any mutation; `length`/`key()` also survives a stored key that shadows
 *  a Storage member name, which property enumeration would not. */
function staleKeys(store: Storage): readonly string[] {
  const keys: string[] = [];

  try {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);

      if (key?.startsWith(OLD_PREFIX)) {
        keys.push(key);
      }
    }
  } catch {
    return keys;
  }

  return keys;
}

/** Returns the number of keys moved, for the boot log and for assertions in tests. */
export function migrateRenamedStorage(local: Storage, session: Storage): number {
  let moved = 0;

  for (const store of [local, session]) {
    for (const key of staleKeys(store)) {
      if (moveKey(store, key, `${NEW_PREFIX}${key.slice(OLD_PREFIX.length)}`)) {
        moved += 1;
      }
    }
  }

  if (moveKey(session, OLD_IDENTITY_KEY, NEW_IDENTITY_KEY)) {
    moved += 1;
  }

  return moved;
}
