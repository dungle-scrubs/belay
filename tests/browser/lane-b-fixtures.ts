import { events, PRODUCER_IDS, type SessionTransport, streamTransport } from "@trevor/session";

/**
 * Lane B transcript fixtures (plan 09.2 M3): publish deterministic transcript events straight into the
 * hermetic store the browser is subscribed to, so a spec controls exactly which rows appear and WHEN.
 * Reused by the scroll/pin specs; later app-e2e plans build on these. Content is published directly (not
 * via a live host turn) so append timing is fully under test control - the determinism Lane B needs.
 */

/** A transport onto the ephemeral store the runner booted (TREVOR_E2E_STORE_URL). */
export function storeTransport(): SessionTransport {
  const url = process.env.TREVOR_E2E_STORE_URL;
  if (!url) {
    throw new Error(
      "TREVOR_E2E_STORE_URL is unset - run via `pnpm test:e2e:browser` (the boot runner).",
    );
  }
  return streamTransport(url);
}

const HOST = PRODUCER_IDS.host;
const WEB = PRODUCER_IDS.web;

async function publish(
  transport: SessionTransport,
  sessionId: string,
  input: { type: string; payload: Record<string, unknown> },
  producerId: string,
): Promise<void> {
  await transport.publishEvent(sessionId, { ...input, producerId });
}

/** Seed a workspace file index (plan 30) straight into the store, as a host would answer a
 *  `file.index.requested`, so the browser's `@`-mention picker can filter it with no live host. */
export async function seedFileIndex(
  transport: SessionTransport,
  sessionId: string,
  paths: readonly string[],
): Promise<void> {
  await transport.ensureSession(sessionId);
  await publish(
    transport,
    sessionId,
    events.fileIndexResult({
      requestId: "seed-index",
      files: paths.map((path) => ({ path })),
      truncated: false,
    }),
    HOST,
  );
}

/** One complete user->assistant exchange = a user row + an assistant row. `n` of them make a transcript
 *  tall enough to scroll. Each assistant turn is fully completed, so nothing renders as stuck "Working". */
export async function seedExchanges(
  transport: SessionTransport,
  sessionId: string,
  n: number,
): Promise<void> {
  await transport.ensureSession(sessionId);
  for (let i = 0; i < n; i += 1) {
    const runId = `seed-${i}`;
    await publish(
      transport,
      sessionId,
      events.userMessage({ text: `prompt ${i}`, provider: "fake" }),
      WEB,
    );
    await publish(
      transport,
      sessionId,
      events.assistantStarted({ runId, warm: true, model: "fake-1", provider: "fake" }),
      HOST,
    );
    await publish(
      transport,
      sessionId,
      events.assistantDelta({ runId, text: `answer ${i}` }),
      HOST,
    );
    await publish(
      transport,
      sessionId,
      events.assistantCompleted({ runId, text: `answer ${i}` }),
      HOST,
    );
  }
}

/** Append one more completed exchange (a new user + assistant row at the live edge). */
export async function appendExchange(
  transport: SessionTransport,
  sessionId: string,
  label: string,
): Promise<void> {
  const runId = `append-${label}`;
  await publish(
    transport,
    sessionId,
    events.userMessage({ text: `appended ${label}`, provider: "fake" }),
    WEB,
  );
  await publish(
    transport,
    sessionId,
    events.assistantStarted({ runId, warm: true, model: "fake-1", provider: "fake" }),
    HOST,
  );
  await publish(
    transport,
    sessionId,
    events.assistantDelta({ runId, text: `reply ${label}` }),
    HOST,
  );
  await publish(
    transport,
    sessionId,
    events.assistantCompleted({ runId, text: `reply ${label}` }),
    HOST,
  );
}

/** Begin a streaming assistant turn (started, no completion yet) and return a handle to grow it delta by
 *  delta - the "mid-stream growing row" case. The row's height increases as deltas land. */
export async function startStreamingTurn(
  transport: SessionTransport,
  sessionId: string,
  runId = "stream-1",
): Promise<{ delta: (text: string) => Promise<void>; complete: (text: string) => Promise<void> }> {
  await publish(
    transport,
    sessionId,
    events.userMessage({ text: "stream please", provider: "fake" }),
    WEB,
  );
  await publish(
    transport,
    sessionId,
    events.assistantStarted({ runId, warm: true, model: "fake-1", provider: "fake" }),
    HOST,
  );
  let full = "";
  return {
    delta: async (text: string) => {
      full += text;
      await publish(transport, sessionId, events.assistantDelta({ runId, text }), HOST);
    },
    complete: async (text: string) => {
      await publish(
        transport,
        sessionId,
        events.assistantCompleted({ runId, text: full + text }),
        HOST,
      );
    },
  };
}
