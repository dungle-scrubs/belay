import { fireEvent, render, screen } from "@testing-library/react";
import type { CommandSpec, FileMatch } from "@trevor/session";
import { type KeyboardEvent as ReactKeyboardEvent, useState } from "react";
import { describe, expect, test } from "vitest";
import { useComposer } from "@/hooks/use-composer";
import { useFileMentionMenu } from "@/hooks/use-file-mention-menu";
import { useSlashMenu } from "@/hooks/use-slash-menu";
import { CommandMenu } from "./command-menu";
import { FileMentionMenu } from "./file-mention-menu";
import { PromptInput } from "./prompt-input";

/**
 * Wires the composer the way App + PanelHost do (useComposer + useSlashMenu + useFileMentionMenu +
 * the onInputKeyDown ordering + both overlays) so coexistence is exercised on the REAL components,
 * not a re-implementation. The submit branch (menu closed) increments a counter, standing in for
 * App's Enter-submit, so the ordering contract is asserted without jsdom form quirks.
 */
const COMMANDS: CommandSpec[] = [
  { name: "/clear", summary: "Start fresh" },
  { name: "/compact", summary: "Compact context" },
];

const FILES: FileMatch[] = [
  { path: "apps/web/src/app.tsx" },
  { path: "apps/web/src/hooks/use-composer.ts" },
  { path: "packages/session/src/protocol.ts" },
];

function ComposerHarness({ vimEnabled = false }: { readonly vimEnabled?: boolean }) {
  const composer = useComposer();
  const { draft, setDraft, inputRef } = composer;
  const [caret, setCaret] = useState(0);
  const [submits, setSubmits] = useState(0);
  const slashMenu = useSlashMenu({ draft, commandSpecs: COMMANDS, inputRef, setDraft });
  const fileMenu = useFileMentionMenu({
    draft,
    caret,
    results: FILES,
    inputRef,
    setDraft,
    setCaret,
  });
  const menuOpen = slashMenu.menuOpen || fileMenu.menuOpen;
  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMenu.onMenuKeyDown(event)) {
      return;
    }
    if (fileMenu.onMenuKeyDown(event)) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      setSubmits((n) => n + 1);
    }
  };
  return (
    <div>
      <output data-testid="submits">{submits}</output>
      {slashMenu.menuOpen ? (
        <CommandMenu
          matches={slashMenu.menuMatches}
          activeIndex={slashMenu.menuIndex}
          query={slashMenu.slashQuery ?? ""}
          onPick={slashMenu.acceptCommand}
        />
      ) : null}
      {fileMenu.menuOpen ? (
        <FileMentionMenu
          matches={fileMenu.matches}
          activeIndex={fileMenu.menuIndex}
          query={fileMenu.query ?? ""}
          truncated={fileMenu.truncated}
          onPick={fileMenu.acceptFile}
        />
      ) : null}
      <PromptInput
        composer={composer}
        onSubmit={(event) => event.preventDefault()}
        onKeyDown={onInputKeyDown}
        caret={caret}
        onCaretChange={setCaret}
        disabled={false}
        placeholder="message"
        vimEnabled={vimEnabled}
        menuOpen={menuOpen}
      />
    </div>
  );
}

function type(value: string) {
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value, selectionStart: value.length } });
  return input;
}

describe("composer @-mention coexistence", () => {
  test("typing @ opens the file menu; ArrowDown + Enter inserts the mention (no submit)", () => {
    render(<ComposerHarness />);
    const input = type("@app");
    expect(screen.getByRole("listbox", { name: "Workspace files" })).toBeTruthy();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect((input as HTMLTextAreaElement).value).toBe("@apps/web/src/hooks/use-composer.ts ");
    expect(screen.getByTestId("submits").textContent).toBe("0");
    // The trailing space closed the token, so the menu is gone.
    expect(screen.queryByRole("listbox", { name: "Workspace files" })).toBeNull();
  });

  test("Escape closes only the mention menu and leaves the draft intact", () => {
    render(<ComposerHarness />);
    const input = type("@app");
    expect(screen.getByRole("listbox", { name: "Workspace files" })).toBeTruthy();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("listbox", { name: "Workspace files" })).toBeNull();
    expect((input as HTMLTextAreaElement).value).toBe("@app");
    expect(screen.getByTestId("submits").textContent).toBe("0");
  });

  test("a leading / opens the slash menu, and the file menu stays closed", () => {
    render(<ComposerHarness />);
    type("/cle");
    expect(screen.getByRole("listbox", { name: "Slash commands" })).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: "Workspace files" })).toBeNull();
  });

  test("Enter submits with no menu open, but the open mention menu intercepts it", () => {
    render(<ComposerHarness />);
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("submits").textContent).toBe("1");

    type("@app");
    fireEvent.keyDown(input, { key: "Enter" });
    // Still 1: the mention menu owned Enter (picked a file) instead of submitting.
    expect(screen.getByTestId("submits").textContent).toBe("1");
    expect((input as HTMLTextAreaElement).value).toBe("@apps/web/src/app.tsx ");
  });

  test("Backspace is yielded to the composer (image-token deletion is unaffected)", () => {
    render(<ComposerHarness />);
    const input = type("@app");
    fireEvent.keyDown(input, { key: "Backspace" });
    // The menu did not steal Backspace: it stays open, nothing submitted, draft untouched by the menu.
    expect(screen.getByRole("listbox", { name: "Workspace files" })).toBeTruthy();
    expect(screen.getByTestId("submits").textContent).toBe("0");
  });

  test("the Vim layer is suspended while the mention menu owns keys (Escape closes the menu)", () => {
    render(<ComposerHarness vimEnabled />);
    const input = type("@app");
    // With Vim enabled but the mention menu open, Escape must reach the menu (Vim suspended), not
    // flip the composer into normal mode.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Workspace files" })).toBeNull();
  });
});
