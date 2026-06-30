import assert from "node:assert/strict";
import { render, screen } from "@testing-library/react";
import { test, vi } from "vitest";
import { SHORTCUTS } from "@/shortcuts/registry";
import { ShortcutsHelp } from "./shortcuts-help";

/**
 * M6: the shortcuts-help overlay lists every registered binding with a platform-formatted chord, and is
 * closed when not open. (Opening on Mod+/ + suppressing behind-surface shortcuts are the router's job.)
 */

test("lists every registered shortcut with its label and mac chord", () => {
  render(<ShortcutsHelp open onOpenChange={vi.fn()} mac={true} />);
  for (const s of SHORTCUTS) {
    assert.ok(screen.getByText(s.label), `${s.label} is listed`);
  }
  assert.ok(screen.getByText("⌘K"), "the palette chord is mac-formatted");
});

test("renders Ctrl chords on non-mac", () => {
  render(<ShortcutsHelp open onOpenChange={vi.fn()} mac={false} />);
  assert.ok(screen.getByText("Ctrl+K"));
});

test("renders nothing when closed", () => {
  render(<ShortcutsHelp open={false} onOpenChange={vi.fn()} mac={true} />);
  assert.equal(screen.queryByText("Keyboard shortcuts"), null);
});
