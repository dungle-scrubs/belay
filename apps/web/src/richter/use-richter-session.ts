import type { SessionEvent } from "@trevor/richter";
import { useCallback, useEffect, useState } from "react";
import { type ConnectionStatus, connect, publishEvent } from "./client";

export interface RichterSession {
  readonly events: readonly SessionEvent[];
  readonly status: ConnectionStatus;
  readonly replayed: boolean;
  readonly publish: (text: string, provider: string, reasoning?: string) => Promise<void>;
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
        type: "user.message",
        producerId: "trevor-web",
        payload: { text, provider, ...(reasoning ? { reasoning } : {}) },
      });
    },
    [sessionId],
  );

  return { events, status, replayed, publish };
}
