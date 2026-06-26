import assert from "node:assert/strict";
import { render } from "@testing-library/react";
import type { RecallResult } from "@trevor/session";
import { test } from "vitest";
import type { ToolMessage as ToolMessageData } from "@/transcript";
import { SessionRecallResults } from "./session-recall";
import { ToolRenderer } from "./tool-message";

/**
 * D-044 M5: the Session-recall transcript surface. These pin that findings + cited source rows
 * render, that snippets are collapsed/truncated (so a long excerpt cannot blow the row), that the
 * activity + state notes show, that accessibility labels are present, and that the tool dispatch
 * routes `session_recall` here.
 */

const NOW = Date.parse("2026-06-26T12:00:00.000Z");

function result(over: Partial<RecallResult>): RecallResult {
  return {
    status: "ok",
    query: "which database did we choose",
    findings: [],
    sources: [],
    diagnostics: [],
    activity: {
      searchedSessions: 0,
      searchedFolds: 0,
      searchedRecords: 0,
      anchors: 0,
      neighborhoods: 0,
    },
    ...over,
  };
}

const HIT = result({
  findings: [{ summary: "You chose SQLite for the durable log [S1].", citations: ["sib#41"] }],
  sources: [
    {
      id: "sib#41",
      sessionId: "sib",
      sessionLabel: "set up the session store",
      origin: "sibling-session",
      seq: 41,
      range: { fromSeq: 41, toSeq: 41 },
      kind: "assistant",
      timestamp: new Date(NOW - 1000 * 60 * 60 * 26).toISOString(),
      excerpt: "we'll back the durable log with SQLite in WAL mode",
    },
  ],
  activity: {
    searchedSessions: 3,
    searchedFolds: 4,
    searchedRecords: 318,
    anchors: 1,
    neighborhoods: 1,
  },
});

test("renders distilled findings and a cited source row with provenance", () => {
  const { container } = render(<SessionRecallResults query={HIT.query} result={HIT} nowMs={NOW} />);
  const text = container.textContent ?? "";
  assert.ok(text.includes("You chose SQLite for the durable log"), "the finding renders");
  assert.ok(text.includes("set up the session store"), "the source session label renders");
  assert.ok(text.includes("S1"), "the source is numbered to match the [S1] citation");
  assert.ok(text.includes("3 sessions"), "the activity line shows sessions searched");
  assert.ok(text.includes("1d ago"), "the source carries a relative timestamp");
});

test("source excerpts are line-clamped so a long excerpt cannot blow the row", () => {
  const [src] = HIT.sources;
  assert.ok(src);
  const long = result({
    findings: HIT.findings,
    sources: [{ ...src, excerpt: "x ".repeat(400) }],
    activity: HIT.activity,
  });
  const { container } = render(
    <SessionRecallResults query={long.query} result={long} nowMs={NOW} />,
  );
  assert.ok(container.querySelector(".line-clamp-2"), "the excerpt uses a 2-line clamp");
});

test("exposes accessibility labels for the result, findings, and sources", () => {
  const { container } = render(<SessionRecallResults query={HIT.query} result={HIT} nowMs={NOW} />);
  assert.ok(container.querySelector('[aria-label="session recall result"]'));
  assert.ok(container.querySelector('[aria-label="recall findings"]'));
  assert.ok(container.querySelector('[aria-label="recall sources"]'));
});

test("shows a working indicator while still running", () => {
  const { container } = render(
    <SessionRecallResults query="q" result={null} status="running" nowMs={NOW} />,
  );
  assert.ok(
    (container.textContent ?? "").toLowerCase().includes("recalling"),
    "the recalling indicator shows",
  );
});

test("renders a neutral note for no_hits and unavailable", () => {
  const noHits = render(
    <SessionRecallResults query="q" result={result({ status: "no_hits" })} nowMs={NOW} />,
  );
  assert.ok((noHits.container.textContent ?? "").includes("No earlier project memory matched"));

  const unavailable = render(
    <SessionRecallResults query="q" result={result({ status: "unavailable" })} nowMs={NOW} />,
  );
  assert.ok(
    (unavailable.container.textContent ?? "").includes("No earlier project memory to search yet"),
  );
});

test("surfaces partial-search diagnostics without dropping the findings", () => {
  const partial = result({
    status: "partial",
    findings: HIT.findings,
    sources: HIT.sources,
    diagnostics: [
      { sessionId: "old", kind: "unreadable", detail: "socket closed before replay completed" },
    ],
    activity: HIT.activity,
  });
  const { container } = render(
    <SessionRecallResults query={partial.query} result={partial} nowMs={NOW} />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("Partial search"), "the partial-search warning shows");
  assert.ok(text.includes("socket closed"), "the diagnostic detail is visible");
  assert.ok(
    text.includes("You chose SQLite"),
    "the finding still renders alongside the diagnostic",
  );
});

test("renders an error state with the failure detail", () => {
  const errored = result({
    status: "error",
    diagnostics: [
      { sessionId: "", kind: "unreadable", detail: "reasoning pass failed: provider down" },
    ],
  });
  const { container } = render(
    <SessionRecallResults query={errored.query} result={errored} nowMs={NOW} />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("Recall failed"), "the error state renders");
  assert.ok(text.includes("reasoning pass failed"), "the failure detail is shown");
});

test("the tool dispatch routes session_recall to the recall surface", () => {
  const message: ToolMessageData = {
    kind: "tool",
    id: "t1",
    name: "session_recall",
    args: JSON.stringify({ query: "which database did we choose" }),
    result: JSON.stringify(HIT),
    done: true,
  };
  const { container } = render(<ToolRenderer message={message} onOpenPath={() => {}} />);
  const text = container.textContent ?? "";
  assert.ok(
    text.includes("You chose SQLite for the durable log"),
    "the recall finding renders via dispatch",
  );
  assert.ok(text.includes("set up the session store"), "the cited source renders via dispatch");
});
