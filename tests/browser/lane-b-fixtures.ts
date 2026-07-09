import {
  events,
  HOST_ROLE,
  type JobSnapshot,
  PRODUCER_IDS,
  type SessionTransport,
  streamTransport,
} from "@trevor/session";

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
const E2E_HOST_ID = "browser-e2e-host";

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

function hostOnlineWithJobs(jobs: readonly JobSnapshot[]) {
  return events.hostOnline({
    instanceId: E2E_HOST_ID,
    providers: ["fake"],
    default: "fake",
    models: {
      fake: {
        label: "Fake",
        model: "fake-1",
        reasoningLevels: [],
        defaultReasoning: "off",
        kind: "local",
      },
    },
    commands: [],
    agents: [],
    cwd: "/Users/kevin/dev/trevor",
    workspace: "/Users/kevin/dev/trevor",
    jobs,
  });
}

function outputLines(label: string, lines: number): string {
  return Array.from(
    { length: lines },
    (_, index) =>
      `${label} output line ${index}: deterministic live output with enough text to wrap in the detail view.`,
  ).join("\n");
}

export function browserJobSnapshot(
  over: Partial<JobSnapshot> & Pick<JobSnapshot, "id">,
): JobSnapshot {
  const tail = over.tail ?? outputLines(over.id, 20);
  return {
    command: "pnpm test:web --watch",
    source: "bash",
    cwd: "/Users/kevin/dev/trevor",
    startedAt: 1,
    status: "running",
    exitCode: null,
    stdoutTotal: tail.length,
    stderrTotal: 0,
    ...over,
    tail,
  };
}

export async function announceBrowserJob(
  transport: SessionTransport,
  sessionId: string,
  job: JobSnapshot,
): Promise<void> {
  await transport.ensureSession(sessionId);
  await publish(
    transport,
    sessionId,
    events.hostRole({ instanceId: E2E_HOST_ID, role: HOST_ROLE.leader }),
    HOST,
  );
  await publish(transport, sessionId, hostOnlineWithJobs([job]), HOST);
}

export function browserJobTail(label: string, lines: number): string {
  return outputLines(label, lines);
}

export async function seedTangentSession(
  transport: SessionTransport,
  input: {
    readonly parentSessionId: string;
    readonly tangentSessionId: string;
    readonly runId: string;
    readonly quote: string;
    readonly lineLabel: string;
    readonly lines: number;
  },
): Promise<void> {
  await transport.ensureSession(input.tangentSessionId);
  await publish(
    transport,
    input.tangentSessionId,
    events.sessionTangentOf({
      parentSessionId: input.parentSessionId,
      sourceMessageId: "message:seed",
      quote: input.quote,
      label: "Scroll tangent",
    }),
    WEB,
  );
  await publish(
    transport,
    input.tangentSessionId,
    events.userMessage({ text: "Explore this tangent", provider: "fake" }),
    WEB,
  );
  await publish(
    transport,
    input.tangentSessionId,
    events.assistantStarted({ runId: input.runId, warm: true, model: "fake-1", provider: "fake" }),
    HOST,
  );
  await publish(
    transport,
    input.tangentSessionId,
    events.assistantDelta({ runId: input.runId, text: outputLines(input.lineLabel, input.lines) }),
    HOST,
  );
}

export async function growTangentSession(
  transport: SessionTransport,
  tangentSessionId: string,
  runId: string,
  label: string,
  from: number,
  to: number,
): Promise<void> {
  await publish(
    transport,
    tangentSessionId,
    events.assistantDelta({
      runId,
      text: `\n${Array.from(
        { length: to - from },
        (_, index) =>
          `${label} output line ${from + index}: deterministic live output with enough text to wrap in the detail view.`,
      ).join("\n")}`,
    }),
    HOST,
  );
}

export async function seedInlineAgentParent(
  transport: SessionTransport,
  input: {
    readonly parentSessionId: string;
    readonly childSessionId: string;
    readonly agent: string;
  },
): Promise<void> {
  await transport.ensureSession(input.parentSessionId);
  const runId = `agent-link-${input.childSessionId}`;
  await publish(
    transport,
    input.parentSessionId,
    events.userMessage({ text: "Delegate this", provider: "fake" }),
    WEB,
  );
  await publish(
    transport,
    input.parentSessionId,
    events.assistantStarted({ runId, warm: true, model: "fake-1", provider: "fake" }),
    HOST,
  );
  await publish(
    transport,
    input.parentSessionId,
    events.delegatedTo({
      runId,
      childSessionId: input.childSessionId,
      agent: input.agent,
      task: "Inspect the scrolling behavior",
      mode: "inline",
      status: "running",
      model: "fake-1",
    }),
    HOST,
  );
}

