import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import { test } from "vitest";
import { BranchButton } from "./BranchButton";
import { LineageNavigator } from "./LineageNavigator";
import type { Lineage } from "./lineage";

const LINEAGE: Lineage = {
  ancestors: [
    { sessionId: "root", title: "root chat" },
    { sessionId: "mid", title: "mid chat", forkSeq: 3 },
  ],
  current: { sessionId: "leaf", title: "current chat", forkSeq: 6 },
  children: [{ sessionId: "kid", title: "a branch", forkSeq: 9 }],
};

test("LineageNavigator renders ancestors, the current node, and children", () => {
  const { getByText, container } = render(
    <LineageNavigator lineage={LINEAGE} onNavigate={() => {}} />,
  );
  getByText("root chat");
  getByText("mid chat");
  getByText("current chat");
  getByText("a branch");
  // The current node is marked aria-current and is not a button (not navigable to itself).
  const current = container.querySelector('[aria-current="true"]');
  assert.ok(current, "the current node is aria-current");
  assert.equal(current?.tagName, "DIV");
});

test("LineageNavigator navigates to a clicked ancestor/child but never the current node", () => {
  const navigated: string[] = [];
  const { getByText } = render(
    <LineageNavigator lineage={LINEAGE} onNavigate={(id) => navigated.push(id)} />,
  );
  fireEvent.click(getByText("root chat"));
  fireEvent.click(getByText("a branch"));
  // Clicking the current node's text does nothing (it is a div, not a button).
  fireEvent.click(getByText("current chat"));
  assert.deepEqual(navigated, ["root", "kid"]);
});

test("LineageNavigator shows a missing parent as a non-navigable stub", () => {
  const navigated: string[] = [];
  const lineage: Lineage = {
    ancestors: [{ sessionId: "gone", title: "gone", missing: true }],
    current: { sessionId: "leaf", title: "current chat" },
    children: [],
  };
  const { getByText } = render(
    <LineageNavigator lineage={lineage} onNavigate={(id) => navigated.push(id)} />,
  );
  fireEvent.click(getByText("gone"));
  assert.deepEqual(navigated, [], "a missing parent stub is not navigable");
});

test("BranchButton emits its fork point on click", () => {
  const points: number[] = [];
  const { getByRole } = render(<BranchButton forkSeq={12} onBranch={(seq) => points.push(seq)} />);
  fireEvent.click(getByRole("button"));
  assert.deepEqual(points, [12]);
});
