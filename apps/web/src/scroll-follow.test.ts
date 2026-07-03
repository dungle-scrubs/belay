import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { AT_BOTTOM_TOLERANCE, liveEdgeOffset, type ScrollGeometry } from "./scroll";
import { createScrollFollowController } from "./scroll-follow";

/**
 * The follow controller (plan 12.2 M2): the pure pin state machine + write arbitration. No DOM, no
 * React - geometry is passed in as plain numbers, exactly like `scroll.ts`. These tests pin the
 * behaviors the three Lane B regressions need: a direction-based SYNCHRONOUS unpin, a re-pin that only
 * a genuine user arrival at the bottom (any input kind), the jump button, or submit triggers, and a
 * write arbiter that denies every follow-class write while unpinned.
 */

// A geometry helper: a tall column whose distance-from-bottom is `fromBottom` px.
function geo(fromBottom: number, { scrollHeight = 4000, clientHeight = 800 } = {}): ScrollGeometry {
  return { scrollHeight, clientHeight, scrollTop: scrollHeight - clientHeight - fromBottom };
}

describe("scroll-follow: unpin is direction-based and synchronous", () => {
  test("an upward gesture unpins immediately, even while sitting at the live edge", () => {
    const c = createScrollFollowController();
    assert.equal(c.isPinned(), true);

    // No position precondition: pinned at the very bottom, a single upward gesture unpins in the same
    // call - no `atBottomOf` gate, no intent window to wait out.
    c.gesture("up");

    assert.equal(c.isPinned(), false);
    assert.equal(c.snapshot().lastReason, "user-gesture-up");
  });

  test("an upward gesture unpins regardless of how close to the bottom the viewport is", () => {
    for (const fromBottom of [0, 1, AT_BOTTOM_TOLERANCE - 1, AT_BOTTOM_TOLERANCE + 5, 500]) {
      const c = createScrollFollowController();
      c.scrolled(geo(fromBottom));
      c.gesture("up");
      assert.equal(c.isPinned(), false, `should unpin at fromBottom=${fromBottom}`);
    }
  });

  test("an unattributed upward scroll unpins (scrollbar drag / keyboard, no wheel gesture)", () => {
    const c = createScrollFollowController();
    c.scrolled(geo(0)); // at the bottom, pinned
    assert.equal(c.isPinned(), true);

    // A scroll event that moved the viewport UP out of the band with no approved write behind it: unpin.
    c.scrolled(geo(300));

    assert.equal(c.isPinned(), false);
    assert.equal(c.snapshot().lastReason, "unattributed-scroll-up");
  });

  test("a downward gesture does not, by itself, re-pin", () => {
    const c = createScrollFollowController();
    c.gesture("up");
    assert.equal(c.isPinned(), false);

    c.gesture("down");

    assert.equal(c.isPinned(), false);
  });
});

