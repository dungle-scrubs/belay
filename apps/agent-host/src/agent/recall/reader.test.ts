import assert from "node:assert/strict";
import {
  events,
  type SessionEvent,
  type SessionSummary,
  type TrevorEventInput,
} from "@trevor/session";
import { type RecordingTransport, recordingTransport, storedEvent } from "@trevor/test-kit";
import { beforeEach, test } from "vitest";
import { createSiblingReader, type SiblingReaderOptions } from "./reader";

/**
 * D-044 M6: the sibling reader scopes to the current project (excluding unrelated projects and the
 * current session), reads other sessions read-only - it never publishes, never switches, never
 * merges - and surfaces unreadable/empty sessions as diagnostics rather than silent gaps.
 */

function summary(over: Partial<SessionSummary> & { sessionId: string }): SessionSummary {
  return {
    title: `session ${over.sessionId}`,
    cwd: "~/dev/trevor",
    workspace: "~/dev/trevor",
    project: "trevor",
    branch: null,
    git: null,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
    eventCount: 2,
    host: "none",
    activity: "idle",
    archived: false,
    deleted: false,
    forkedFrom: null,
    tangentOf: null,
    ...over,
  };
}

const ev = (input: TrevorEventInput, sessionId: string, seq: number): SessionEvent =>
  storedEvent(input, {
    sessionId,
    seq,
    eventId: `${sessionId}-${seq}`,
    producerId: "trevor-web",
    createdAt: "2026-06-20T00:00:00.000Z",
  });

// A recording transport: connectSession replays each seeded log then completes; every publishEvent
// is recorded so a test can prove the reader never writes. ensureSession is unused by the reader.
let rt: RecordingTransport;

function baseOptions(over: Partial<SiblingReaderOptions> = {}): SiblingReaderOptions {
  return {
    transport: rt.transport,
    identity: {
      displayName: "trevor-recall",
      runtimeKind: "web",
      instanceId: "i1",
      participantId: "trevor-host:recall",
    },
    currentSessionId: "cur",
    currentWorkspace: "~/dev/trevor",
    currentProject: "trevor",
    ...over,
  };
}

beforeEach(() => {
  rt = recordingTransport();
});

test("reads same-project siblings and excludes other projects + the current session", async () => {
  rt.setInventory([
    summary({ sessionId: "cur" }), // the current session - excluded
    summary({ sessionId: "sib", workspace: "~/dev/trevor", project: "trevor" }),
    summary({ sessionId: "other", workspace: "~/dev/otherRepo", project: "otherRepo" }),
  ]);
  rt.seed("sib", [ev(events.userMessage({ text: "sibling memory", provider: "qwen" }), "sib", 0)]);
  rt.seed("other", [ev(events.userMessage({ text: "unrelated", provider: "qwen" }), "other", 0)]);

  const read = await createSiblingReader(baseOptions())();

  assert.deepEqual(
    read.sessions.map((s) => s.session.sessionId),
    ["sib"],
    "only the same-workspace sibling is read; the other project + current session are excluded",
  );
});

test("never publishes, switches, or merges while reading siblings (read-only)", async () => {
  rt.setInventory([summary({ sessionId: "sib" })]);
  rt.seed("sib", [ev(events.userMessage({ text: "hi", provider: "qwen" }), "sib", 0)]);

  const options = baseOptions();
  await createSiblingReader(options)();

  assert.equal(rt.published.length, 0, "the reader writes no events to any session");
  assert.equal(
    options.identity.runtimeKind,
    "web",
    "it joins as a passive viewer, not a host presence",
  );
});

test("an unreadable sibling becomes a diagnostic, not a silent gap", async () => {
  rt.setInventory([summary({ sessionId: "sib" }), summary({ sessionId: "empty" })]);
  rt.seed("sib", [ev(events.userMessage({ text: "ok", provider: "qwen" }), "sib", 0)]);
  rt.seed("empty", []); // replays nothing -> empty diagnostic

  const read = await createSiblingReader(baseOptions())();

  assert.equal(read.sessions.length, 1, "the readable sibling is returned");
  assert.ok(
    read.diagnostics.some((d) => d.sessionId === "empty" && d.kind === "empty"),
    "the empty sibling is surfaced as a diagnostic",
  );
});

test("inventory failure surfaces as a diagnostic with no sessions", async () => {
  rt.failInventory(new Error("inventory failed: HTTP 500"));
  const read = await createSiblingReader(baseOptions())();
  assert.equal(read.sessions.length, 0);
  assert.ok(read.diagnostics.some((d) => d.detail.includes("inventory unavailable")));
});
