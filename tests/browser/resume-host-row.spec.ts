import { expect, test } from "@playwright/test";
import { seedExchanges, storeTransport } from "./lane-b-fixtures";

test("offline session keeps transcript readable and shows bottom resume recovery row", async ({
  page,
}) => {
  const transport = storeTransport();
  const sessionId = `resume-row-${test.info().workerIndex}-${Date.now()}`;
  await seedExchanges(transport, sessionId, 8);

  await page.goto(`/?session=${sessionId}`);

  const list = page.locator("[data-transcript-virtual-list]");
  await expect(list).toHaveAttribute("data-transcript-ready", "true");
  await expect(page.locator("[data-transcript-scroll]")).toContainText("answer 7");

  const row = page.locator("[data-resume-host-row]");
  await expect(row).toContainText("No launch root is available");
  await expect(row).toContainText("Last active");
  await expect(page.getByRole("textbox", { name: "Resume host to continue" })).toBeDisabled();
});