describe("scroll-follow: re-pin only on a genuine bottom arrival, jump, or submit", () => {
  test("a wheel user scrolling back down re-pins on arrival within the tolerance band", () => {
    const c = createScrollFollowController();
    c.gesture("up");
    c.scrolled(geo(500));
    assert.equal(c.isPinned(), false);

    // The user scrolls back down and arrives within the tolerance band -> re-pin.
    c.scrolled(geo(300));
    assert.equal(c.isPinned(), false, "still above the band");
    c.scrolled(geo(AT_BOTTOM_TOLERANCE - 5));
    assert.equal(c.isPinned(), true);
    assert.equal(c.snapshot().lastReason, "user-return-to-bottom");
  });

  test("a gesture-less downward arrival at the bottom re-pins (keyboard End, scrollbar drag)", () => {
    const c = createScrollFollowController();
    c.scrolled(geo(0)); // baseline at the bottom
    c.scrolled(geo(500)); // keyboard PageUp: unattributed upward scroll -> unpin
    assert.equal(c.isPinned(), false);

    // Keyboard End: a genuine downward scroll event landing in the band, with NO wheel gesture at all.
    c.scrolled(geo(0));

    assert.equal(c.isPinned(), true);
    assert.equal(c.snapshot().lastReason, "user-return-to-bottom");
  });

  test("a residual follow self-write landing at the bottom does NOT re-pin", () => {
    const c = createScrollFollowController();
    c.scrolled(geo(0)); // pinned at the bottom
    const edge = geo(0);
    // A follow write approved while pinned, targeting the live edge. It requests an offset slightly
    // past the current edge (the column re-measured in flight), so its landing will CLAMP - the exact
    // offset match would miss, but the edge-targeting recognition must not.
    const decision = c.requestWrite("follow", {
      writer: "append",
      resultingOffset: liveEdgeOffset(edge) + 40,
      scrollHeight: edge.scrollHeight,
      clientHeight: edge.clientHeight,
    });
    assert.equal(decision.allowed, true);

    // The user flicks up before the write's scroll event lands: unpin, write still in flight.
    c.gesture("up");
    assert.equal(c.isPinned(), false);

    // The write's event lands clamped at the real edge - a self-write, NOT a deliberate user return.
    c.scrolled(geo(0));
    assert.equal(c.isPinned(), false, "a residual follow landing must not re-pin");

    // But the bookkeeping is consumed: a later GENUINE arrival at the bottom still re-pins.
    c.scrolled(geo(400));
    c.scrolled(geo(10));
    assert.equal(c.isPinned(), true);
  });

  test("upward transit through the bottom band never re-pins", () => {
    const c = createScrollFollowController();
    // Start pinned at the bottom, then an upward gesture + a scroll event carrying the upward motion
    // THROUGH the tolerance band. Landing a scroll sample inside the band while moving UP must not
    // re-pin (this is the momentum-transit re-pin the old code had).
    c.gesture("up");
    c.scrolled(geo(AT_BOTTOM_TOLERANCE - 5)); // inside the band, but arrived by moving up
    assert.equal(c.isPinned(), false);
    c.scrolled(geo(400)); // continues up, out of the band
    assert.equal(c.isPinned(), false);
  });

  test("a downward scroll that stops short of the band does not re-pin", () => {
    const c = createScrollFollowController();
    c.gesture("up");
    c.scrolled(geo(500));
    c.scrolled(geo(AT_BOTTOM_TOLERANCE + 10)); // moved down, but stopped above the band
    assert.equal(c.isPinned(), false);
  });

  test("jump and submit re-pin unconditionally, from anywhere", () => {
    for (const reason of ["jump", "submit"] as const) {
      const c = createScrollFollowController();
      c.gesture("up");
      c.scrolled(geo(2000)); // far up the transcript
      assert.equal(c.isPinned(), false);

      c.repin(reason);

      assert.equal(c.isPinned(), true, `${reason} should re-pin`);
      assert.equal(c.snapshot().lastReason, reason);
    }
  });
});

