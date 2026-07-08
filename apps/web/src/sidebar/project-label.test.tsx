import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, test } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectLabel } from "./project-label";

function renderWithTooltip(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

/**
 * Plan 58 M7: the shared project-label rendering used by both the sidebar project row and the
 * archive browser row. Renders the display name inline (truncated); the full path shows in a rich
 * Radix tooltip on hover (not inline), so it never clips or pushes content out of bounds.
 */

describe("ProjectLabel", () => {
  test("renders the display name", () => {
    const { getByText } = renderWithTooltip(
      <ProjectLabel displayName="trevor" displayPath="/Users/kevin/dev/trevor" />,
    );
    expect(getByText("trevor")).toBeTruthy();
  });

  test("does NOT render the path inline (it shows in the tooltip instead)", () => {
    const { queryByText, container } = renderWithTooltip(
      <ProjectLabel displayName="trevor" displayPath="/Users/kevin/dev/trevor" />,
    );
    // The path is not rendered inline anywhere in the container (it's in the Radix portal).
    expect(queryByText("/Users/kevin/dev/trevor")).toBeNull();
    expect(container.textContent).toBe("trevor");
  });

  test("omits the tooltip when the path is the same as the name", () => {
    const { container } = renderWithTooltip(<ProjectLabel displayName="app" displayPath="app" />);
    expect(container.textContent).toBe("app");
  });

  test("renders the name only when path is null (no crash)", () => {
    const { getByText, container } = renderWithTooltip(
      <ProjectLabel displayName="ghost" displayPath={null} />,
    );
    expect(getByText("ghost")).toBeTruthy();
    expect(container.textContent).toBe("ghost");
  });

  test("applies the injected className to the root span", () => {
    const { container } = renderWithTooltip(
      <ProjectLabel displayName="trevor" displayPath="/dev/trevor" className="text-ui" />,
    );
    expect(container.firstChild).toBeTruthy();
    expect((container.firstChild as HTMLElement).className).toContain("text-ui");
  });
});
