import assert from "node:assert/strict";
import type { SessionSummary } from "@trevor/session";
import { test } from "vitest";
import {
  expandHome,
  type LifecycleIo,
  renderSessions,
  resolveOpenTarget,
  runArchive,
  runList,
  runStop,
  selectSessions,
} from "./lifecycle";

/**
 * D-094 M3: the `trevor` lifecycle subcommands. The filtering + rendering + command flow are pure
 * over an injected IO, so these pin the active/archived split, current-project scope, recency order,
 * and the archive/unarchive publish without a running store.
 */

const NOW = Date.parse("2026-06-27T12:00:00.000Z");

function summary(over: Partial<SessionSummary> & { sessionId: string }): SessionSummary {
  return {
    title: `session ${over.sessionId}`,
    cwd: "~/dev/trevor",
    workspace: "~/dev/trevor",
    project: "trevor",
    branch: "main",
    git: null,
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    eventCount: 5,
    host: "none",
    activity: "idle",
    archived: false,
    deleted: false,
    forkedFrom: null,
    tangentOf: null,
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
    selectSessions(list, "trevor", { archived: false }).map((s) => s.sessionId),
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
    selectSessions(list, "trevor", { archived: true }).map((s) => s.sessionId),
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
  const out = await runList(io, "trevor", false);
  assert.ok(out.includes("Sessions for trevor"));
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

function fakeHostIo(
  hosts: Record<string, { pid: number }>,
  alive: (pid: number) => boolean = () => true,
) {
  const signalled: [number, string][] = [];
  const removed: string[] = [];
  return {
    io: {
      lookupHost: (id: string) => hosts[id] ?? null,
      processAlive: alive,
      signal: (pid: number, sig: "SIGTERM" | "SIGKILL") => signalled.push([pid, sig]),
      removeHost: (id: string) => removed.push(id),
    },
    signalled,
    removed,
  };
}

test("runStop sends SIGTERM to the live host and drops the ownership record", () => {
  const { io, signalled, removed } = fakeHostIo({ s1: { pid: 4242 } });
  const out = runStop(io, "s1", false);
  assert.ok(out.includes("Stopping"));
  assert.deepEqual(signalled, [[4242, "SIGTERM"]]);
  assert.deepEqual(removed, ["s1"]);
});

test("runStop with kill sends SIGKILL", () => {
  const { io, signalled } = fakeHostIo({ s1: { pid: 7 } });
  runStop(io, "s1", true);
  assert.deepEqual(signalled, [[7, "SIGKILL"]]);
});

test("runStop on an unknown session reports no recorded host and signals nothing", () => {
  const { io, signalled, removed } = fakeHostIo({});
  assert.ok(runStop(io, "ghost", false).includes("No running host"));
  assert.equal(signalled.length, 0);
  assert.equal(removed.length, 0);
});

test("runStop on a dead-process record cleans up the stale record without signalling", () => {
  const { io, signalled, removed } = fakeHostIo({ s1: { pid: 9 } }, () => false);
  assert.ok(runStop(io, "s1", false).includes("already gone"));
  assert.equal(signalled.length, 0, "no signal to a dead/unrelated pid");
  assert.deepEqual(removed, ["s1"], "the stale record is cleaned up");
});

test("expandHome expands a leading ~ against home and leaves absolute paths alone", () => {
  assert.equal(expandHome("~/dev/trevor", "/Users/kevin"), "/Users/kevin/dev/trevor");
  assert.equal(expandHome("~", "/Users/kevin"), "/Users/kevin");
  assert.equal(expandHome("/abs/path", "/Users/kevin"), "/abs/path");
  assert.equal(expandHome("relative", "/Users/kevin"), "relative", "a non-~ path is untouched");
});

test("resolveOpenTarget resolves a known session to its expanded workspace root", () => {
  const list = [
    summary({ sessionId: "s1", workspace: "~/dev/trevor" }),
    summary({ sessionId: "s2", workspace: "~/dev/other" }),
  ];
  assert.deepEqual(resolveOpenTarget(list, "s1", "/Users/kevin"), {
    sessionId: "s1",
    root: "/Users/kevin/dev/trevor",
  });
});

test("resolveOpenTarget falls back to cwd when workspace is null", () => {
  const list = [summary({ sessionId: "s1", workspace: null, cwd: "~/dev/x" })];
  assert.deepEqual(resolveOpenTarget(list, "s1", "/home/u"), {
    sessionId: "s1",
    root: "/home/u/dev/x",
  });
});

test("resolveOpenTarget refuses an archived session and points to unarchive (D-094 M2)", () => {
  const list = [summary({ sessionId: "filed", workspace: "~/dev/trevor", archived: true })];
  const result = resolveOpenTarget(list, "filed", "/Users/kevin");
  assert.ok("error" in result, "an archived session is not openable directly");
  assert.ok(result.error.includes("archived"), "the error names the archived state");
  assert.ok(
    result.error.includes("trevor unarchive filed"),
    "the error points to the unarchive command",
  );
});

test("resolveOpenTarget reports a missing id, an unknown session, and a session with no workspace", () => {
  const list = [summary({ sessionId: "s1" })];
  assert.ok("error" in resolveOpenTarget(list, "", "/h"), "empty id is a usage error");
  const unknown = resolveOpenTarget(list, "ghost", "/h");
  assert.ok("error" in unknown && unknown.error.includes("ghost"));
  assert.ok(
    "error" in unknown && unknown.error.includes("trevor list"),
    "points to the list command",
  );
  const noRoot = resolveOpenTarget(
    [summary({ sessionId: "x", workspace: null, cwd: null })],
    "x",
    "/h",
  );
  assert.ok("error" in noRoot && noRoot.error.includes("no recorded workspace"));
});