describe("scroll-follow: write arbitration + self-write bookkeeping", () => {
  test("while pinned, follow writes are allowed", () => {
    const c = createScrollFollowController();
    assert.equal(c.isPinned(), true);
    assert.equal(c.requestWrite("follow", { writer: "append" }).allowed, true);
  });

  test("while unpinned, every follow write is denied and anchor-compensation is allowed", () => {
    const c = createScrollFollowController();
    c.gesture("up");
    assert.equal(c.isPinned(), false);

    for (const writer of ["append", "settle-loop", "total-size", "pinned-change"] as const) {
      const decision = c.requestWrite("follow", { writer });
      assert.equal(
        decision.allowed,
        false,
        `follow write from ${writer} must be denied while unpinned`,
      );
      assert.equal(decision.reason, "unpinned-denies-follow");
    }
    assert.equal(c.requestWrite("anchor-compensation", { writer: "virtualizer" }).allowed, true);

    // The last denial is inspectable in the debug snapshot (names the writer that tried to tug).
    const denied = c.snapshot().lastDeniedWrite;
    assert.equal(denied?.writeClass, "follow");
    assert.equal(denied?.writer, "pinned-change");
  });

  test("while unpinned, an anchor-compensation that would land at the live edge is denied", () => {
    const c = createScrollFollowController();
    c.gesture("up");
    const edge = geo(0);

    // The lagging `anchorTo` can request an edge-landing "correction" for one render after a
    // synchronous unpin - a follow in disguise; the controller (not the component) rejects it.
    const denied = c.requestWrite("anchor-compensation", {
      writer: "virtualizer",
      resultingOffset: liveEdgeOffset(edge),
      scrollHeight: edge.scrollHeight,
      clientHeight: edge.clientHeight,
    });
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, "anchor-denied-lands-at-edge");

    // A mid-column compensation with the same geometry is still allowed (the real anchor case).
    const allowed = c.requestWrite("anchor-compensation", {
      writer: "virtualizer",
      resultingOffset: 1000,
      scrollHeight: edge.scrollHeight,
      clientHeight: edge.clientHeight,
    });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.reason, "anchor-allowed");
  });

  test("an approved write is recognized on the next scroll event, not misread as user movement", () => {
    const c = createScrollFollowController();
    c.gesture("up");
    c.scrolled(geo(400)); // reading up the transcript, unpinned
    assert.equal(c.isPinned(), false);

    // An above-viewport re-measure grew the content, so anchor-compensation nudges scrollTop DOWN to
    // keep the same rows visible. That approved write resolves to a known offset...
    const compensated = geo(360); // scrollTop increased by 40 (moved "down") to compensate
    const decision = c.requestWrite("anchor-compensation", {
      writer: "virtualizer",
      resultingOffset: compensated.scrollTop,
    });
    assert.equal(decision.allowed, true);

    // ...so when that scroll event lands it is consumed as a self-write: NOT misread as the user
    // returning to the bottom (no re-pin) and NOT misread as an upward gesture (no state churn).
    c.scrolled(compensated);
    assert.equal(c.isPinned(), false, "a compensated self-write must not re-pin");
  });

  test("a controller-approved follow write to the bottom is not misread as a user return", () => {
    const c = createScrollFollowController();
    // Pinned, following the live edge: the approved follow write lands the viewport at the bottom.
    const atEdge = geo(0);
    assert.equal(
      c.requestWrite("follow", { writer: "append", resultingOffset: atEdge.scrollTop }).allowed,
      true,
    );
    c.scrolled(atEdge);
    assert.equal(c.isPinned(), true);
    // A subsequent genuine upward gesture still unpins (bookkeeping did not wedge the state).
    c.gesture("up");
    assert.equal(c.isPinned(), false);
  });

  test("an unmatched user scroll flushes stale ledger entries (they cannot swallow later scrolls)", () => {
    const c = createScrollFollowController();
    c.scrolled(geo(0)); // baseline at the bottom
    // An approved write whose event never lands at its recorded offset (superseded in flight).
    c.requestWrite("follow", { writer: "append", resultingOffset: geo(100).scrollTop });

    // The user scrolls up: unmatched -> the ledger is flushed and the viewport unpins.
    c.scrolled(geo(300));
    assert.equal(c.isPinned(), false);

    // A later user scroll landing EXACTLY on the stale offset is genuine movement, not a self-write:
    // it is mid-column (no re-pin), and the subsequent arrival at the bottom re-pins normally.
    c.scrolled(geo(100));
    assert.equal(c.isPinned(), false, "a flushed offset must not swallow a genuine scroll");
    c.scrolled(geo(10));
    assert.equal(c.isPinned(), true);
  });
});

describe("scroll-follow: subscription notifies on pin-state change", () => {
  test("subscribers fire when the pin state flips, and stop after unsubscribe", () => {
    const c = createScrollFollowController();
    let calls = 0;
    const unsub = c.subscribe(() => {
      calls += 1;
    });

    c.gesture("up"); // pinned -> unpinned
    assert.equal(calls, 1);
    c.gesture("up"); // already unpinned: no change, no notify
    assert.equal(calls, 1);
    c.repin("jump"); // unpinned -> pinned
    assert.equal(calls, 2);

    unsub();
    c.gesture("up");
    assert.equal(calls, 2, "no notifications after unsubscribe");
  });
});
