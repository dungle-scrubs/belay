import { useQuery } from "@tanstack/react-query";
import type { SessionSummary } from "@trevor/session";
import { fetchInventory } from "./inventory-client";

export interface InventoryState {
  readonly sessions: readonly SessionSummary[];
  readonly loading: boolean;
  readonly error: string | null;
}

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
    queryFn: ({ signal }) => fetchInventory(signal),
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: false,
    // Poll while a surface is open so a just-created / just-projected session (e.g. the one you just
    // switched to) shows up promptly instead of waiting for a close+reopen.
    refetchInterval: enabled ? 4_000 : false,
  });
  return {
    sessions: query.data ?? [],
    loading: query.isLoading && enabled,
    error: query.error ? (query.error as Error).message : null,
  };
}
