import { useQuery } from "@tanstack/react-query";
import { type SessionSummary, streamTransport } from "@trevor/session";
import { useMemoizedFn } from "ahooks";
import { useMemo } from "react";

export interface InventoryState {
  readonly sessions: readonly SessionSummary[];
  readonly loading: boolean;
  readonly error: string | null;
  /** Forces an immediate re-fetch (e.g. right after an archive/unarchive/delete mutation settles),
   *  so a surface doesn't wait out the 4s poll to drop or restore a row. */
  readonly refetch: () => void;
}

// The inventory rides the same backend as the session transport: same-origin in local dev, or the
// configured Tether URL. A failed endpoint surfaces as an error in the chooser/sidebar. The fetch +
// `{ sessions }` envelope guard now lives on the transport seam (`fetchInventory`), so this hook only
// owns the react-query polling/abort policy.
const INVENTORY_BASE = import.meta.env.VITE_TETHER_URL ?? window.location.origin;
const transport = streamTransport(INVENTORY_BASE);

// Identity-stable empty fallback: a fresh `[]` per render while disabled/loading would churn
// `sessions` (and every memo keyed on it - worktreeActivity, resolvedProject, baseGroups) each render.
const EMPTY_SESSIONS: readonly SessionSummary[] = [];

/**
 * Fetches the session inventory for the resume chooser + the session sidebar, only while `enabled`
 * (a surface using it is open), so a closed surface costs nothing. Re-fetches each time it opens and
 * POLLS while open (the inventory is inherently live data - a session created, switched-to, or whose
 * host.online just landed must appear without a manual close/reopen; otherwise the sidebar shows a
 * stale snapshot that can omit the session you're currently in). Degrades to a visible error rather
 * than an empty list when the backend has no inventory endpoint.
 */
export function useInventory(enabled: boolean): InventoryState {
  const query = useQuery({
    queryKey: ["session-inventory"],
    queryFn: ({ signal }) => transport.fetchInventory(signal),
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: false,
    // Poll while a surface is open so a just-created / just-projected session (e.g. the one you just
    // switched to) shows up promptly instead of waiting for a close+reopen.
    refetchInterval: enabled ? 4_000 : false,
  });
  // Stable identity with the latest query closure: `refetch` rides inside App-level memos (the
  // chooser binding), so a fresh arrow per render would defeat them.
  const refetch = useMemoizedFn(() => void query.refetch());
  const sessions = query.data ?? EMPTY_SESSIONS;
  const loading = query.isLoading && enabled;
  const error = query.error ? (query.error as Error).message : null;
  // One stable object per data change (Tier 1): this feeds PanelHost's `choosers` prop through
  // App's choosersBinding memo, whose shallow compare a per-render literal would always fail.
  return useMemo(
    () => ({ sessions, loading, error, refetch }),
    [sessions, loading, error, refetch],
  );
}
