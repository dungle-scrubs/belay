import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { PLAYWRIGHT_IMAGE } from "../tests/browser/shared";

/**
 * Plan 09.2 M0: a config guard (not a browser test - reads the workflow file) that fails if the browser
 * lane stops running inside the pinned Playwright container on ubuntu. Container-rendered screenshots are
 * what make the committed baselines match CI (D-002); dropping the container would silently flake every
 * story, so this keeps it self-guarding inside `pnpm test`.
 */

const ci = readFileSync(
  fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url)),
  "utf8",
);

/** The `browser:` job block, from its header to the next top-level job (2-space indent) or EOF. */
function browserJob(): string {
  const start = ci.indexOf("\n  browser:");
  assert.notEqual(start, -1, "ci.yml must define a `browser` job");
  const rest = ci.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}\w[\w-]*:/u);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test("the browser lane runs in the pinned Playwright container on ubuntu-latest", () => {
  const job = browserJob();
  assert.match(job, /runs-on: ubuntu-latest/u, "the browser job runs on ubuntu-latest");
  assert.ok(
    job.includes(PLAYWRIGHT_IMAGE),
    `the browser job must run inside the pinned container ${PLAYWRIGHT_IMAGE} (D-002)`,
  );
});

test("the browser job runs Lane A (Storybook visual regression) as a required per-PR pass", () => {
  const job = browserJob();
  assert.match(job, /build-storybook/u, "it builds the static Storybook first");
  assert.match(job, /test-storybook/u, "it runs the Storybook visual-regression lane");
});

test("the browser job uploads diff/trace artifacts on failure so a regression is eyeballable", () => {
  const job = browserJob();
  assert.match(job, /if:\s*failure\(\)/u, "an on-failure artifact upload step exists");
  assert.match(job, /upload-artifact/u);
});

// The image tag can't be imported into YAML/bash, so every place that re-spells it is guarded here
// against drifting from the PLAYWRIGHT_IMAGE source of truth. (container.sh holds it for all 3 baseline
// scripts, so one assertion covers them.)
test.each([
  "../.github/workflows/nightly-perf.yml",
  "../tests/browser/container.sh",
])("%s pins the same Playwright container as PLAYWRIGHT_IMAGE (D-002)", (rel) => {
  const contents = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  assert.ok(
    contents.includes(PLAYWRIGHT_IMAGE),
    `${rel} must pin ${PLAYWRIGHT_IMAGE} (keep it in sync with tests/browser/shared.ts)`,
  );
});
