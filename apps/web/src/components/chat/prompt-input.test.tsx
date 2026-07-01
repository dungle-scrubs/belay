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

function PromptHarness(props: { readonly initialDraft: string }) {
  const { initialDraft } = props;
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
    />
  );
}

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
