import assert from "node:assert/strict";
import type { InternetSnapshot } from "@belay/session";
import { fireEvent, render } from "@testing-library/react";
import { test } from "vitest";
import { InternetStatus } from "./internet-status";

/**
 * D-060 M3/M5: the advisory. Pins the cloud-vs-local offline difference (warn vs neutral, never
 * blocking), the host-disconnected + checking + stale + browser-mismatch states, the refresh action,
 * and the accessibility label - all advisory, none of it changing model selection.
 */

const NOW = Date.parse("2026-06-26T12:00:00.000Z");

function snap(over: Partial<InternetSnapshot>): InternetSnapshot {
  return {
    status: "online",
    checking: false,
    checkedAt: new Date(NOW - 5_000).toISOString(),
    error: null,
    targetClass: "dns+https",
    ...over,
  };
}

test("offline + a cloud model warns (without disabling anything)", () => {
  const { container } = render(
    <InternetStatus
      snapshot={snap({ status: "offline" })}
      modelKind="cloud"
      hostPresent
      nowMs={NOW}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("cloud turns may fail"), "a cloud-model offline state warns");
  assert.equal(
    container.querySelector("button[disabled]"),
    null,
    "nothing is disabled by the advisory",
  );
});

test("offline + a local model stays neutral (local turns unaffected)", () => {
  const { container } = render(
    <InternetStatus
      snapshot={snap({ status: "offline" })}
      modelKind="local"
      hostPresent
      nowMs={NOW}
    />,
  );
  assert.ok((container.textContent ?? "").includes("local model unaffected"));
});

test("host disconnected shows a distinct state, not an internet verdict", () => {
  const { container } = render(
    <InternetStatus
      snapshot={snap({ status: "unknown" })}
      modelKind="cloud"
      hostPresent={false}
      nowMs={NOW}
    />,
  );
  assert.ok((container.textContent ?? "").includes("host disconnected"));
});

test("checking shows a spinner state", () => {
  const { container } = render(
    <InternetStatus
      snapshot={snap({ status: "unknown", checking: true })}
      modelKind="cloud"
      hostPresent
      nowMs={NOW}
    />,
  );
  assert.ok((container.textContent ?? "").toLowerCase().includes("checking"));
  assert.ok(container.querySelector(".animate-spin"), "a spinner shows while checking");
});

test("a stale snapshot shows its age", () => {
  const { container } = render(
    <InternetStatus
      snapshot={snap({ status: "online", checkedAt: new Date(NOW - 120_000).toISOString() })}
      modelKind="cloud"
      hostPresent
      nowMs={NOW}
    />,
  );
  assert.ok((container.textContent ?? "").includes("ago"), "the stale age is shown");
});

test("browser navigator.onLine mismatch is a debug hint, not the status", () => {
  const { container } = render(
    <InternetStatus
      snapshot={snap({ status: "online" })}
      modelKind="cloud"
      hostPresent
      browserOnline={false}
      nowMs={NOW}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("internet online"), "the host probe is the source of truth");
  assert.ok(text.includes("browser offline"), "the browser mismatch shows as a hint");
});

test("the refresh action fires onRefresh and is labelled", () => {
  let refreshed = 0;
  const { getByLabelText } = render(
    <InternetStatus
      snapshot={snap({ status: "offline" })}
      modelKind="cloud"
      hostPresent
      nowMs={NOW}
      onRefresh={() => {
        refreshed += 1;
      }}
    />,
  );
  fireEvent.click(getByLabelText("refresh internet status"));
  assert.equal(refreshed, 1);
});

test("exposes an internet-status accessibility label", () => {
  const { container } = render(
    <InternetStatus snapshot={snap({})} modelKind="cloud" hostPresent nowMs={NOW} />,
  );
  assert.ok(container.querySelector('[aria-label="internet status"]'));
});
