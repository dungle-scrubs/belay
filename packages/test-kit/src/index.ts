import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  awaitSessionEvent,
  type ConnectSessionOptions,
  type DoctorArea,
  type DoctorAreaId,
  type DoctorSnapshot,
  type DoctorStatus,
  decodeTrevorEvent,
  PRODUCER_IDS,
  type ProviderQuestionAnswer,
  type PublishInput,
  readSessionLog,
  type SessionEvent,
  type SessionSummary,
  type SessionTransport,
  type TrevorEventInput,
} from "@trevor/session";
import type { MetricRecord, SpanRecord, TelemetrySink } from "@trevor/session/telemetry";
import { subscribe, testIdentity, waitFor } from "@trevor/session/testing";

export {
  joinSession,
  subscribe,
  type TestSubscriber,
  testIdentity,
  waitFor,
} from "@trevor/session/testing";

/**
 * The generic test harness shared by every integration and e2e test (see repo-root AGENTS.md
 * "Testing"): the durable-log envelope + transport fixtures every test stamps, plus the async-poll
 * helper. These depend only on `@trevor/session`, so the web jsdom project can import them too; the
 * node-only store boot lifecycle (`bootStore`/`bootBlob`, which pulls in the store apps) lives in
 * the separate `@trevor/test-kit/boot` entry. Host-typed helpers (the fake provider, the turn
 * driver) live with the host under `apps/agent-host/test/support` so this package stays free of the
 * host's dependencies.
 */

