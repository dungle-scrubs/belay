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
  // Assert the FIELD is announced and correctly shaped (the plan-51 wiring rides host.online) - NOT its
  // exact value, which reads the host's REAL config home (`<TREVOR_HOME>/model-prefs.json`) and so varies
  // by machine. The empty-load + parse behavior is unit-tested hermetically in model-prefs-store.test.ts
  // (via its injectable `read`); here we only pin that the shaped preference is on the wire.
  assert.ok(decoded.modelPrefs, "modelPrefs rides host.online");
  assert.ok("default" in decoded.modelPrefs, "carries a default field");
  assert.ok(Array.isArray(decoded.modelPrefs.pinned), "carries a pinned array");
});
