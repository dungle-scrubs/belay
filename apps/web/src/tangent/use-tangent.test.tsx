import assert from "node:assert/strict";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PublishInput, TangentAnchorSeed } from "@trevor/session";
import { recordingTransport, sessionSummary } from "@trevor/test-kit";
import { test, vi } from "vitest";
import { createTangentSessionWith } from "@/session/use-session";
import { useTangent } from "./use-tangent";

/**
 * M5 create/open tangent sessions. `createTangentSessionWith` seeds an ISOLATED session over the transport
 * (ensure + the tangentOf marker only, no parent copy); `useTangent` drives the takeover lifecycle:
 * optimistic open, session id fill-in, duplicate-click guard, missing source, creation error, and close.
 * Runs in the `web` jsdom project.
 */

const SELECTION = { text: "blobs are content-addressed by sha256", sourceMessageId: "parent-e2" };

test("createTangentSessionWith ensures a fresh tangent and publishes marker before parent wake-up", async () => {
  const rec = recordingTransport();
  const anchor: TangentAnchorSeed = {
    parentSessionId: "parent",
    sourceMessageId: "parent-e2",
    quote: "blobs are content-addressed",
    label: "why sha256?",
  };

  const tangentSessionId = await createTangentSessionWith(rec.transport, anchor);

  assert.ok(tangentSessionId.startsWith("tangent-"), "mints a tangent-prefixed id");
  assert.deepEqual(rec.ensured, [tangentSessionId], "creates the tangent session before writing");
  const published = rec.publishedBy(tangentSessionId);
  assert.equal(published.length, 1, "exactly one tangent seed event - the marker, no parent copy");
  assert.equal(published[0]?.type, "session.tangentOf");
  assert.equal(published[0]?.producerId, "trevor-web");
  assert.deepEqual(published[0]?.payload, {
    parentSessionId: "parent",
    sourceMessageId: "parent-e2",
    quote: "blobs are content-addressed",
    label: "why sha256?",
  });
  const wakeUp = rec.publishedBy("parent");
  assert.equal(wakeUp.length, 1, "the parent receives one wake-up after the tangent marker");
  assert.equal(wakeUp[0]?.type, "tangent.created");
  assert.deepEqual(wakeUp[0]?.payload, {
    tangentSessionId,
    sourceMessageId: "parent-e2",
  });
  assert.deepEqual(
    rec.published.map((e) => e.type),
    ["session.tangentOf", "tangent.created"],
    "the durable tangent marker is written before the parent wake-up",
  );
});

test("createTangentSessionWith still returns the tangent id if the parent wake-up publish fails", async () => {
  const rec = recordingTransport();
  const transport = {
    ...rec.transport,
    publishEvent: (sessionId: string, input: PublishInput) => {
      if (sessionId === "parent" && input.type === "tangent.created") {
        return Promise.reject(new Error("parent stream unavailable"));
      }
      return rec.transport.publishEvent(sessionId, input);
    },
  };

  const tangentSessionId = await createTangentSessionWith(transport, {
    parentSessionId: "parent",
    sourceMessageId: "parent-e2",
    quote: "blobs are content-addressed",
  });

  assert.ok(tangentSessionId.startsWith("tangent-"));
  assert.equal(rec.publishedBy(tangentSessionId)[0]?.type, "session.tangentOf");
  assert.equal(rec.publishedBy("parent").length, 0);
});

test("useTangent opens optimistically then fills in the session id when creation resolves", async () => {
  const create = vi.fn().mockResolvedValue("tangent-xyz");
  const { result } = renderHook(() => useTangent({ create }));

  act(() => result.current.open(SELECTION, "parent"));
  // Opens immediately with the anchor, session id pending.
  assert.deepEqual(
    { ...result.current.active, tangentSessionId: result.current.active?.tangentSessionId },
    {
      tangentSessionId: null,
      parentSessionId: "parent",
      sourceMessageId: "parent-e2",
      quote: SELECTION.text,
    },
  );
  assert.equal(create.mock.calls[0]?.[0].parentSessionId, "parent");

  await waitFor(() => assert.equal(result.current.active?.tangentSessionId, "tangent-xyz"));
});

test("useTangent guards a duplicate click - one create, one takeover", async () => {
  const create = vi.fn().mockResolvedValue("tangent-1");
  const { result } = renderHook(() => useTangent({ create }));

  act(() => {
    result.current.open(SELECTION, "parent");
    result.current.open(SELECTION, "parent");
  });
  assert.equal(create.mock.calls.length, 1, "the second open is ignored while one is active");
});

test("useTangent rejects a selection with no source message", () => {
  const create = vi.fn();
  const { result } = renderHook(() => useTangent({ create }));

  act(() => result.current.open({ text: "x", sourceMessageId: "" }, "parent"));
  assert.equal(result.current.active, null);
  assert.equal(create.mock.calls.length, 0);
  assert.match(result.current.error ?? "", /no single source message/);
});

test("useTangent surfaces a creation failure in the takeover error state", async () => {
  const create = vi.fn().mockRejectedValue(new Error("store unreachable"));
  const { result } = renderHook(() => useTangent({ create }));

  act(() => result.current.open(SELECTION, "parent"));
  await waitFor(() => assert.equal(result.current.error, "store unreachable"));
  // The takeover stays open (with the seed) so the error is shown in place, not silently dropped.
  assert.equal(result.current.active?.tangentSessionId, null);
});

test("openExisting reopens a tangent from its inventory summary without creating a session (M7)", () => {
  const create = vi.fn();
  const { result } = renderHook(() => useTangent({ create }));
  const summary = sessionSummary({
    sessionId: "tangent-abc",
    tangentOf: {
      parentSessionId: "parent",
      sourceMessageId: "e2",
      quote: "blobs are content-addressed",
      label: null,
      createdAt: "2026-07-04T00:00:00.000Z",
    },
  });

  act(() => result.current.openExisting(summary));
  assert.deepEqual(result.current.active, {
    tangentSessionId: "tangent-abc",
    parentSessionId: "parent",
    sourceMessageId: "e2",
    quote: "blobs are content-addressed",
  });
  assert.equal(create.mock.calls.length, 0, "reopening never creates a new session");
});

test("close clears the tangent and re-enables opening another", async () => {
  const create = vi.fn().mockResolvedValue("tangent-1");
  const { result } = renderHook(() => useTangent({ create }));

  act(() => result.current.open(SELECTION, "parent"));
  act(() => result.current.close());
  assert.equal(result.current.active, null);

  act(() => result.current.open(SELECTION, "parent"));
  assert.ok(result.current.active, "opening works again after close");
  assert.equal(create.mock.calls.length, 2);
});
