import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import { test } from "vitest";
import { parseChord } from "./keys";
import { SHORTCUTS, type ShortcutId } from "./registry";
import { useShortcutRouter } from "./router";

/**
 * M9 (the jsdom-representable slice of the browser/OS matrix): every registered binding, when the
 * router owns it, both routes to its handler AND is `preventDefault`ed (so the browser default never
 * also fires) - and Escape, which the router only forwards, is NOT preventDefaulted by the router (its
 * owner decides). The live cross-browser pass (Chrome/Arc/Firefox/Zen/Safari) is the deferred manual
 * EZE recorded in `apps/web/HOTKEYS.md`; jsdom is non-mac, so `Mod` = Ctrl here.
 */

function Harness({
  onEscape,
  handlers,
}: {
  readonly onEscape?: (e: KeyboardEvent) => void;
  readonly handlers: Partial<Record<ShortcutId, () => void>>;
}) {
  useShortcutRouter({ overlayOpen: false, handlers, onEscape });
  return <textarea data-testid="composer" />;
}

for (const spec of SHORTCUTS) {
  test(`${spec.id} (${spec.keys}) routes and is preventDefault'd when the router owns it`, () => {
    const calls: string[] = [];
    const { getByTestId, unmount } = render(
      <Harness handlers={{ [spec.id]: () => calls.push(spec.id) }} />,
    );
    // `submit` is composer-owned: it only routes while an editable field has focus.
    if (spec.id === "submit") {
      (getByTestId("composer") as HTMLTextAreaElement).focus();
    }
    const chord = parseChord(spec.keys);
    const notPrevented = fireEvent.keyDown(window, {
      key: chord.key,
      ctrlKey: chord.mod,
      shiftKey: chord.shift,
      altKey: chord.alt,
    });
    assert.deepEqual(calls, [spec.id], `${spec.id} routed to its handler`);
    assert.equal(
      notPrevented,
      false,
      `${spec.id} was preventDefault'd (browser default suppressed)`,
    );
    unmount();
  });
}

test("the router does not preventDefault Escape itself (its owner, onEscape, decides)", () => {
  render(<Harness handlers={{}} onEscape={() => {}} />);
  const notPrevented = fireEvent.keyDown(window, { key: "Escape" });
  assert.equal(notPrevented, true, "router forwards Escape without claiming the default");
});
