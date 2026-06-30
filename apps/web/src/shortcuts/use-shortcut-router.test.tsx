import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import { test } from "vitest";
import { isEditableTarget, type ShortcutRouterOptions, useShortcutRouter } from "./router";

/**
 * M2: the router hook on a real window. A matched shortcut fires its handler and is preventDefault'd;
 * an overlay suppresses global shortcuts; submit needs the composer focused; a focus guard recognizes
 * editable targets. (Tests run under jsdom, which reports navigator.platform = "" -> Ctrl is `Mod`.)
 */

function Harness(opts: ShortcutRouterOptions) {
  useShortcutRouter(opts);
  return <textarea data-testid="composer" />;
}

/** jsdom is non-mac (platform ""), so `Mod` = Ctrl here. */
function press(key: string, over: KeyboardEventInit = {}) {
  return fireEvent.keyDown(window, { key, ctrlKey: true, ...over });
}

test("a matched global shortcut fires its handler and is preventDefault'd", () => {
  const calls: string[] = [];
  render(
    <Harness overlayOpen={false} handlers={{ "command-palette": () => calls.push("palette") }} />,
  );
  const dispatched = press("k");
  assert.deepEqual(calls, ["palette"]);
  assert.equal(dispatched, false, "the event was preventDefault'd (fireEvent returns false)");
});

test("an open overlay suppresses global shortcuts (the palette handler does not fire)", () => {
  const calls: string[] = [];
  render(
    <Harness overlayOpen={true} handlers={{ "command-palette": () => calls.push("palette") }} />,
  );
  press("k");
  assert.deepEqual(calls, [], "behind an overlay, Mod+K is not routed");
});

test("submit fires only while an editable field is focused", () => {
  const calls: string[] = [];
  const { getByTestId } = render(
    <Harness overlayOpen={false} handlers={{ submit: () => calls.push("submit") }} />,
  );
  press("Enter");
  assert.deepEqual(calls, [], "no composer focus -> no submit");
  (getByTestId("composer") as HTMLTextAreaElement).focus();
  press("Enter");
  assert.deepEqual(calls, ["submit"], "focused composer -> submit");
});

test("a matched shortcut with no registered handler is a no-op (no crash)", () => {
  render(<Harness overlayOpen={false} handlers={{}} />);
  assert.doesNotThrow(() => press("\\"));
});

test("Mod+\\ toggles the sidebar and Mod+Shift+\\ toggles the panel (Shift is exact, no overlap)", () => {
  const calls: string[] = [];
  render(
    <Harness
      overlayOpen={false}
      handlers={{
        "toggle-sidebar": () => calls.push("sidebar"),
        "toggle-panel": () => calls.push("panel"),
      }}
    />,
  );
  press("\\");
  assert.deepEqual(calls, ["sidebar"], "Mod+\\ -> sidebar only");
  press("\\", { shiftKey: true });
  assert.deepEqual(calls, ["sidebar", "panel"], "Mod+Shift+\\ -> panel only (not also sidebar)");
});

test("Mod+. routes to stop; a bare '.' does not (no text/Vim interference)", () => {
  const calls: string[] = [];
  render(<Harness overlayOpen={false} handlers={{ stop: () => calls.push("stop") }} />);
  // A bare '.' is ordinary text (or a Vim key) - it must NOT trigger the stop binding.
  fireEvent.keyDown(window, { key: "." });
  assert.deepEqual(calls, [], "a bare '.' is left to the focused surface");
  press(".");
  assert.deepEqual(calls, ["stop"], "Mod+. is the deliberate stop");
});

test("Mod+. stop is suppressed behind a frontmost overlay", () => {
  const calls: string[] = [];
  render(<Harness overlayOpen={true} handlers={{ stop: () => calls.push("stop") }} />);
  press(".");
  assert.deepEqual(calls, [], "an open overlay owns the keys; stop does not fire behind it");
});

test("the panel toggles are suppressed behind a frontmost overlay", () => {
  const calls: string[] = [];
  render(
    <Harness
      overlayOpen={true}
      handlers={{
        "toggle-sidebar": () => calls.push("sidebar"),
        "toggle-panel": () => calls.push("panel"),
      }}
    />,
  );
  press("\\");
  press("\\", { shiftKey: true });
  assert.deepEqual(calls, [], "an open overlay owns the keys; panel toggles do not fire");
});

test("Escape is forwarded to onEscape (its precedence lives in the App's escapeAction)", () => {
  const calls: KeyboardEvent[] = [];
  render(<Harness overlayOpen={false} handlers={{}} onEscape={(e) => calls.push(e)} />);
  fireEvent.keyDown(window, { key: "Escape" });
  assert.equal(calls.length, 1);
});

test("Escape is forwarded even while an overlay is open (the router does not double-gate it)", () => {
  // escapeAction owns the modalOpen guard; the router must still deliver Escape so that decision runs.
  const calls: KeyboardEvent[] = [];
  render(
    <Harness overlayOpen={true} handlers={{}} onEscape={() => calls.push({} as KeyboardEvent)} />,
  );
  fireEvent.keyDown(window, { key: "Escape" });
  assert.equal(calls.length, 1);
});

test("an Escape a surface consumed with stopPropagation never reaches onEscape", () => {
  const calls: KeyboardEvent[] = [];
  const { getByTestId } = render(
    <Harness overlayOpen={false} handlers={{}} onEscape={() => calls.push({} as KeyboardEvent)} />,
  );
  // A child (the Vim composer / a Dialog) stops the event before it bubbles to the router's window
  // listener; dispatching on the child models that.
  const composer = getByTestId("composer");
  composer.addEventListener("keydown", (e) => e.stopPropagation());
  fireEvent.keyDown(composer, { key: "Escape" });
  assert.equal(calls.length, 0, "stopPropagation at the surface suppressed the global Escape");
});

test("isEditableTarget recognizes input/textarea/contenteditable, not a div", () => {
  const ta = document.createElement("textarea");
  const div = document.createElement("div");
  div.contentEditable = "true";
  assert.equal(isEditableTarget(ta), true);
  assert.equal(isEditableTarget(div), true);
  assert.equal(isEditableTarget(document.createElement("span")), false);
  assert.equal(isEditableTarget(null), false);
});
