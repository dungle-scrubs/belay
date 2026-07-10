import assert from "node:assert/strict";
import { render } from "@testing-library/react";
import { test } from "vitest";
import { DiffViewer } from "./diff-viewer";

/**
 * Plan 58.6.1 M3: render smoke test for the vendored assistant-ui `DiffViewer`. This is the
 * component that still reaches into `@assistant-ui/react-markdown` (the `SyntaxHighlighterProps`
 * type), so it is the surface most exposed to an assistant-ui version bump. The test asserts the
 * STRUCTURAL output (data-slots, per-line add/del typing, content) - not styling - so it survives a
 * pin bump: if an upstream change breaks the diff render, this fails at review time.
 */

const PATCH = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
 const keep = 0;
-const x = 1;
+const x = 2;
`;

test("58.6.1 M3: DiffViewer renders a patch as a structured diff (file, add + del lines)", () => {
  const { container } = render(<DiffViewer patch={PATCH} showHeader={false} />);

  assert.ok(
    container.querySelector('[data-slot="diff-viewer"]'),
    "the diff viewer root renders",
  );
  assert.ok(
    container.querySelector('[data-slot="diff-viewer-file"]'),
    "the file block renders",
  );

  const added = container.querySelector('[data-slot="diff-viewer-line"][data-type="add"]');
  const deleted = container.querySelector('[data-slot="diff-viewer-line"][data-type="del"]');
  assert.ok(added, "an added line is typed data-type=add");
  assert.ok(deleted, "a deleted line is typed data-type=del");
  assert.match(added?.textContent ?? "", /const x = 2;/, "the added content renders");
  assert.match(deleted?.textContent ?? "", /const x = 1;/, "the deleted content renders");
});

test("58.6.1 M3: DiffViewer renders a graceful fallback when no diff content is provided", () => {
  const { container } = render(<DiffViewer />);
  const root = container.querySelector('[data-slot="diff-viewer"]');
  assert.ok(root, "the viewer still renders a stable node");
  assert.match(root?.textContent ?? "", /No diff content/, "the empty state is explicit");
});
