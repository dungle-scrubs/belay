import { expect, test } from "@playwright/test";
import { seedFileIndex, storeTransport } from "./lane-b-fixtures";

/**
 * Lane B EZE (plan 30 M5): the REAL app against the hermetic store, with a workspace file index seeded
 * as a host would answer it. Drives the whole `@`-file-mention flow on the live DOM - type `@`,
 * fuzzy-find a file, insert the mention, submit the prompt - and verifies the mention text lands in the
 * transcript. Settles via role/value assertions (Playwright auto-waits; no sleeps).
 */
test("type @, fuzzy-find a file, insert the mention, submit, and see it in the transcript", async ({
  page,
}) => {
  const transport = storeTransport();
  const sessionId = `mention-${test.info().workerIndex}-${Date.now()}`;
  await seedFileIndex(transport, sessionId, [
    "apps/web/src/app.tsx",
    "apps/web/src/hooks/use-composer.ts",
    "packages/session/src/protocol.ts",
  ]);

  await page.goto(`/?session=${sessionId}`);

  const composer = page.getByRole("textbox");
  await composer.click();
  await composer.pressSequentially("@use");

  // The picker fuzzy-finds the composer hook; after the debounce settles it is the only match.
  const menu = page.getByRole("listbox", { name: "Workspace files" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option")).toHaveCount(1);
  await expect(menu.getByRole("option")).toContainText("use-composer.ts");

  // Enter picks the highlighted file, inserting a visible workspace-relative mention.
  await composer.press("Enter");
  await expect(composer).toHaveValue("@apps/web/src/hooks/use-composer.ts ");
  await expect(menu).toBeHidden();

  // A second Enter (menu closed) submits; the mention rides the prompt as ordinary visible text.
  await composer.press("Enter");
  await expect(page.locator("[data-transcript-scroll]")).toContainText(
    "@apps/web/src/hooks/use-composer.ts",
  );
});
