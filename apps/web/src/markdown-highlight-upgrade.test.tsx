import assert from "node:assert/strict";
import { render, waitFor } from "@testing-library/react";
import { test } from "vitest";
import { Markdown } from "./markdown";

// This file deliberately does NOT preload the highlight engine: it covers the Tier 5.2 upgrade path
// where a settled fence renders before the lazily-loaded hljs chunk arrives. It must stay in its own
// test file - any sibling test that warms the engine first would erase the plain-first window.
test("a settled fence rendered before the engine loads upgrades in place once it arrives", async () => {
  const { container } = render(<Markdown text={"```ts\nconst answer = 42;\n```"} />);

  // Mount render: the closed fence requests highlighting, which kicks off the engine load and
  // renders plain in the meantime - the text is fully visible, just untokenized.
  assert.equal(container.querySelector("code.hljs"), null, "renders plain while the chunk loads");
  assert.ok(container.querySelector("code.language-ts")?.textContent?.includes("const answer"));

  // Engine ready: the subscription re-renders Markdown and the memoized parse re-tokenizes.
  await waitFor(() => {
    assert.ok(container.querySelector("code.hljs.language-ts"), "block upgrades to hljs markup");
    assert.ok(container.querySelector("code.hljs [class^='hljs-']"));
  });
});
