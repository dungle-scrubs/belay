import {
  type ArtifactRef,
  type SessionEvent,
  events as sessionEvents,
  type TrevorEventInput,
} from "@trevor/session";
import { useCallback, useEffect, useState } from "react";
import { type ConnectionStatus, connect, publishEvent } from "./client";

export interface SessionState {
  readonly events: readonly SessionEvent[];
  readonly status: ConnectionStatus;
  readonly replayed: boolean;
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

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    setEvents([]);
    setReplayed(false);
    const connection = connect({
      sessionId,
      onEvent: (event) => setEvents((prev) => [...prev, event]),
      onReplayComplete: () => setReplayed(true),
      onStatus: setStatus,
    });
    return () => connection.close();
  }, [sessionId]);

  // Every browser-published event is stamped with the same web producer id and gated on
  // a live session, so that guard + the "trevor-web" constant live here once and the
  // public methods below are one-line delegations to the matching event builder.
  const publishVia = useCallback(
    async (built: TrevorEventInput) => {
      if (!sessionId) {
        return;
      }
      await publishEvent(sessionId, { producerId: "trevor-web", ...built });
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

  return { events, status, replayed, publish, cancel, command, openInEditor };
}
