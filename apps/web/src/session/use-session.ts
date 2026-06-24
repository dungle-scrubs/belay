import { type ArtifactRef, type SessionEvent, events as sessionEvents } from "@trevor/session";
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

  const publish = useCallback(
    async (
      text: string,
      provider: string,
      reasoning?: string,
      artifacts?: readonly ArtifactRef[],
    ) => {
      if (!sessionId) {
        return;
      }
      await publishEvent(sessionId, {
        producerId: "trevor-web",
        ...sessionEvents.userMessage({ text, provider, reasoning, artifacts }),
      });
    },
    [sessionId],
  );

  // Hard steering: ask the host to abort the active run. runId may be empty when
  // the browser fires ESC before assistant.started lands (cancel "whatever runs").
  const cancel = useCallback(
    async (runId: string) => {
      if (!sessionId) {
        return;
      }
      await publishEvent(sessionId, {
        producerId: "trevor-web",
        ...sessionEvents.userCancel({ runId }),
      });
    },
    [sessionId],
  );

  // Immediate command lane: route a slash command to the host instead of the model.
  const command = useCallback(
    async (command: string, args: string) => {
      if (!sessionId) {
        return;
      }
      await publishEvent(sessionId, {
        producerId: "trevor-web",
        ...sessionEvents.userCommand({ command, args }),
      });
    },
    [sessionId],
  );

  return { events, status, replayed, publish, cancel, command };
}
