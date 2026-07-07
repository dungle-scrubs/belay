import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ProjectLabel } from "./project-label";

/**
 * Plan 58 M7 (RED): the shared project-label rendering used by both the sidebar project row and the
 * archive browser row. A small presentational helper that renders a project's display name and, when
 * it adds information, its display path - so the two surfaces never drift on how a project is named.
 */

describe("ProjectLabel", () => {
  test("renders the display name", () => {
    const { getByText } = render(
      <ProjectLabel displayName="trevor" displayPath="/Users/kevin/dev/trevor" />,
    );
    expect(getByText("trevor")).toBeTruthy();
  });

  test("renders the display path alongside the name when it differs from the name", () => {
    const { getByText } = render(
      <ProjectLabel displayName="trevor" displayPath="/Users/kevin/dev/trevor" />,
    );
    expect(getByText("/Users/kevin/dev/trevor")).toBeTruthy();
  });

  test("omits the path when it is the same as the name (a basename-only path adds no info)", () => {
    const { queryByText } = render(<ProjectLabel displayName="app" displayPath="app" />);
    expect(queryByText("app")).toBeTruthy();
    // Exactly one occurrence of "app": the name only, no duplicated path.
    expect(queryByText("app")?.parentElement?.textContent).toBe("app");
  });

  test("renders the path when it is null (no crash, name only)", () => {
    const { getByText, container } = render(
      <ProjectLabel displayName="ghost" displayPath={null} />,
    );
    expect(getByText("ghost")).toBeTruthy();
    expect(container.textContent).toBe("ghost");
  });

  test("applies the injected className to the root span", () => {
    const { container } = render(
      <ProjectLabel displayName="trevor" displayPath="/dev/trevor" className="text-ui" />,
    );
    expect(container.firstChild).toHaveProperty("className");
    expect((container.firstChild as HTMLElement).className).toContain("text-ui");
  });
});
