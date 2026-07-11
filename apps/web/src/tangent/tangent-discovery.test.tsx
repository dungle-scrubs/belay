import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SessionSummary } from "@trevor/session";
import { sessionSummary } from "@trevor/test-kit";
import { test, vi } from "vitest";
import { TangentDiscovery } from "./tangent-discovery";

/**
 * M7 parent tangent discovery: a takeover listing a parent's tangents with source-quote snippets,
 * recency, status, and open actions - separate from the ordinary sidebar/resume. Runs in the `web` project.
 */

const NOW = Date.parse("2026-07-04T12:00:00.000Z");

function tangent(over: Partial<SessionSummary> = {}): SessionSummary {
  return sessionSummary({
    sessionId: "t1",
    updatedAt: "2026-07-04T11:30:00.000Z",
    tangentOf: {
      parentSessionId: "parent",
      sourceMessageId: "e2",
      quote: "blobs are content-addressed by sha256",
      label: null,
      createdAt: "2026-07-04T11:00:00.000Z",
    },
    ...over,
  });
}

test("lists each tangent with its source-quote snippet and recency", () => {
  render(<TangentDiscovery tangents={[tangent()]} nowMs={NOW} onOpen={vi.fn()} onBack={vi.fn()} />);
  assert.ok(screen.getByText(/blobs are content-addressed by sha256/));
  assert.ok(screen.getByText("30m ago"));
});

test("opening a tangent row hands its summary back to onOpen (M7)", () => {
  const onOpen = vi.fn();
  const row = tangent();
  render(<TangentDiscovery tangents={[row]} nowMs={NOW} onOpen={onOpen} onBack={vi.fn()} />);
  fireEvent.click(screen.getByText(/blobs are content-addressed/));
  assert.equal(onOpen.mock.calls[0]?.[0], row);
});

test("shows an empty state when the session has no tangents", () => {
  render(<TangentDiscovery tangents={[]} nowMs={NOW} onOpen={vi.fn()} onBack={vi.fn()} />);
  assert.ok(screen.getByText("No tangents yet."));
});

test("the back arrow returns to chat", () => {
  const onBack = vi.fn();
  render(<TangentDiscovery tangents={[tangent()]} nowMs={NOW} onOpen={vi.fn()} onBack={onBack} />);
  fireEvent.click(screen.getByLabelText("Back to conversation"));
  assert.equal(onBack.mock.calls.length, 1);
});

test("renders a running tangent's live status", () => {
  render(
    <TangentDiscovery
      tangents={[tangent({ activity: "running" })]}
      nowMs={NOW}
      onOpen={vi.fn()}
      onBack={vi.fn()}
    />,
  );
  assert.ok(screen.getByText("running"));
});
