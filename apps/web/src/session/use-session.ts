import {
  type ArtifactRef,
  PRODUCER_IDS,
  type SessionEvent,
  events as sessionEvents,
  type TrevorEventInput,
} from "@trevor/session";
import { useCallback, useEffect, useState } from "react";
import { type ConnectionStatus, connect, type HostPresence, publishEvent } from "./client";

export interface SessionState {
  readonly events: readonly SessionEvent[];
  readonly status: ConnectionStatus;
  readonly replayed: boolean;
  /**
   * The hosts connected to the session right now, as the backend's live transport
   * reports it - or null when the backend never reports presence (e.g. Richter), so
   * callers can fall back to the event-log view instead of reading null as "no host".
   */
  readonly presence: readonly HostPresence[] | null;
  readonly publish: (
    text: string,
    provider: string,
    reasoning?: string,
    artifacts?: readonly ArtifactRef[],
  ) => Promise<void>;
  readonly cancel: (runId: string) => Promise<void>;
  readonly command: (command: string, args: string) => Promise<void>;
  readonly openInEditor: (path: string, line?: number, column?: number) => Promise<void>;
}

/** Subscribes to a session: replay-then-tail into state, plus publish. */
export function useSession(sessionId: string | null): SessionState {
  const [events, setEvents] = useState<readonly SessionEvent[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [replayed, setReplayed] = useState(false);
  const [presence, setPresence] = useState<readonly HostPresence[] | null>(null);

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    setEvents([]);
    setReplayed(false);
    setPresence(null);
    const connection = connect({
      sessionId,
      onEvent: (event) => setEvents((prev) => [...prev, event]),
      onReplayComplete: () => setReplayed(true),
      onStatus: setStatus,
      onPresence: setPresence,
    });
    return () => connection.close();
  }, [sessionId]);

  // Every browser-published event is stamped with the shared web producer id
  // (PRODUCER_IDS.web, owned in @trevor/session) and gated on a live session, so that
  // guard lives here once and the public methods below are one-line delegations to the
  // matching event builder.
  const publishVia = useCallback(
    async (built: TrevorEventInput) => {
      if (!sessionId) {
        return;
      }
      await publishEvent(sessionId, { producerId: PRODUCER_IDS.web, ...built });
    },
    [sessionId],
  );

  const publish = useCallback(
    (text: string, provider: string, reasoning?: string, artifacts?: readonly ArtifactRef[]) =>
      publishVia(sessionEvents.userMessage({ text, provider, reasoning, artifacts })),
    [publishVia],
  );

  // Hard steering: ask the host to abort the active run. runId may be empty when
  // the browser fires ESC before assistant.started lands (cancel "whatever runs").
  const cancel = useCallback(
    (runId: string) => publishVia(sessionEvents.userCancel({ runId })),
    [publishVia],
  );

  // Immediate command lane: route a slash command to the host instead of the model.
  const command = useCallback(
    (command: string, args: string) => publishVia(sessionEvents.userCommand({ command, args })),
    [publishVia],
  );

  // Side-channel: ask the host to open a local file in the editor. Not a chat
  // message or command - it never renders in the transcript.
  const openInEditor = useCallback(
    (path: string, line?: number, column?: number) =>
      publishVia(sessionEvents.editorOpen({ path, line, column })),
    [publishVia],
  );

  return { events, status, replayed, presence, publish, cancel, command, openInEditor };
}
