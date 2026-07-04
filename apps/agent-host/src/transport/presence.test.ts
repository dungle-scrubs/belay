import assert from "node:assert/strict";
import { decodeTrevorEvent, type TrevorEventInput, UNKNOWN_INTERNET } from "@trevor/session";
import { storedEvent } from "@trevor/test-kit";
import { test } from "vitest";
import { makePresence } from "./presence";

/**
 * Presence announces the host's live snapshot as `host.online`. This pins that the plan-51 model
 * preference rides that snapshot: `announceOnline()` reads the host store's cache and puts it on the wire
 * so the browser's default/favorites come from the host, not a per-browser blob. The store reads the real
 * config home (absent on the test box), so the announced preference is the empty `{ default, pinned }` -
 * the assertion is that the FIELD is present and shaped, i.e. the wiring exists.
 */

function capturingPresence() {
  const emitted: TrevorEventInput[] = [];
  const presence = makePresence({
    providers: {},
    commands: { specs: [] },
    debugMode: () => false,
    worktrees: { summaries: () => [] },
    internet: { current: () => UNKNOWN_INTERNET },
    catalog: () => ({ sources: [], catalogBySource: {} }),
    instanceId: "test-instance",
    emit: (event) => {
      emitted.push(event);
      return Promise.resolve();
    },
  });
  return { presence, emitted };
}

test("announceOnline puts the host model preference on host.online (plan 51)", () => {
  const { presence, emitted } = capturingPresence();
  presence.announceOnline();

  const online = emitted.find((e) => e.type === "host.online");
  assert.ok(online, "an host.online announcement was emitted");
  const decoded = decodeTrevorEvent(
    storedEvent(online, { sessionId: "s", seq: 1, producerId: "host" }),
  );
  assert.equal(decoded?.type, "host.online");
  if (decoded?.type !== "host.online") return;
  // The field is announced (read from the store cache) - empty on the test box (no model-prefs.json).
  assert.deepEqual(decoded.modelPrefs, { default: null, pinned: [] });
});
