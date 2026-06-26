import type { SessionSummary } from "@trevor/session";

// The session inventory rides the same backend the session transport does: same-origin to
// the local session-store (the Vite dev proxy forwards /sessions), or the Richter URL when
// VITE_RICHTER_URL is set. A backend without the inventory endpoint surfaces as an error in
// the chooser (never a silent hide), per the M1 degrade-visibly requirement.
const INVENTORY_BASE = import.meta.env.VITE_RICHTER_URL ?? window.location.origin;

/** Fetches the session inventory read model; throws on a non-OK response. */
export async function fetchInventory(signal?: AbortSignal): Promise<SessionSummary[]> {
  const res = await fetch(`${INVENTORY_BASE}/sessions`, { signal });
  if (!res.ok) {
    throw new Error(`inventory request failed (${res.status})`);
  }
  const body = (await res.json()) as { sessions?: unknown };
  return Array.isArray(body.sessions) ? (body.sessions as SessionSummary[]) : [];
}
