import assert from "node:assert/strict";
import { lucidArtifactRef } from "@belay/session";
import { fireEvent, render, screen } from "@testing-library/react";
import { test } from "vitest";
import { LucidArtifactCard } from "./lucid-artifact-card";

const artifact = lucidArtifactRef({
  htmlHash: "a".repeat(64),
  size: 0,
  meta: {
    lucidId: "roadmap",
    version: 2,
    provenance: "agent",
    reviewStatus: "open",
    title: "Roadmap",
  },
});

test("renders the Lucid card and opens the artifact in the panel (not a new tab)", () => {
  let opened: string | null = null;
  render(
    <LucidArtifactCard
      title="Roadmap"
      version={2}
      artifact={artifact}
      onOpenArtifact={(a) => (opened = a.hash)}
    />,
  );
  assert.ok(screen.getByText("Roadmap"));
  assert.ok(screen.getByText(/Lucid artifact · v2/));
  fireEvent.click(screen.getByRole("button", { name: /open/i }));
  assert.equal(opened, "a".repeat(64));
});

test("the open button is disabled with no open handler (Storybook-only default)", () => {
  render(<LucidArtifactCard title="T" version={1} artifact={artifact} />);
  assert.equal((screen.getByRole("button", { name: /open/i }) as HTMLButtonElement).disabled, true);
});
