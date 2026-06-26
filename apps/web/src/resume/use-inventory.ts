import { useQuery } from "@tanstack/react-query";
import type { SessionSummary } from "@trevor/session";
import { fetchInventory } from "./inventory-client";

export interface InventoryState {
  readonly sessions: readonly SessionSummary[];
  readonly loading: boolean;
  readonly error: string | null;
}

/**
 * Fetches the session inventory for the resume chooser, only while `enabled` (the modal is
 * open), so a closed chooser costs nothing. Re-fetches each time it opens (the inventory is
 * inherently stale data - hosts come and go), and degrades to a visible error rather than an
 * empty list when the backend has no inventory endpoint.
 */
export function useInventory(enabled: boolean): InventoryState {
  const query = useQuery({
    queryKey: ["session-inventory"],
    queryFn: ({ signal }) => fetchInventory(signal),
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  return {
    sessions: query.data ?? [],
    loading: query.isLoading && enabled,
    error: query.error ? (query.error as Error).message : null,
  };
}
