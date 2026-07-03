import { act, fireEvent, render, screen } from "@testing-library/react";
import { type KeyboardEvent as ReactKeyboardEvent, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { activeMention } from "@/composer/active-mention";
import { useComposer } from "@/hooks/use-composer";
import { useFileMentionMenu } from "@/hooks/use-file-mention-menu";
import { useWorkspaceFileSearch, type WorkspaceFileIndex } from "@/hooks/use-workspace-file-search";
import { FileMentionMenu } from "./file-mention-menu";
import { PromptInput } from "./prompt-input";

/**
 * The live composer integration (M4): the real composer wired to the local search over a host-supplied
 * index, exactly as App does it - active-token query -> useWorkspaceFileSearch -> useFileMentionMenu ->
 * FileMentionMenu overlay. Drives loading / no-results / capped / keyboard + mouse pick / draft
 * preservation on the production components.
 */
const INDEX: WorkspaceFileIndex = {
  files: [{ path: "apps/web/src/app.tsx" }, { path: "apps/web/src/hooks/use-composer.ts" }],
  truncated: false,
  ready: true,
};

function LiveHarness({ index }: { readonly index: WorkspaceFileIndex }) {
  const composer = useComposer();
  const { draft, setDraft, inputRef } = composer;
  const [caret, setCaret] = useState(0);
  const search = useWorkspaceFileSearch(activeMention(draft, caret)?.query ?? null, index);
  const fileMenu = useFileMentionMenu({
    draft,
    caret,
    results: search.results,
    truncated: search.truncated,
    inputRef,
    setDraft,
    setCaret,
  });
  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    fileMenu.onMenuKeyDown(event);
  };
  return (
    <div>
      {fileMenu.menuOpen ? (
        <FileMentionMenu
          matches={fileMenu.matches}
          activeIndex={fileMenu.menuIndex}
          query={fileMenu.query ?? ""}
          truncated={fileMenu.truncated}
          loading={fileMenu.menuOpen && !index.ready}
          onPick={fileMenu.acceptFile}
        />
      ) : null}
      <PromptInput
        composer={composer}
        onSubmit={(event) => event.preventDefault()}
        onKeyDown={onInputKeyDown}
        onCaretChange={setCaret}
        disabled={false}
        placeholder="message"
        menuOpen={fileMenu.menuOpen}
      />
    </div>
  );
}

function typeInto(value: string, caret = value.length) {
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value, selectionStart: caret } });
  return input as HTMLTextAreaElement;
}

describe("live @-file-mention integration", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const settle = () => act(() => vi.advanceTimersByTime(120));

  test("shows a loading state until the host index is ready", () => {
    render(<LiveHarness index={{ files: [], truncated: false, ready: false }} />);
    typeInto("@app");
    settle();
    expect(screen.getByText(/loading workspace files/i)).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  test("shows a no-results state when the ready index has no match", () => {
    render(<LiveHarness index={INDEX} />);
    typeInto("@zzzznomatch");
    settle();
    expect(screen.getByText(/no matching files/i)).toBeTruthy();
  });

  test("reports truncation when the host index was capped", () => {
    render(<LiveHarness index={{ ...INDEX, truncated: true }} />);
    typeInto("@app");
    settle();
    expect(screen.getByText(/more exist/i)).toBeTruthy();
  });

  test("filters + ranks live results as the query narrows", () => {
    render(<LiveHarness index={INDEX} />);
    typeInto("@use");
    settle();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    // The basename text is split by the query-highlight span, so match on the option's content.
    expect(options[0]?.textContent).toContain("use-composer.ts");
  });

  test("keyboard pick inserts the mention and preserves surrounding draft text", () => {
    render(<LiveHarness index={INDEX} />);
    const input = typeInto("see @app here", 8);
    settle();
    expect(screen.getByRole("listbox", { name: "Workspace files" })).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("see @apps/web/src/app.tsx here");
  });

  test("mouse pick inserts the mention without losing composer focus", () => {
    render(<LiveHarness index={INDEX} />);
    const input = typeInto("@use");
    settle();
    const option = screen.getByRole("option");
    const notCancelled = fireEvent.mouseDown(option);
    // mousedown was prevented (focus stays in the textarea) and the pick replaced the token.
    expect(notCancelled).toBe(false);
    expect(input.value).toBe("@apps/web/src/hooks/use-composer.ts ");
  });
});
