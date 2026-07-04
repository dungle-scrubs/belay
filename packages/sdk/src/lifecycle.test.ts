import { PRODUCER_IDS } from "@trevor/session";
import { recordingTransport, sessionSummary } from "@trevor/test-kit";
import { describe, expect, it } from "vitest";
import { createTrevorClient } from "./client";
import { expandHome, resolveOpenTarget, selectSessions } from "./lifecycle";

const SESSION_URL = "http://127.0.0.1:17424";

describe("selectSessions (M6)", () => {
  const rows = [
    sessionSummary({ sessionId: "a", project: "x", updatedAt: "2026-01-01T00:00:00.000Z" }),
    sessionSummary({ sessionId: "b", project: "x", updatedAt: "2026-02-01T00:00:00.000Z" }),
    sessionSummary({ sessionId: "c", project: "y", updatedAt: "2026-03-01T00:00:00.000Z" }),
    sessionSummary({ sessionId: "d", project: "x", archived: true }),
    sessionSummary({ sessionId: "e", project: "x", deleted: true }),
  ];

  it("returns active project sessions newest-first, excluding archived and deleted", () => {
    expect(selectSessions(rows, "x", { archived: false }).map((s) => s.sessionId)).toEqual([
      "b",
      "a",
    ]);
  });

  it("returns archived project sessions with --archived", () => {
    expect(selectSessions(rows, "x", { archived: true }).map((s) => s.sessionId)).toEqual(["d"]);
  });

  it("lists all projects when project is null", () => {
    expect(selectSessions(rows, null, { archived: false }).map((s) => s.sessionId)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });
});

describe("resolveOpenTarget (M6)", () => {
  const rows = [
    sessionSummary({ sessionId: "ok", workspace: "~/dev/x" }),
    sessionSummary({ sessionId: "arch", archived: true }),
    sessionSummary({ sessionId: "del", deleted: true }),
    sessionSummary({ sessionId: "nowork", workspace: null, cwd: null }),
  ];
  const home = "/Users/me";

  it("resolves a live session to its expanded workspace root", () => {
    expect(resolveOpenTarget(rows, "ok", home)).toEqual({
      sessionId: "ok",
      root: "/Users/me/dev/x",
    });
  });

  it("refuses missing / archived / deleted / workspace-less sessions with a clear message", () => {
    expect(resolveOpenTarget(rows, "", home)).toMatchObject({
      error: expect.stringContaining("usage"),
    });
    expect(resolveOpenTarget(rows, "ghost", home)).toMatchObject({
      error: expect.stringContaining("No session"),
    });
    expect(resolveOpenTarget(rows, "arch", home)).toMatchObject({
      error: expect.stringContaining("archived"),
    });
    expect(resolveOpenTarget(rows, "del", home)).toMatchObject({
      error: expect.stringContaining("deleted"),
    });
    expect(resolveOpenTarget(rows, "nowork", home)).toMatchObject({
      error: expect.stringContaining("no recorded workspace"),
    });
  });
});

describe("expandHome (M6)", () => {
  it("expands a leading ~ against home, leaving absolute paths untouched", () => {
    expect(expandHome("~/dev/x", "/Users/me")).toBe("/Users/me/dev/x");
    expect(expandHome("~", "/Users/me")).toBe("/Users/me");
    expect(expandHome("/abs/path", "/Users/me")).toBe("/abs/path");
  });
});

describe("archive / unarchive / listSessions (M6)", () => {
  it("archive and unarchive publish the durable session.archived marker under the client producer", async () => {
    const rec = recordingTransport();
    const client = createTrevorClient({
      sessionUrl: SESSION_URL,
      producerId: PRODUCER_IDS.cli,
      transport: rec.transport,
    });
    await client.archive("s1");
    await client.unarchive("s1");
    expect(rec.publishedBy("s1")).toEqual([
      { type: "session.archived", producerId: PRODUCER_IDS.cli, payload: { archived: true } },
      { type: "session.archived", producerId: PRODUCER_IDS.cli, payload: { archived: false } },
    ]);
  });

  it("listSessions fetches the inventory and applies the project/active selection", async () => {
    const rec = recordingTransport();
    rec.setInventory([
      sessionSummary({ sessionId: "a", project: "x" }),
      sessionSummary({ sessionId: "b", project: "y" }),
    ]);
    const client = createTrevorClient({ sessionUrl: SESSION_URL, transport: rec.transport });
    const listed = await client.listSessions({ project: "x" });
    expect(listed.map((s) => s.sessionId)).toEqual(["a"]);
  });
});
