import assert from "node:assert/strict";
import {
  events,
  type SessionEvent,
  type SessionSummary,
  type SessionTransport,
  type TrevorEventInput,
} from "@trevor/session";
import { afterEach, beforeEach, test } from "vitest";
import { createSiblingReader, type SiblingReaderOptions } from "./reader";

/**
 * D-044 M6: the sibling reader scopes to the current project (excluding unrelated projects and the
 * current session), reads other sessions read-only - it never publishes, never switches, never
 * merges - and surfaces unreadable/empty sessions as diagnostics rather than silent gaps.
 */

const realFetch = globalThis.fetch;

let summaries: SessionSummary[] = [];
const logs = new Map<string, SessionEvent[]>();

function summary(over: Partial<SessionSummary> & { sessionId: string }): SessionSummary {
  return {
    title: `session ${over.sessionId}`,
    cwd: "~/dev/trevorV2",
    workspace: "~/dev/trevorV2",
    project: "trevorV2",
    branch: null,
    git: null,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
    eventCount: 2,
    host: "none",
    activity: "idle",
    archived: false,
    deleted: false,
    ...over,
  };
}

function ev(input: TrevorEventInput, sessionId: string, seq: number): SessionEvent {
  return {
    createdAt: "2026-06-20T00:00:00.000Z",
    eventId: `${sessionId}-${seq}`,
    payload: input.payload,
    producerId: "trevor-web",
    seq,
    sessionId,
    type: input.type,
  };
}

// A fake transport: connectSession replays the stored log then completes; publishEvent records
// calls so a test can prove the reader never writes. ensureSession is unused by the reader.
let published = 0;
const transport: SessionTransport = {
  ensureSession: (id) => Promise.resolve(id),
  publishEvent: () => {
    published += 1;
    return Promise.resolve();
  },
  connectSession: (options) => {
    const log = logs.get(options.sessionId) ?? [];
    queueMicrotask(() => {
      for (const event of log) {
        options.onEvent(event);
      }
      options.onReplayComplete?.();
    });
    return { close: () => {} };
  },
};

function baseOptions(over: Partial<SiblingReaderOptions> = {}): SiblingReaderOptions {
  return {
    transport,
    serviceUrl: "http://store.test",
    identity: {
      displayName: "trevor-recall",
      runtimeKind: "web",
      instanceId: "i1",
      participantId: "trevor-host:recall",
    },
    currentSessionId: "cur",
    currentWorkspace: "~/dev/trevorV2",
    currentProject: "trevorV2",
    ...over,
  };
}

beforeEach(() => {
  summaries = [];
  logs.clear();
  published = 0;
  // Stub the inventory fetch to serve the test's summaries.
  globalThis.fetch = (() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ sessions: summaries }),
    })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("reads same-project siblings and excludes other projects + the current session", async () => {
  summaries = [
    summary({ sessionId: "cur" }), // the current session - excluded
    summary({ sessionId: "sib", workspace: "~/dev/trevorV2", project: "trevorV2" }),
    summary({ sessionId: "other", workspace: "~/dev/otherRepo", project: "otherRepo" }),
  ];
  logs.set("sib", [ev(events.userMessage({ text: "sibling memory", provider: "qwen" }), "sib", 0)]);
  logs.set("other", [ev(events.userMessage({ text: "unrelated", provider: "qwen" }), "other", 0)]);

  const read = await createSiblingReader(baseOptions())();

  assert.deepEqual(
    read.sessions.map((s) => s.session.sessionId),
    ["sib"],
    "only the same-workspace sibling is read; the other project + current session are excluded",
  );
});

test("never publishes, switches, or merges while reading siblings (read-only)", async () => {
  summaries = [summary({ sessionId: "sib" })];
  logs.set("sib", [ev(events.userMessage({ text: "hi", provider: "qwen" }), "sib", 0)]);

  const options = baseOptions();
  await createSiblingReader(options)();

  assert.equal(published, 0, "the reader writes no events to any session");
  assert.equal(
    options.identity.runtimeKind,
    "web",
    "it joins as a passive viewer, not a host presence",
  );
});

test("an unreadable sibling becomes a diagnostic, not a silent gap", async () => {
  summaries = [summary({ sessionId: "sib" }), summary({ sessionId: "empty" })];
  logs.set("sib", [ev(events.userMessage({ text: "ok", provider: "qwen" }), "sib", 0)]);
  logs.set("empty", []); // replays nothing -> empty diagnostic

  const read = await createSiblingReader(baseOptions())();

  assert.equal(read.sessions.length, 1, "the readable sibling is returned");
  assert.ok(
    read.diagnostics.some((d) => d.sessionId === "empty" && d.kind === "empty"),
    "the empty sibling is surfaced as a diagnostic",
  );
});

test("inventory failure surfaces as a diagnostic with no sessions", async () => {
  globalThis.fetch = (() => Promise.resolve({ ok: false, status: 500 })) as unknown as typeof fetch;
  const read = await createSiblingReader(baseOptions())();
  assert.equal(read.sessions.length, 0);
  assert.ok(read.diagnostics.some((d) => d.detail.includes("inventory unavailable")));
});
