import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import { test, vi } from "vitest";
import { ShortcutsHelp } from "@/components/shortcuts-help/shortcuts-help";
import { formatChord } from "./keys";
import { SHORTCUTS, type ShortcutId } from "./registry";
import { useShortcutRouter } from "./router";

/**
 * M10: the regression net for the bug classes this plan exists to kill, plus the help<->ledger
 * completeness invariant. Behind-surface interaction, Vim Escape ordering, palette/modal leakage, and
 * stopPropagation suppression are covered in router/vim tests; here are the remaining classes -
 * text-field theft and stale handlers - and the "every binding is discoverable" guarantee.
 */

function Harness({
  overlayOpen,
  handlers,
}: {
  readonly overlayOpen: boolean;
  readonly handlers: Partial<Record<ShortcutId, () => void>>;
}) {
  useShortcutRouter({ overlayOpen, handlers });
  return <textarea data-testid="composer" />;
}

test("text-field theft: a bare key (no Mod) never routes to a shortcut", () => {
  const calls: string[] = [];
  const { getByTestId } = render(
    <Harness overlayOpen={false} handlers={{ "command-palette": () => calls.push("palette") }} />,
  );
  (getByTestId("composer") as HTMLTextAreaElement).focus();
  // Plain typing - 'k', '.', '\' - is left entirely to the focused field.
  fireEvent.keyDown(window, { key: "k" });
  fireEvent.keyDown(window, { key: "." });
  fireEvent.keyDown(window, { key: "\\" });
  assert.deepEqual(calls, [], "no bare key is mistaken for a Mod chord");
});

test("stale handlers: the live listener reflects the latest overlayOpen without re-registering", () => {
  const calls: string[] = [];
  const handlers = { "command-palette": () => calls.push("palette") };
  const { rerender } = render(<Harness overlayOpen={false} handlers={handlers} />);
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  assert.deepEqual(calls, ["palette"], "fires while no overlay is open");
  // Re-render with a now-open overlay: the same single listener must read the fresh value (ref), not a
  // stale closure, and suppress the chord.
  rerender(<Harness overlayOpen={true} handlers={handlers} />);
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  assert.deepEqual(
    calls,
    ["palette"],
    "suppressed after the overlay opens - no stale closure fired it",
  );
});

test("help <-> ledger completeness: every registered shortcut is shown in the help surface", () => {
  render(<ShortcutsHelp open onOpenChange={vi.fn()} mac={false} />);
  for (const spec of SHORTCUTS) {
    assert.ok(screen.getByText(spec.label), `${spec.id} label is discoverable in help`);
    assert.ok(screen.getByText(formatChord(spec.keys, false)), `${spec.id} chord is shown`);
  }
});
