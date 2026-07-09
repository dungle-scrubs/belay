import { expect, test } from "@playwright/test";
import { appendCommandFocusResult, seedExchanges, storeTransport } from "./lane-b-fixtures";

test("worktree creation result focuses the target session without replay bounce", async ({
  page,
}) => {
  const transport = storeTransport();
  const suffix = `${test.info().workerIndex}-${Date.now()}`;
  const sourceSessionId = `worktree-source-${suffix}`;
  const targetSessionId = `worktree-target-${suffix}`;

  await seedExchanges(transport, sourceSessionId, 8);
  await seedExchanges(transport, targetSessionId, 2);

  await page.goto(`/?session=${sourceSessionId}`);

  const list = page.locator("[data-transcript-virtual-list]");
  await expect(list).toHaveAttribute("data-transcript-ready", "true");
  await expect(page.locator("[data-transcript-scroll]")).toContainText("answer 7");

  await appendCommandFocusResult(transport, sourceSessionId, targetSessionId);

  await expect.poll(() => new URL(page.url()).searchParams.get("session")).toBe(targetSessionId);
  await expect(page.locator("[data-transcript-scroll]")).toContainText("answer 1");

  await page.goto(`/?session=${sourceSessionId}`);
  await expect(list).toHaveAttribute("data-transcript-ready", "true");

  await expect.poll(() => new URL(page.url()).searchParams.get("session")).toBe(sourceSessionId);
});
