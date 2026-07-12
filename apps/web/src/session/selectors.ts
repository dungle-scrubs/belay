import type { HostPresence } from "@trevor/session";
import {
  activeWorkingRowVisible,
  type HostStatus,
  hostStatus,
  isHostlessPendingPrompt,
  truncate,
  turnStatusHeaderFrom,
  workspaceBasename,
} from "../derive";
import type { SessionReadModel } from "./projection";

export function selectHostStatus(
  model: SessionReadModel,
  presence: readonly HostPresence[] | null,
  nowMs: number,
): HostStatus {
  return hostStatus(model.events, presence, nowMs, model.announcement);
}

export function selectHostlessPending(
  model: SessionReadModel,
  input: {
    readonly connected: boolean;
    readonly graceMs: number;
    readonly leaderPresent: boolean;
    readonly now: number;
  },
): ReturnType<typeof isHostlessPendingPrompt> {
  return isHostlessPendingPrompt(model.events, input);
}

export function selectSessionName(model: SessionReadModel, fallback: string): string {
  const firstUser = model.transcript.find((message) => message.kind === "user");
  const text = firstUser && "text" in firstUser ? firstUser.text.trim().replace(/\s+/g, " ") : "";
  return text ? truncate(text, 60) : fallback;
}

export function selectTabTitle(
  host: Pick<HostStatus, "workspace">,
  target: string,
  defaultSessionId: string,
): string {
  const fromSession =
    target === defaultSessionId ? null : target.replace(/-[0-9a-f]{8}$/, "") || target;
  const label = workspaceBasename(host.workspace) ?? fromSession;
  return label ? `${label} · Trevor` : "Trevor";
}

export function selectTurnStatusHeader(
  model: SessionReadModel,
  options: { readonly hostlessPending: boolean },
): ReturnType<typeof turnStatusHeaderFrom> {
  return turnStatusHeaderFrom(model.events, {
    awaitingResponse: model.awaitingResponse && !options.hostlessPending,
  });
}

/** Whether the inline transcript "working…" row shows: a plain active turn (no task, no delegation),
 *  the mutually-exclusive counterpart to {@link selectTurnStatusHeader}. Shares its host-stranded gate. */
export function selectActiveWorkingRow(
  model: SessionReadModel,
  options: { readonly hostlessPending: boolean },
): boolean {
  return activeWorkingRowVisible(model.events, {
    awaitingResponse: model.awaitingResponse && !options.hostlessPending,
  });
}
