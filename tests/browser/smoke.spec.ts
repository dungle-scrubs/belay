import { expect, test } from "@playwright/test";
import { BROWSER_VIEWPORT, DISABLE_ANIMATIONS_CSS } from "./shared";

/**
 * M0 smoke (plan 09.2): the shared Playwright foundation actually drives headless Chromium. This fails
 * until `@playwright/test` + a browser are installed and the config resolves - in CI it runs inside the
 * pinned `mcr.microsoft.com/playwright` container. It exercises only the shared pieces (viewport +
 * animation-freeze), no app boot, so it stays the cheapest signal that the browser lane is wired.
 */
test("headless chromium renders at the shared viewport with animations frozen", async ({
  page,
}) => {
  await page.addStyleTag({ content: DISABLE_ANIMATIONS_CSS });
  await page.setContent(
    `<main style="width:100vw;height:100vh"><h1 id="probe">browser lane ok</h1></main>`,
  );
  await expect(page.locator("#probe")).toHaveText("browser lane ok");

  const size = page.viewportSize();
  expect(size).toEqual(BROWSER_VIEWPORT);
});
