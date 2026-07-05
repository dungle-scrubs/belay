import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { CommandArgPreview } from "@/derive";
import { CommandPreview } from "./command-preview";

const preview: CommandArgPreview = {
  command: "/fix",
  argumentHint: "<issue>",
  text: "Fix issue #123 for 123",
  missing: [],
};

describe("CommandPreview", () => {
  test("renders the command, its hint, and the expanded substitution text", () => {
    render(<CommandPreview preview={preview} />);
    expect(screen.getByText("/fix")).toBeTruthy();
    expect(screen.getByText("<issue>")).toBeTruthy();
    expect(screen.getByText("Fix issue #123 for 123")).toBeTruthy();
  });

  test("surfaces a waiting-on cue for placeholders with no arg yet", () => {
    render(<CommandPreview preview={{ ...preview, text: "Fix issue # for ", missing: ["$0"] }} />);
    expect(screen.getByText(/waiting on \$0/)).toBeTruthy();
  });

  test("omits the waiting-on row once every placeholder is filled", () => {
    render(<CommandPreview preview={preview} />);
    expect(screen.queryByText(/waiting on/)).toBeNull();
  });
});
