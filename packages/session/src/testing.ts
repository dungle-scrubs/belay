import type { SessionEvent } from "./event";
import { hostIdentity, RUNTIME_KIND, viewerIdentity } from "./identity";
import { streamTransport } from "./stream-transport";
import type { ConnectSessionOptions, SessionIdentity, SessionTransport } from "./transport";

/** A `SessionIdentity` for a test participant. */
export function testIdentity(id: string, runtimeKind = "test"): SessionIdentity {
  if (runtimeKind === RUNTIME_KIND.host) {
    return hostIdentity({ displayName: id, instanceId: id, participantId: id });
  }
  if (runtimeKind === RUNTIME_KIND.web) {
    return viewerIdentity({ displayName: id, instanceId: id, participantId: id });
  }
  return { displayName: id, runtimeKind, instanceId: id, participantId: id };
}

/** Poll until `predicate` holds or the timeout elapses; event callbacks are async. */
export async function waitFor(
  predicate: () => boolean,
  opts?: { readonly timeoutMs?: number; readonly label?: string },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 2000;
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: ${opts?.label ?? "condition"} not met within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

export interface TestSubscriber {
  readonly events: readonly SessionEvent[];
  readonly connection: { close(): void };
  isReplayed(): boolean;
  waitForReplay(opts?: { readonly timeoutMs?: number; readonly label?: string }): Promise<void>;
  waitForType(
    type: string,
    opts?: { readonly timeoutMs?: number; readonly label?: string },
  ): Promise<SessionEvent>;
}

/** A connected subscriber that records replay state and every event it receives. */
export function subscribe(
  transport: SessionTransport,
  sessionId: string,
  who: string,
  options: Partial<Pick<ConnectSessionOptions, "identity" | "onPresence">> = {},
): TestSubscriber {
  const events: SessionEvent[] = [];
  let replayed = false;
  const connection = transport.connectSession({
    sessionId,
    identity: options.identity ?? testIdentity(who),
    onEvent: (event) => events.push(event),
    onReplayComplete: () => {
      replayed = true;
    },
    onPresence: options.onPresence,
  });
  return {
    events,
    connection,
    isReplayed: () => replayed,
    waitForReplay: (opts) => waitFor(() => replayed, opts),
    waitForType: async (type, opts) => {
      await waitFor(() => events.some((event) => event.type === type), {
        label: opts?.label ?? type,
        timeoutMs: opts?.timeoutMs,
      });
      const event = events.find((item) => item.type === type);
      if (!event) {
        throw new Error(`event ${type} vanished after wait`);
      }
      return event;
    },
  };
}

export async function joinSession(
  target: SessionTransport | { readonly url: string },
  sessionId: string,
  who = "viewer",
): Promise<TestSubscriber> {
  const transport = "url" in target ? streamTransport(target.url) : target;
  await transport.ensureSession(sessionId);
  const subscriber = subscribe(transport, sessionId, who);
  await subscriber.waitForReplay({ label: `${sessionId} replay` });
  return subscriber;
}
