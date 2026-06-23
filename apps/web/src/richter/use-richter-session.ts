import { events as richterEvents, type SessionEvent } from "@trevor/richter";
import { useCallback, useEffect, useState } from "react";
import { type ConnectionStatus, connect, publishEvent } from "./client";

export interface RichterSession {
  readonly events: readonly SessionEvent[];
  readonly status: ConnectionStatus;
  readonly replayed: boolean;
  readonly publish: (text: string, provider: string, reasoning?: string) => Promise<void>;
  readonly cancel: (runId: string) => Promise<void>;
  readonly command: (command: string, args: string) => Promise<void>;
}

/** Subscribes to a Richter session: replay-then-tail into state, plus publish. */
export function useRichterSession(sessionId: string | null): RichterSession {
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
    async (text: string, provider: string, reasoning?: string) => {
      if (!sessionId) {
        return;
      }
      await publishEvent(sessionId, {
        producerId: "trevor-web",
        ...richterEvents.userMessage({ text, provider, reasoning }),
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
        ...richterEvents.userCancel({ runId }),
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
        ...richterEvents.userCommand({ command, args }),
      });
    },
    [sessionId],
  );

  return { events, status, replayed, publish, cancel, command };
}
