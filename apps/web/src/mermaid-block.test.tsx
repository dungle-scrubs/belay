import assert from "node:assert/strict";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, test, vi } from "vitest";
import {
  createMermaidRenderConfig,
  createMermaidThemeVariables,
  MermaidBlock,
  type MermaidRender,
} from "./mermaid-block";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const tokenName of [
    "--background",
    "--border",
    "--foreground",
    "--muted-foreground",
    "--smui-surface-1",
    "--smui-surface-2",
  ]) {
    document.documentElement.style.removeProperty(tokenName);
  }
});

const validSvg = '<svg role="img" aria-label="Flow"><g><text>Rendered flow</text></g></svg>';

test("resolves Mermaid theme tokens to concrete colors", () => {
  const root = document.documentElement;
  root.style.setProperty("--background", "213 16% 12%");
  root.style.setProperty("--border", "217 17% 28%");
  root.style.setProperty("--foreground", "213 27% 80%");
  root.style.setProperty("--muted-foreground", "213 14% 60%");
  root.style.setProperty("--smui-surface-1", "217 16% 15.5%");
  root.style.setProperty("--smui-surface-2", "216 15% 19%");

  const themeVariables = createMermaidThemeVariables();

  assert.equal(themeVariables.noteBkgColor, "#292f38");
  assert.equal(themeVariables.fontSize, "13px");
  assert.equal(themeVariables.primaryColor, "#21262e");
  assert.equal(themeVariables.primaryTextColor, "#becbda");
  assert.ok(
    Object.entries(themeVariables)
      .filter(([name]) => name !== "fontSize")
      .every(([, color]) => /^#[\da-f]{6}$/.test(color)),
  );
});

test("configures Mermaid flowcharts with SVG labels", () => {
  const config = createMermaidRenderConfig();

  assert.equal(config.flowchart.inheritDir, true);
  assert.equal(config.flowchart.wrappingWidth, 190);
  assert.equal(config.fontSize, 13);
  assert.equal(config.htmlLabels, false);
  assert.equal(config.securityLevel, "strict");
});

test("renders a loading state before the diagram renderer resolves", async () => {
  let resolveRender: ((svg: string) => void) | undefined;
  const renderDiagram = vi.fn<MermaidRender>(
    () =>
      new Promise((resolve) => {
        resolveRender = resolve;
      }),
  );

  render(
    <MermaidBlock
      source={`graph TD
  A-->B`}
      renderDiagram={renderDiagram}
    />,
  );

  assert.ok(screen.getByText("Rendering diagram..."));
  await waitFor(() => assert.equal(renderDiagram.mock.calls.length, 1));
  resolveRender?.(validSvg);
  assert.ok(await screen.findByText("Rendered flow"));
});

test("renders sanitized Mermaid SVG output with a locked renderer", async () => {
  const renderDiagram = vi.fn<MermaidRender>().mockResolvedValue(validSvg);

  const { container } = render(
    <MermaidBlock
      source={`graph TD
  A-->B`}
      renderDiagram={renderDiagram}
    />,
  );

  await screen.findByText("Rendered flow");
  assert.equal(
    renderDiagram.mock.calls[0]?.[1],
    `graph TD
  A-->B`,
  );
  assert.ok(container.querySelector(".trevor-mermaid__svg svg"));
});

test("falls back to readable source when Mermaid reports a syntax error", async () => {
  const renderDiagram = vi
    .fn<MermaidRender>()
    .mockRejectedValue(new Error("Parse error on line 2"));

  render(
    <MermaidBlock
      source={`graph TD
  A-->`}
      renderDiagram={renderDiagram}
    />,
  );

  assert.ok(await screen.findByText("Mermaid could not render this diagram."));
  assert.ok(screen.getByText("Parse error on line 2"));
  assert.equal(
    screen.getByTestId("mermaid-source").textContent,
    `graph TD
  A-->`,
  );
});

test("falls back to source when the Mermaid library is unavailable", async () => {
  const renderDiagram = vi.fn<MermaidRender>().mockRejectedValue(new Error("mermaid unavailable"));

  render(
    <MermaidBlock
      source={`sequenceDiagram
  A->>B: hi`}
      renderDiagram={renderDiagram}
    />,
  );

  assert.ok(await screen.findByText("Mermaid could not render this diagram."));
  assert.ok(screen.getByText("mermaid unavailable"));
  assert.equal(
    screen.getByTestId("mermaid-source").textContent,
    `sequenceDiagram
  A->>B: hi`,
  );
});

test("copies the raw diagram source from the copy-source control", async () => {
  const writeText = vi.fn();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const renderDiagram = vi.fn<MermaidRender>().mockResolvedValue(validSvg);

  render(
    <MermaidBlock
      source={`stateDiagram-v2
  [*] --> Ready`}
      renderDiagram={renderDiagram}
    />,
  );

  await screen.findByText("Rendered flow");
  fireEvent.click(screen.getByLabelText("Copy Mermaid source"));

  assert.equal(
    writeText.mock.calls[0]?.[0],
    `stateDiagram-v2
  [*] --> Ready`,
  );
});

test("rerendering replaces the prior SVG instead of duplicating nodes", async () => {
  const renderDiagram = vi
    .fn<MermaidRender>()
    .mockResolvedValueOnce("<svg><text>First</text></svg>")
    .mockResolvedValueOnce("<svg><text>Second</text></svg>");

  const { container, rerender } = render(
    <MermaidBlock
      source={`graph TD
  A-->B`}
      renderDiagram={renderDiagram}
    />,
  );
  assert.ok(await screen.findByText("First"));

  rerender(
    <MermaidBlock
      source={`graph TD
  B-->C`}
      renderDiagram={renderDiagram}
    />,
  );

  assert.ok(await screen.findByText("Second"));
  assert.equal(container.querySelectorAll(".trevor-mermaid__svg svg").length, 1);
  assert.equal(screen.queryByText("First"), null);
});

test("debounces rapidly changing Mermaid source so streaming text does not thrash the renderer", async () => {
  vi.useFakeTimers();
  const renderDiagram = vi.fn<MermaidRender>().mockResolvedValue(validSvg);

  const { rerender } = render(
    <MermaidBlock
      source={`flowchart TB
  A -->`}
      renderDiagram={renderDiagram}
    />,
  );

  await act(async () => {
    vi.advanceTimersByTime(200);
  });
  rerender(
    <MermaidBlock
      source={`flowchart TB
  A --> B`}
      renderDiagram={renderDiagram}
    />,
  );
  await act(async () => {
    vi.advanceTimersByTime(200);
  });
  rerender(
    <MermaidBlock
      source={`flowchart TB
  A --> B
  B --> C`}
      renderDiagram={renderDiagram}
    />,
  );

  await act(async () => {
    vi.advanceTimersByTime(349);
  });
  assert.equal(renderDiagram.mock.calls.length, 0);

  await act(async () => {
    vi.advanceTimersByTime(1);
  });

  assert.equal(renderDiagram.mock.calls.length, 1);
  assert.equal(
    renderDiagram.mock.calls[0]?.[1],
    `flowchart TB
  A --> B
  B --> C`,
  );
});

test("opens rendered Mermaid SVG in a fullscreen zoom viewer", async () => {
  const renderDiagram = vi.fn<MermaidRender>().mockResolvedValue(validSvg);

  render(
    <MermaidBlock
      source={`graph TD
  A-->B`}
      renderDiagram={renderDiagram}
    />,
  );

  await screen.findByText("Rendered flow");
  fireEvent.click(screen.getByLabelText("Open Mermaid diagram fullscreen"));

  assert.ok(screen.getByRole("dialog", { name: "Mermaid diagram fullscreen viewer" }));
  assert.ok(screen.getByLabelText("Zoom fullscreen Mermaid diagram in"));

  fireEvent.keyDown(document, { key: "Escape" });
  assert.equal(screen.queryByRole("dialog", { name: "Mermaid diagram fullscreen viewer" }), null);

  fireEvent.click(screen.getByLabelText("Open Mermaid diagram fullscreen"));
  assert.ok(screen.getByRole("dialog", { name: "Mermaid diagram fullscreen viewer" }));

  fireEvent.click(screen.getByLabelText("Close Mermaid fullscreen viewer"));
  assert.equal(screen.queryByRole("dialog", { name: "Mermaid diagram fullscreen viewer" }), null);
});

test("reduced-motion users still get a static rendered diagram", async () => {
  window.matchMedia = vi.fn().mockReturnValue({
    addEventListener: vi.fn(),
    matches: true,
    media: "(prefers-reduced-motion: reduce)",
    removeEventListener: vi.fn(),
  });
  const renderDiagram = vi.fn<MermaidRender>().mockResolvedValue(validSvg);

  render(
    <MermaidBlock
      source={`classDiagram
  class User`}
      renderDiagram={renderDiagram}
    />,
  );

  await waitFor(() => assert.equal(renderDiagram.mock.calls.length, 1));
  assert.ok(screen.getByText("Rendered flow"));
});
