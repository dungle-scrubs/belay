import { fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState } from "react";
import { describe, expect, test, vi } from "vitest";
import type { Composer } from "@/hooks/use-composer";
import { PromptInput } from "./prompt-input";

type ComposerInput = Pick<
  Composer,
  | "draft"
  | "setDraft"
  | "attachments"
  | "uploading"
  | "uploadError"
  | "setUploadError"
  | "inputRef"
  | "fileInputRef"
  | "onPickFiles"
  | "onPaste"
  | "handleKeyDown"
  | "removeAttachment"
>;

function PromptHarness(props: { readonly initialDraft: string; readonly vimEnabled?: boolean }) {
  const { initialDraft, vimEnabled = false } = props;
  const [draft, setDraft] = useState(initialDraft);
  const composer: ComposerInput = {
    attachments: [],
    draft,
    fileInputRef: createRef<HTMLInputElement>(),
    handleKeyDown: vi.fn(),
    inputRef: createRef<HTMLTextAreaElement>(),
    onPaste: vi.fn(),
    onPickFiles: vi.fn(),
    removeAttachment: vi.fn(),
    setDraft,
    setUploadError: vi.fn(),
    uploadError: null,
    uploading: 0,
  };

  return (
    <PromptInput
      composer={composer}
      disabled={false}
      onKeyDown={vi.fn()}
      onSubmit={(event) => event.preventDefault()}
      placeholder="message"
      vimEnabled={vimEnabled}
    />
  );
}

describe("PromptInput Vim caret shape (06.1)", () => {
  test("block caret in normal and visual mode, thin default in insert", () => {
    render(<PromptHarness initialDraft="hello" vimEnabled />);
    const input = screen.getByRole("textbox");

    // A freshly rendered Vim composer is in insert: the native thin bar, no block class.
    expect(input.className).not.toContain("[caret-shape:block]");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByLabelText("Vim mode: normal")).toBeTruthy();
    expect(input.className).toContain("[caret-shape:block]");

    fireEvent.keyDown(input, { key: "v" });
    expect(screen.getByLabelText("Vim mode: visual")).toBeTruthy();
    expect(input.className).toContain("[caret-shape:block]");

    // v again leaves visual -> normal; i -> insert restores the thin bar.
    fireEvent.keyDown(input, { key: "v" });
    fireEvent.keyDown(input, { key: "i" });
    expect(screen.getByLabelText("Vim mode: insert")).toBeTruthy();
    expect(input.className).not.toContain("[caret-shape:block]");
  });

  test("with Vim disabled the caret class never appears", () => {
    render(<PromptHarness initialDraft="hello" />);
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.className).not.toContain("caret-shape");
  });
});

describe("PromptInput Vim mode indicator alignment (06.1)", () => {
  test("the pill sits immediately right of the composer controls, with no flex-1 spacer", () => {
    render(<PromptHarness initialDraft="" vimEnabled />);
    const pill = screen.getByRole("status");
    const prev = pill.previousElementSibling;

    expect(prev?.getAttribute("aria-label")).toBe("Attach files (or paste / drag-drop)");
    expect(prev?.className ?? "").not.toContain("flex-1");
  });
});

describe("PromptInput loop helper wiring", () => {
  test("renders the loop helper for an active /loop line only", () => {
    render(<PromptHarness initialDraft={'/loop max 5 do "run tests"'} />);
    const input = screen.getByRole("textbox");

    expect(screen.getByText("ready")).toBeTruthy();
    expect(screen.getByText("run tests")).toBeTruthy();

    fireEvent.change(input, { target: { value: "ordinary prompt" } });
    expect(screen.queryByText("ready")).toBeNull();
  });

  test("updates the helper as the line changes and unmounts outside /loop", () => {
    render(<PromptHarness initialDraft="/loop max 5" />);
    const input = screen.getByRole("textbox");

    expect(screen.getByText("incomplete")).toBeTruthy();
    expect(screen.getByText(/add do/)).toBeTruthy();

    fireEvent.change(input, { target: { value: '/loop max 5 do "run tests"' } });
    expect(screen.getByText("ready")).toBeTruthy();

    fireEvent.change(input, { target: { value: "plain text" } });
    expect(screen.queryByText("ready")).toBeNull();
  });

  test("renders parser token roles for /loop syntax highlighting", () => {
    render(<PromptHarness initialDraft={'/loop max 5 do "run tests"'} />);

    expect(screen.getByTestId("loop-token-command").textContent).toBe("/loop");
    expect(screen.getAllByTestId("loop-token-keyword").map((node) => node.textContent)).toEqual([
      "max",
      "do",
    ]);
    expect(screen.getAllByTestId("loop-token-value").map((node) => node.textContent)).toEqual([
      "5",
      '"run tests"',
    ]);
  });
});
