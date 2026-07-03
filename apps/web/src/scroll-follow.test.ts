import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { AT_BOTTOM_TOLERANCE, type ScrollGeometry } from "./scroll";
import { createScrollFollowController } from "./scroll-follow";

/**
 * The follow controller (plan 12.2 M2): the pure pin state machine + write arbitration. No DOM, no
 * React - geometry is passed in as plain numbers, exactly like `scroll.ts`. These tests pin the
 * behaviors the three Lane B regressions need: a direction-based SYNCHRONOUS unpin, a re-pin that only
 * a deliberate return to the bottom (or jump/submit) triggers, and a write arbiter that denies every
 * follow-class write while unpinned.
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

  test("an unattributed scrollTop decrease unpins (scrollbar drag / keyboard, no wheel gesture)", () => {
    const c = createScrollFollowController();
    c.scrolled(geo(0)); // at the bottom, pinned
    assert.equal(c.isPinned(), true);

    // A scroll event that moved the viewport UP with no approved write behind it: unpin.
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

describe("scroll-follow: re-pin only on a deliberate return to the bottom, jump, or submit", () => {
  test("a downward user scroll that ends within the bottom tolerance re-pins", () => {
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

    for (const writer of ["append", "settle-loop", "total-size-growth", "pinned-raf"]) {
      const decision = c.requestWrite("follow", { writer });
      assert.equal(
        decision.allowed,
        false,
        `follow write from ${writer} must be denied while unpinned`,
      );
    }
    assert.equal(c.requestWrite("anchor-compensation", { writer: "measure" }).allowed, true);

    // The last denial is inspectable in the debug snapshot (names the writer that tried to tug).
    const denied = c.snapshot().lastDeniedWrite;
    assert.equal(denied?.writeClass, "follow");
    assert.equal(denied?.writer, "pinned-raf");
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
      writer: "anchor",
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
