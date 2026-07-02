import type { McpServerStatusEntry } from "@host/mcp/runtime";
import { relativeTime } from "@trevor/session";
import type { PeripheralState } from "./probe-input";

/**
 * The /doctor MCP rollup (plan 23 M8, D-009): folds the runtime's per-server status snapshot
 * into the one {@link PeripheralState} the doctor MCP area renders, plus the compact debug
 * histogram. Pure over already-redacted data - every field it reads (targets, last errors) was
 * sanitized at the runtime/transport boundary, so nothing here can leak a secret it was never
 * given. Multi-server rollup precedence (the plan's ladder): unconfigured when nothing can run,
 * then auth-needed if ANY enabled server needs credentials (a user action fixes it), then a
 * failed server - classified by its machine-readable lastErrorTag as timeout (a handshake
 * deadline expired; handshake failures are terminal, so the transport parks in "failed") or a
 * generic error - then unavailable if any is closed, else ready with the D-009 facts (counts,
 * transports, freshness, last error).
 *
 * Responsible for: folding MCP runtime status entries into the doctor PeripheralState and the
 * debug summary line.
 * Not for: reading live runtime state (host-facts.ts injects the snapshot) or rendering the
 * area (areas-connectivity.ts peripheralArea).
 */

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Names one server with its already-redacted connection target. */
const serverRef = (entry: McpServerStatusEntry): string => `"${entry.server}" (${entry.target})`;

/** Folds the runtime status snapshot into the doctor MCP peripheral state. */
export function mcpPeripheralState(
  entries: readonly McpServerStatusEntry[],
  nowMs: number,
): PeripheralState {
  const enabled = entries.filter((entry) => entry.enabled);
  if (enabled.length === 0) {
    // Nothing configured, or nothing enabled: the steady "not set up" state, never an error.
    return { kind: "unconfigured" };
  }

  const authNeeded = enabled.filter((entry) => entry.status === "auth_needed");
  if (authNeeded.length > 0) {
    const first = authNeeded[0] as McpServerStatusEntry;
    const more = authNeeded.length > 1 ? ` (+${authNeeded.length - 1} more)` : "";
    return {
      kind: "auth-needed",
      detail: `MCP server ${serverRef(first)} needs authentication${more}`,
    };
  }

  const failed = enabled.find((entry) => entry.status === "failed");
  if (failed) {
    // Classified by TAG, never by message-sniffing: a handshake timeout is terminal (the
    // transport fails and the child is reaped), so it arrives here carrying its timeout tag.
    // A per-request timeout on a READY server never lands in this branch.
    if (failed.lastErrorTag === "McpTimeoutError") {
      return {
        kind: "timeout",
        detail: failed.lastError ?? `MCP server ${serverRef(failed)} timed out`,
      };
    }
    return {
      kind: "error",
      detail: failed.lastError ?? `MCP server ${serverRef(failed)} failed`,
    };
  }

  const closed = enabled.find((entry) => entry.status === "closed");
  if (closed) {
    return {
      kind: "unavailable",
      detail: closed.lastError ?? `MCP connection to "${closed.server}" is closed`,
    };
  }

  return { kind: "ready", detail: readyDetail(enabled, nowMs) };
}

/** The D-009 ready line: counts, transport kinds, capability totals, freshness, last error. */
function readyDetail(enabled: readonly McpServerStatusEntry[], nowMs: number): string {
  const ready = enabled.filter((entry) => entry.status === "ready").length;
  const transports = [...new Set(enabled.map((entry) => entry.transport))].join("+");
  const parts = [`${plural(enabled.length, "server")} (${transports})`, `${ready} ready`];

  const found = enabled.filter((entry) => entry.capabilities.discovered);
  if (found.length > 0) {
    const sum = (read: (entry: McpServerStatusEntry) => number): number =>
      found.reduce((total, entry) => total + read(entry), 0);
    parts.push(
      `${plural(
        sum((entry) => entry.capabilities.counts.tools),
        "tool",
      )} / ` +
        `${plural(
          sum((entry) => entry.capabilities.counts.resources),
          "resource",
        )} / ` +
        `${plural(
          sum((entry) => entry.capabilities.counts.prompts),
          "prompt",
        )}`,
    );
    const freshest = Math.max(
      ...found.map((entry) => entry.capabilities.discoveredAt ?? Number.NEGATIVE_INFINITY),
    );
    if (Number.isFinite(freshest)) {
      parts.push(`checked ${relativeTime(new Date(freshest).toISOString(), nowMs)}`);
    }
  }

  // A per-request failure on an otherwise-ready server (JSON-RPC error, request timeout) is
  // already sanitized at the transport boundary; surface the most recent one as a fact.
  const lastError = enabled.find((entry) => entry.lastError !== undefined)?.lastError;
  if (lastError !== undefined) {
    parts.push(`last error: ${lastError}`);
  }

  return parts.join(" · ");
}

/** One compact status histogram for the debug surface; undefined with nothing configured. */
export function mcpDebugSummary(entries: readonly McpServerStatusEntry[]): string | undefined {
  if (entries.length === 0) {
    return undefined;
  }
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.enabled ? entry.status : "disabled";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const breakdown = [...counts.entries()]
    .map(([status, count]) => `${count} ${status}`)
    .join(" · ");
  return `${plural(entries.length, "server")} · ${breakdown}`;
}
