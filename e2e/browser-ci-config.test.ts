import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { PLAYWRIGHT_IMAGE } from "../tests/browser/shared";

/**
 * Config guard (not a browser test - reads the workflow and script files) for the browser lane's
 * placement.
 *
 * The browser lane is LOCAL-ONLY and must never run on a cloud runner. Pinning the Playwright image tag
 * fixes the Playwright version but NOT the CPU architecture: the image is multi-arch, so it resolves to
 * arm64 on an Apple Silicon workstation and to amd64 on a GitHub runner. Font rasterization differs
 * between them, so container-rendered baselines are only comparable against runs on the same
 * architecture as the machine that wrote them. Running the lane in both places would diff arm64
 * baselines against amd64 renders and flake every story.
 *
 * The committed baselines are therefore generated and verified locally through
 * tests/browser/{update,check}-storybook-baselines.sh, which share the pinned image via container.sh.
 */

const workflowSource = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../.github/workflows/${name}`, import.meta.url)), "utf8");

test("no CI workflow runs Playwright on a cloud runner", () => {
  for (const name of ["ci.yml", "release.yml"]) {
    const contents = workflowSource(name);
    assert.ok(
      !/playwright/iu.test(contents),
      `${name} must not reference Playwright - the browser lane is local-only (arch-sensitive baselines)`,
    );
    assert.ok(
      !/test-storybook|test:e2e:browser/u.test(contents),
      `${name} must not run a browser lane step - run it locally instead`,
    );
  }
});

test("the CI workflow still runs the hermetic node/jsdom lanes", () => {
  const ci = workflowSource("ci.yml");
  for (const step of ["pnpm lint", "pnpm test:unit", "pnpm test:integration", "pnpm test:web"]) {
    assert.ok(ci.includes(step), `ci.yml must keep running \`${step}\``);
  }
});

test("the local baseline scripts pin the same Playwright container as PLAYWRIGHT_IMAGE", () => {
  // container.sh holds the image for all three baseline scripts, so one assertion covers them.
  const contents = readFileSync(
    fileURLToPath(new URL("../tests/browser/container.sh", import.meta.url)),
    "utf8",
  );
  assert.ok(
    contents.includes(PLAYWRIGHT_IMAGE),
    `container.sh must pin ${PLAYWRIGHT_IMAGE} (keep it in sync with tests/browser/shared.ts)`,
  );
});
