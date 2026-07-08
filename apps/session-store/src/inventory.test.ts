import assert from "node:assert/strict";
import type { PublishInput } from "@trevor/session";
import { test } from "vitest";
import { InventoryProjection } from "./inventory";
import { SessionLog } from "./log";

const at = "2026-06-24T00:00:00.000Z";
const sortById = <T extends { sessionId: string }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => a.sessionId.localeCompare(b.sessionId));

test("a warmed projection returns the same rows log.inventory() would", () => {
  const log = new SessionLog(":memory:");
  log.append("s1", { type: "user.message", producerId: "web", payload: { text: "hi" } }, "e1", at);
  log.append(
    "s1",
    { type: "host.online", producerId: "host", payload: { cwd: "~/dev" } },
    "e2",
    "2026-06-24T00:01:00.000Z",
  );
  log.ensureSession("s2", at); // an empty session must warm too

  const projection = new InventoryProjection(log);

  assert.equal(projection.size, 2);
  assert.deepEqual(sortById(projection.rows()), sortById(log.inventory()));
});

test("recordAppend folds each event into the row, matching a fresh projectRow scan", () => {
  const log = new SessionLog(":memory:");
  const projection = new InventoryProjection(log); // warmed empty

  // A spread that exercises every projected slot: latest host.online wins, first user.message is kept,
  // the lifecycle slice appends in seq order, and each marker's latest wins.
  const inputs: readonly PublishInput[] = [
    { type: "user.message", producerId: "web", payload: { text: "first" } },
    { type: "host.online", producerId: "host", payload: { cwd: "~/old" } },
    { type: "assistant.started", producerId: "host", payload: { runId: "r1" } },
    { type: "user.message", producerId: "web", payload: { text: "second" } },
    { type: "host.online", producerId: "host", payload: { cwd: "~/new" } },
    { type: "assistant.completed", producerId: "host", payload: { runId: "r1" } },
    {
      type: "session.forkedFrom",
      producerId: "web",
      payload: { parentSessionId: "p", forkSeq: 3 },
    },
    {
      type: "session.tangentOf",
      producerId: "web",
      payload: { parentSessionId: "p", sourceMessageId: "m1", quote: "q", label: "L" },
    },
    {
      type: "session.project",
      producerId: "web",
      payload: { path: "/home/u/dev/repo" },
    },
    { type: "session.archived", producerId: "web", payload: { archived: true } },
    { type: "session.title", producerId: "web", payload: { title: "Renamed" } },
    { type: "session.deleted", producerId: "web", payload: { deleted: true } },
    { type: "user.command", producerId: "web", payload: { command: "/help" } },
  ];
  inputs.forEach((input, i) => {
    const stored = log.append(
      "s1",
      input,
      `e${i + 1}`,
      `2026-06-24T00:${String(i).padStart(2, "0")}:00.000Z`,
    );
    projection.recordAppend(stored);
  });

  // The incremental row must equal what a from-scratch scan of the durable log projects.
  assert.deepEqual(projection.get("s1"), log.summaryRow("s1"));

  const row = projection.get("s1");
  assert.equal(row?.eventCount, inputs.length);
  assert.equal(row?.updatedAt, "2026-06-24T00:12:00.000Z"); // the last event's timestamp (minute = index)
  assert.equal((row?.firstUser?.payload as { text?: string }).text, "first"); // set once
  assert.equal((row?.hostOnline?.payload as { cwd?: string }).cwd, "~/new"); // latest wins
  assert.deepEqual(
    row?.lifecycle.map((e) => e.type),
    ["assistant.started", "assistant.completed", "user.command"],
  );
  assert.equal(row?.archived?.type, "session.archived");
  assert.equal(row?.rename?.type, "session.title");
  assert.equal(row?.deleted?.type, "session.deleted");
  assert.equal(row?.forkedFrom?.type, "session.forkedFrom");
  assert.equal(row?.tangentOf?.type, "session.tangentOf");
  assert.equal(row?.projectMarker?.type, "session.project");
});

test("ensure creates an empty row (matching an empty session), idempotently; remove drops it", () => {
  const log = new SessionLog(":memory:");
  const projection = new InventoryProjection(log);

  projection.ensure("s1", at);
  log.ensureSession("s1", at);
  assert.deepEqual(projection.get("s1"), log.summaryRow("s1"));
  assert.equal(projection.size, 1);

  // Idempotent: a second ensure with a different time does not overwrite the original createdAt.
  projection.ensure("s1", "2030-01-01T00:00:00.000Z");
  assert.equal(projection.get("s1")?.createdAt, at);

  projection.remove("s1");
  assert.equal(projection.get("s1"), undefined);
  assert.equal(projection.size, 0);
});

test("recordAppend self-ensures a row when an append is the session's first event", () => {
  const log = new SessionLog(":memory:");
  const projection = new InventoryProjection(log);

  // No prior ensure: the append both creates the session and carries its first event, mirroring the
  // store's append -> ensureSession path. createdAt falls back to the event's own timestamp.
  const stored = log.append(
    "fresh",
    { type: "user.message", producerId: "web", payload: { text: "hello" } },
    "e1",
    at,
  );
  projection.recordAppend(stored);

  assert.deepEqual(projection.get("fresh"), log.summaryRow("fresh"));
  assert.equal(projection.get("fresh")?.createdAt, at);
});
