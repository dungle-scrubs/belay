import assert from "node:assert/strict";
import type { SessionSummary } from "@trevor/session";
import { test } from "vitest";
import { type LifecycleIo, renderSessions, runArchive, runList, selectSessions } from "./lifecycle";

/**
 * D-094 M3: the `trevor` lifecycle subcommands. The filtering + rendering + command flow are pure
 * over an injected IO, so these pin the active/archived split, current-project scope, recency order,
 * and the archive/unarchive publish without a running store.
 */

const NOW = Date.parse("2026-06-27T12:00:00.000Z");

function summary(over: Partial<SessionSummary> & { sessionId: string }): SessionSummary {
  return {
    title: `session ${over.sessionId}`,
    cwd: "~/dev/trevorV2",
    workspace: "~/dev/trevorV2",
    project: "trevorV2",
    branch: "main",
    git: null,
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    eventCount: 5,
    host: "none",
    activity: "idle",
    archived: false,
    ...over,
  };
}

test("selectSessions lists active current-project sessions newest-first by default", () => {
  const list = [
    summary({ sessionId: "a", updatedAt: "2026-06-26T01:00:00.000Z" }),
    summary({ sessionId: "b", updatedAt: "2026-06-26T05:00:00.000Z" }),
    summary({ sessionId: "filed", archived: true }),
    summary({ sessionId: "other", project: "otherRepo" }),
  ];
  assert.deepEqual(
    selectSessions(list, "trevorV2", { archived: false }).map((s) => s.sessionId),
    ["b", "a"],
    "archived + other-project excluded; recency desc",
  );
});

test("selectSessions with archived:true lists only archived current-project sessions", () => {
  const list = [
    summary({ sessionId: "a" }),
    summary({ sessionId: "filed", archived: true }),
    summary({ sessionId: "filed-other", archived: true, project: "otherRepo" }),
  ];
  assert.deepEqual(
    selectSessions(list, "trevorV2", { archived: true }).map((s) => s.sessionId),
    ["filed"],
  );
});

test("renderSessions is a compact line per session; empty is explicit", () => {
  assert.equal(renderSessions([], NOW), "No sessions.");
  const out = renderSessions(
    [summary({ sessionId: "s1", activity: "running", host: "live" })],
    NOW,
  );
  assert.ok(out.includes("s1"));
  assert.ok(out.includes("running"));
  assert.ok(out.includes("(main)"));
});

function fakeIo(over: Partial<LifecycleIo> = {}): LifecycleIo & { published: [string, boolean][] } {
  const published: [string, boolean][] = [];
  return {
    fetchSessions: () => Promise.resolve([]),
    publishArchived: (id, archived) => {
      published.push([id, archived]);
      return Promise.resolve();
    },
    now: () => NOW,
    published,
    ...over,
  };
}

test("runList renders the fetched inventory scoped to the project", async () => {
  const io = fakeIo({
    fetchSessions: () =>
      Promise.resolve([
        summary({ sessionId: "keep" }),
        summary({ sessionId: "filed", archived: true }),
      ]),
  });
  const out = await runList(io, "trevorV2", false);
  assert.ok(out.includes("Sessions for trevorV2"));
  assert.ok(out.includes("keep"));
  assert.ok(!out.includes("filed"), "archived excluded from the default list");
});

test("runArchive / unarchive publish the durable marker and confirm", async () => {
  const io = fakeIo();
  assert.equal(await runArchive(io, "s1", true), "Archived s1.");
  assert.equal(await runArchive(io, "s1", false), "Unarchived s1.");
  assert.deepEqual(io.published, [
    ["s1", true],
    ["s1", false],
  ]);
});

test("runArchive with no session id returns usage", async () => {
  const io = fakeIo();
  assert.ok((await runArchive(io, "", true)).startsWith("usage:"));
  assert.equal(io.published.length, 0, "no publish on a usage error");
});
