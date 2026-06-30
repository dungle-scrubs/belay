import assert from "node:assert/strict";
import { test } from "vitest";
import { fitsAfterSwitch } from "./context-guard";

/**
 * Plan 09.1 M7: the larger->smaller context-fit guard. Only larger->smaller is guarded; smaller->larger,
 * equal, and unknown targets are always allowed. A larger->smaller switch that fits applies; one that
 * does not is refused with a user-visible reason (the loop leaves the provider unchanged).
 */

test("smaller->larger is always allowed (even a huge conversation)", () => {
  const d = fitsAfterSwitch({
    conversationTokens: 180_000,
    currentWindow: 200_000,
    targetWindow: 1_000_000,
  });
  assert.equal(d.fits, true);
  assert.equal(d.reason, undefined);
});

test("equal windows are allowed", () => {
  assert.equal(
    fitsAfterSwitch({ conversationTokens: 50_000, currentWindow: 128_000, targetWindow: 128_000 })
      .fits,
    true,
  );
});

test("larger->smaller that still fits is allowed", () => {
  const d = fitsAfterSwitch({
    conversationTokens: 10_000,
    currentWindow: 200_000,
    targetWindow: 32_000,
    replyHeadroom: 4_096,
  });
  assert.equal(d.fits, true);
});

test("larger->smaller that does NOT fit is refused with a reason", () => {
  const d = fitsAfterSwitch({
    conversationTokens: 7_000,
    currentWindow: 200_000,
    targetWindow: 8_000,
    replyHeadroom: 4_096,
  });
  assert.equal(d.fits, false, "7000 + 4096 reply headroom exceeds the 8000 target window");
  assert.match(d.reason ?? "", /8000-token context window/);
  assert.match(d.reason ?? "", /7000 tokens/);
});

test("an unknown target window cannot be guarded - allow (overflow recovery still backstops)", () => {
  assert.equal(
    fitsAfterSwitch({ conversationTokens: 999_999, currentWindow: 200_000, targetWindow: 0 }).fits,
    true,
  );
});

test("an unknown current window still checks fit against the target", () => {
  // currentWindow 0 (not yet measured): can't assert direction, so the raw fit check governs.
  assert.equal(
    fitsAfterSwitch({
      conversationTokens: 5_000,
      currentWindow: 0,
      targetWindow: 8_000,
      replyHeadroom: 1_000,
    }).fits,
    true,
  );
  assert.equal(
    fitsAfterSwitch({
      conversationTokens: 9_000,
      currentWindow: 0,
      targetWindow: 8_000,
      replyHeadroom: 1_000,
    }).fits,
    false,
  );
});
