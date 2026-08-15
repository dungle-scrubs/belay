import { loopPresentation } from "@belay/session";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { LoopHelper } from "./loop-helper";

/**
 * The loop helper (plan 17, M7): a pure render over the SHARED parser's presentation view-model
 * (`loopPresentation` from @belay/session), so the web preview and the host validate the same grammar.
 * No web-local parsing or validation.
 */

test("renders a ready builder from the shared parser preview", () => {
  render(<LoopHelper view={loopPresentation('/loop max 5 do "run tests"')} />);
  // The parsed field values render, driven entirely by the shared parser.
  expect(screen.getByText("run tests")).toBeTruthy();
  expect(screen.getByText("5")).toBeTruthy();
  expect(screen.getByText("ready")).toBeTruthy();
});

test("surfaces missing fields and value diagnostics from the shared parser", () => {
  render(<LoopHelper view={loopPresentation("/loop max 5")} />);
  // No action yet: the builder is incomplete and hints how to add one.
  expect(screen.getByText("incomplete")).toBeTruthy();
  expect(screen.getByText(/add do/)).toBeTruthy();
});

test("shows a value diagnostic (invalid max) from the shared parser", () => {
  render(<LoopHelper view={loopPresentation('/loop max 0 do "x"')} />);
  expect(screen.getByText(/positive whole number/)).toBeTruthy();
  expect(screen.getByText("incomplete")).toBeTruthy();
});

test("renders the keyword strip so the guide reflects used vs available keywords", () => {
  render(<LoopHelper view={loopPresentation('/loop background do "x"')} />);
  // The keyword chips come from the shared descriptor; `max` is one of them.
  expect(screen.getByText("max")).toBeTruthy();
});