export async function seedRunningAgentChild(
  transport: SessionTransport,
  input: {
    readonly childSessionId: string;
    readonly runId: string;
    readonly lineLabel: string;
    readonly lines: number;
  },
): Promise<void> {
  await transport.ensureSession(input.childSessionId);
  await publish(
    transport,
    input.childSessionId,
    events.userMessage({ text: "Child task", provider: "fake" }),
    WEB,
  );
  await publish(
    transport,
    input.childSessionId,
    events.assistantStarted({ runId: input.runId, warm: true, model: "fake-1", provider: "fake" }),
    HOST,
  );
  await publish(
    transport,
    input.childSessionId,
    events.assistantDelta({ runId: input.runId, text: outputLines(input.lineLabel, input.lines) }),
    HOST,
  );
}

export async function growRunningAgentChild(
  transport: SessionTransport,
  childSessionId: string,
  runId: string,
  label: string,
  from: number,
  to: number,
): Promise<void> {
  await growTangentSession(transport, childSessionId, runId, label, from, to);
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

function paragraph(label: string, lines: number): string {
  return Array.from(
    { length: lines },
    (_, index) =>
      `${label} line ${index}: this row intentionally has enough text to wrap and vary transcript height.`,
  ).join("\n\n");
}

/** Seed a transcript with a running tool near the top and varied-height rows below it. The browser
 *  scroll tests complete that tool after the user is reading below it, which forces a real
 *  above-viewport re-measure. */
export async function seedMixedToolTranscript(
  transport: SessionTransport,
  sessionId: string,
): Promise<{ runId: string; callId: string; anchorText: string }> {
  await transport.ensureSession(sessionId);
  const runId = `mixed-${sessionId}`;
  const callId = `tool-${sessionId}`;
  const anchorText = "anchor exchange 12";

  for (let i = 0; i < 4; i += 1) {
    await publish(
      transport,
      sessionId,
      events.userMessage({ text: `warmup prompt ${i}`, provider: "fake" }),
      WEB,
    );
    await publish(
      transport,
      sessionId,
      events.assistantCompleted({
        runId: `warmup-${i}`,
        text: paragraph(`warmup answer ${i}`, i % 2 === 0 ? 2 : 5),
      }),
      HOST,
    );
  }

  await publish(
    transport,
    sessionId,
    events.userMessage({ text: "please inspect the repo with tools", provider: "fake" }),
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
    events.assistantDelta({
      runId,
      text: "I will inspect the workspace and then summarize the relevant files.",
    }),
    HOST,
  );
  await publish(
    transport,
    sessionId,
    events.toolStarted({
      runId,
      callId,
      name: "grep",
      arguments: JSON.stringify({ pattern: "scroll", path: "apps/web/src" }),
    }),
    HOST,
  );

  for (let i = 0; i < 28; i += 1) {
    await publish(
      transport,
      sessionId,
      events.userMessage({
        text: i === 12 ? anchorText : `mixed prompt ${i}`,
        provider: "fake",
      }),
      WEB,
    );
    await publish(
      transport,
      sessionId,
      events.assistantCompleted({
        runId: `mixed-answer-${i}`,
        text: paragraph(`mixed answer ${i}`, i % 3 === 0 ? 7 : i % 3 === 1 ? 1 : 4),
      }),
      HOST,
    );
  }

  return { runId, callId, anchorText };
}

/** Complete the seeded running tool with a large result, expanding a row that can be above the viewport. */
export async function completeMixedTool(
  transport: SessionTransport,
  sessionId: string,
  ids: { runId: string; callId: string },
): Promise<void> {
  await publish(
    transport,
    sessionId,
    events.toolCompleted({
      runId: ids.runId,
      callId: ids.callId,
      name: "grep",
      result: paragraph("apps/web/src/components/chat/virtual-transcript.tsx: scroll match", 80),
    }),
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