/** A throwaway temp directory under the OS temp root. Caller removes it (or use `withTempDir`). */
export function tempDir(prefix = "trevor-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** The fixed timestamp every `storedEvent` stamps unless a test overrides `createdAt`. */
const STORED_EVENT_TIME = "2026-01-01T00:00:00.000Z";

/**
 * Stamps an `events.*` input (`{ type, payload }`) into the durable-log envelope the store appends
 * (`{ sessionId, seq, eventId, producerId, createdAt, type, payload }`), so a test never hand-spells
 * the envelope or drifts on its defaults. Defaults to seq 1 from the web producer; `over` sets any
 * field a test cares about (its own `producerId`/`createdAt`, or a specific `seq`/`sessionId`). The
 * canonical envelope is session-store's `EventLog.append`.
 */
export function storedEvent(input: TrevorEventInput, over?: Partial<SessionEvent>): SessionEvent {
  const seq = over?.seq ?? 1;
  return {
    sessionId: "test",
    seq,
    eventId: `e${seq}`,
    producerId: PRODUCER_IDS.web,
    createdAt: STORED_EVENT_TIME,
    type: input.type,
    payload: input.payload,
    ...over,
  };
}

/** Stamps a list of `events.*` inputs into a durable log, auto-sequencing `seq`/`eventId` from 1. */
export function storedLog(...inputs: readonly TrevorEventInput[]): SessionEvent[] {
  return inputs.map((input, index) => storedEvent(input, { seq: index + 1 }));
}

/** A recording in-memory `SessionTransport`: a fake backend that seeds replays and records writes. */
export interface RecordingTransport {
  readonly transport: SessionTransport;
  /** The sessionIds `ensureSession` was called with, in order. */
  readonly ensured: readonly string[];
  /** The `ConnectSessionOptions` of every open stream, so a test can drive its callbacks. */
  readonly connects: readonly ConnectSessionOptions[];
  /** The events published to `id`, in order (every write is recorded). */
  publishedBy(id: string): readonly PublishInput[];
  /** All events published across every session, in order. */
  readonly published: readonly PublishInput[];
  /** Seeds the durable log `connectSession` replays for `id` (then calls `onReplayComplete`). */
  seed(id: string, events: readonly SessionEvent[]): void;
  /** Sets the inventory `fetchInventory` returns. */
  setInventory(summaries: readonly SessionSummary[]): void;
  /** Makes `fetchInventory` reject with `error` (the "inventory unavailable" path). */
  failInventory(error: unknown): void;
  /** The sessionIds `permanentlyDeleteSession` was called with, in order. */
  readonly permanentlyDeleted: readonly string[];
}

/**
 * Builds an in-memory `SessionTransport` double for unit tests, replacing the four hand-rolled fakes
 * that each re-implemented the contract. `connectSession` replays a seeded log via `queueMicrotask`
 * then calls `onReplayComplete`, and drives `onStatus("open")` synchronously; every `ensureSession`
 * and `publishEvent` is recorded for assertions. `fetchInventory` returns the seeded inventory (empty
 * by default) or rejects when `failInventory` is set. The open stream options are exposed on
 * `connects` so a test can push `onEvent`/`onStatus`/`onReplayComplete` itself.
 */
export function recordingTransport(): RecordingTransport {
  const ensured: string[] = [];
  const connects: ConnectSessionOptions[] = [];
  const published = new Map<string, PublishInput[]>();
  const allPublished: PublishInput[] = [];
  const logs = new Map<string, readonly SessionEvent[]>();
  const permanentlyDeleted: string[] = [];
  let inventory: readonly SessionSummary[] = [];
  let inventoryError: unknown;

  const transport: SessionTransport = {
    ensureSession: (id) => {
      ensured.push(id);
      return Promise.resolve(id);
    },
    publishEvent: (id, input) => {
      const list = published.get(id) ?? [];
      list.push(input);
      published.set(id, list);
      allPublished.push(input);
      return Promise.resolve();
    },
    connectSession: (options) => {
      connects.push(options);
      options.onStatus?.("open");
      const log = logs.get(options.sessionId) ?? [];
      queueMicrotask(() => {
        for (const event of log) {
          options.onEvent(event);
        }
        options.onReplayComplete?.();
      });
      return { close: () => {} };
    },
    readLog: (sessionId, identity, options) =>
      readSessionLog(transport, sessionId, identity, options),
    awaitEvent: (sessionId, identity, predicate, options) =>
      awaitSessionEvent(transport, sessionId, identity, predicate, options),
    fetchInventory: () =>
      inventoryError ? Promise.reject(inventoryError) : Promise.resolve(inventory),
    permanentlyDeleteSession: (sessionId) => {
      permanentlyDeleted.push(sessionId);
      return Promise.resolve({ ok: true, sessionId });
    },
  };

  return {
    transport,
    ensured,
    connects,
    published: allPublished,
    publishedBy: (id) => published.get(id) ?? [],
    seed: (id, events) => {
      logs.set(id, events);
    },
    setInventory: (summaries) => {
      inventory = summaries;
    },
    failInventory: (error) => {
      inventoryError = error;
    },
    permanentlyDeleted,
  };
}

/**
 * The host-side answer-drain a provider-question e2e plays (the role main.ts's inbound lane plays in
 * the real host): returns a `drain()` that scans a subscriber's growing `events` array for new
 * `provider.question.answer` events and feeds each to `submit` (the runtime's `submitAnswer`),
 * tracking its own consumed cursor. Shared by the ask_user and CLAUDE.md-migration suites so the
 * inbound-lane stand-in is written once.
 */
export function questionAnswerDrain(
  events: readonly SessionEvent[],
  submit: (questionId: string, answer: ProviderQuestionAnswer) => unknown,
): () => void {
  let consumed = 0;
  return () => {
    for (; consumed < events.length; consumed += 1) {
      const decoded = decodeTrevorEvent(events[consumed] as SessionEvent);
      if (decoded?.type === "provider.question.answer") {
        submit(decoded.questionId, decoded.answer);
      }
    }
  };
}

export interface LiveTurnResult {
  readonly completed: SessionEvent;
  readonly events: readonly SessionEvent[];
  readonly text: string;
}

export interface WorkflowTurnResult {
  readonly completed: SessionEvent;
  readonly events: readonly SessionEvent[];
  readonly text: string;
}

export interface WorkflowCommandResult {
  readonly result: SessionEvent;
  readonly events: readonly SessionEvent[];
  readonly text: string;
  readonly ok: boolean;
}

export interface WorkflowDriver {
  readonly sessionId: string;
  readonly events: readonly SessionEvent[];
  readonly isReplayed: () => boolean;
  publish(input: PublishInput): Promise<void>;
  prompt(
    text: string,
    opts?: {
      readonly provider?: string;
      readonly producerId?: string;
      readonly payload?: Record<string, unknown>;
    },
  ): Promise<void>;
  command(
    command: string,
    args?: string,
    opts?: { readonly producerId?: string; readonly timeoutMs?: number; readonly label?: string },
  ): Promise<WorkflowCommandResult>;
  waitForType(
    type: string,
    opts?: { readonly timeoutMs?: number; readonly label?: string },
  ): Promise<SessionEvent>;
  promptToCompletion(
    text: string,
    opts?: {
      readonly provider?: string;
      readonly producerId?: string;
      readonly timeoutMs?: number;
      readonly label?: string;
      readonly payload?: Record<string, unknown>;
    },
  ): Promise<WorkflowTurnResult>;
  readLog(): Promise<readonly SessionEvent[]>;
  close(): void;
}

export async function createWorkflowDriver(
  transport: SessionTransport,
  sessionId: string,
  opts: {
    readonly who?: string;
    readonly producerId?: string;
    readonly provider?: string;
  } = {},
): Promise<WorkflowDriver> {
  await transport.ensureSession(sessionId);
  const who = opts.who ?? "workflow-driver";
  const producerId = opts.producerId ?? "workflow-driver";
  const subscriber = subscribe(transport, sessionId, who, {
    identity: testIdentity(who, "web"),
  });
  await waitFor(subscriber.isReplayed, { label: `${sessionId} replay` });

  const driver: WorkflowDriver = {
    sessionId,
    events: subscriber.events,
    isReplayed: subscriber.isReplayed,
    publish: (input) => transport.publishEvent(sessionId, input),
    prompt: (text, promptOpts) =>
      transport.publishEvent(sessionId, {
        type: "user.message",
        producerId: promptOpts?.producerId ?? producerId,
        payload: {
          text,
          provider: promptOpts?.provider ?? opts.provider,
          ...(promptOpts?.payload ?? {}),
        },
      }),
    command: async (command, args = "", commandOpts) => {
      const mark = subscriber.events.length;
      await transport.publishEvent(sessionId, {
        type: "user.command",
        producerId: commandOpts?.producerId ?? producerId,
        payload: { command, args },
      });
      await waitFor(
        () =>
          subscriber.events
            .slice(mark)
            .some(
              (event) =>
                event.type === "command.result" && String(event.payload.command ?? "") === command,
            ),
        {
          timeoutMs: commandOpts?.timeoutMs ?? 30_000,
          label: commandOpts?.label ?? `command.result ${command}`,
        },
      );
      const after = subscriber.events.slice(mark);
      const result = after.find(
        (event) =>
          event.type === "command.result" && String(event.payload.command ?? "") === command,
      );
      if (!result) {
        throw new Error(`${command} command.result vanished after wait`);
      }
      return {
        result,
        events: after,
        text: String(result.payload.text ?? ""),
        ok: result.payload.ok === true,
      };
    },
    waitForType: async (type, waitOpts) => {
      await waitFor(() => subscriber.events.some((event) => event.type === type), {
        timeoutMs: waitOpts?.timeoutMs,
        label: waitOpts?.label ?? type,
      });
      const event = subscriber.events.find((candidate) => candidate.type === type);
      if (!event) {
        throw new Error(`${type} vanished after wait`);
      }
      return event;
    },
    promptToCompletion: async (text, promptOpts) => {
      const mark = subscriber.events.length;
      await driver.prompt(text, promptOpts);
      await waitFor(
        () => subscriber.events.slice(mark).some((event) => event.type === "assistant.completed"),
        {
          timeoutMs: promptOpts?.timeoutMs ?? 180_000,
          label: promptOpts?.label ?? "assistant.completed",
        },
      );
      const after = subscriber.events.slice(mark);
      const completed = after.find((event) => event.type === "assistant.completed");
      if (!completed) {
        throw new Error("assistant.completed vanished after wait");
      }
      return {
        completed,
        events: after,
        text: String(completed.payload.text ?? ""),
      };
    },
    readLog: () => transport.readLog(sessionId, testIdentity(who, "web")),
    close: () => subscriber.connection.close(),
  };
  return driver;
}

export interface LiveHostHarness {
  readonly events: readonly SessionEvent[];
  waitHostOnline(opts?: { readonly timeoutMs?: number; readonly label?: string }): Promise<void>;
  ask(
    text: string,
    opts?: {
      readonly provider?: string;
      readonly timeoutMs?: number;
      readonly label?: string;
      readonly producerId?: string;
    },
  ): Promise<LiveTurnResult>;
  close(): void;
}

export function liveHost(
  transport: Pick<SessionTransport, "connectSession" | "publishEvent">,
  sessionId: string,
  opts: {
    readonly who?: string;
    readonly producerId?: string;
    readonly provider?: string;
  } = {},
): LiveHostHarness {
  const producerId = opts.producerId ?? "verify";
  const subscriber = subscribe(transport as SessionTransport, sessionId, opts.who ?? "verify", {
    identity: testIdentity(opts.who ?? "verify", "web"),
  });

  return {
    events: subscriber.events,
    waitHostOnline: (waitOpts) =>
      waitFor(() => subscriber.events.some((event) => event.type === "host.online"), {
        timeoutMs: waitOpts?.timeoutMs ?? 60_000,
        label: waitOpts?.label ?? "host.online",
      }),
    ask: async (text, askOpts) => {
      const mark = subscriber.events.length;
      await transport.publishEvent(sessionId, {
        type: "user.message",
        producerId: askOpts?.producerId ?? producerId,
        payload: { text, provider: askOpts?.provider ?? opts.provider },
      });
      await waitFor(
        () => subscriber.events.slice(mark).some((event) => event.type === "assistant.completed"),
        {
          timeoutMs: askOpts?.timeoutMs ?? 180_000,
          label: askOpts?.label ?? "assistant.completed",
        },
      );
      const after = subscriber.events.slice(mark);
      const completed = after.find((event) => event.type === "assistant.completed");
      if (!completed) {
        throw new Error("assistant.completed vanished after wait");
      }
      return {
        completed,
        events: after,
        text: String(completed.payload.text ?? ""),
      };
    },
    close: () => subscriber.connection.close(),
  };
}

/**
 * A `DoctorArea` fixture: the minimal area (`label` echoes `id`, empty `verdict`) with the `id`/`status`
 * a test names, plus any extra fields (facts/findings/nextAction) via `over`. Lets web tests, host tests,
 * the session protocol test, and the stories share one area vocabulary instead of re-spelling literals.
 */
export function doctorArea(
  id: DoctorAreaId,
  status: DoctorStatus,
  over?: Partial<DoctorArea>,
): DoctorArea {
  return { id, label: id, status, verdict: "", ...over };
}

/** A `DoctorSnapshot` fixture: a ready snapshot with no areas by default; `over` sets state/areas/host. */
export function doctorSnapshot(over?: Partial<DoctorSnapshot>): DoctorSnapshot {
  return { state: "ready", areas: [], ...over };
}

/**
 * A `SessionSummary` fixture: a settled, host-less, non-archived session; `over` sets any field a test
 * names (archived/deleted, host/activity, title/project/cwd, ...). The shared home for the summary
 * factory the inventory/resume/archive/sidebar tests each used to hand-roll.
 */
export function sessionSummary(over?: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: "s",
    title: "A session",
    cwd: "~/dev/x",
    workspace: "~/dev/x",
    project: "x",
    projectPath: "~/dev/x",
    branch: "main",
    git: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    eventCount: 3,
    host: "none",
    activity: "settled",
    archived: false,
    deleted: false,
    forkedFrom: null,
    tangentOf: null,
    worktree: null,
    ...over,
  };
}

/** A recording {@link TelemetrySink} for instrumentation tests: captures every finished span + metric so
 *  a test can assert names, statuses, and (already-sanitized) attributes/labels. `named`/`metric` filter. */
export interface RecordingTelemetrySink {
  readonly sink: TelemetrySink;
  readonly spans: readonly SpanRecord[];
  readonly metrics: readonly MetricRecord[];
  named(name: string): readonly SpanRecord[];
  metric(name: string): readonly MetricRecord[];
}

/** Builds a recording telemetry sink (plan 13): the shared fake sink host/store/blob span tests push into. */
export function recordingTelemetrySink(): RecordingTelemetrySink {
  const spans: SpanRecord[] = [];
  const metrics: MetricRecord[] = [];
  return {
    sink: {
      span: (record) => spans.push(record),
      metric: (record) => metrics.push(record),
    },
    spans,
    metrics,
    named: (name) => spans.filter((span) => span.name === name),
    metric: (name) => metrics.filter((point) => point.name === name),
  };
}
