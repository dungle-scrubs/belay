import { expect, test } from "@playwright/test";
import {
  buildLucidSrcdoc,
  LUCID_IFRAME_SANDBOX,
} from "../../apps/web/src/artifact-panel/lucid/overlay-bootstrap";

/**
 * Real-browser Lucid overlay proof (plan 27, M3/M4). The jsdom `web` project cannot execute the
 * injected iframe script or cross a real postMessage boundary, so this Playwright spec covers exactly
 * that: the overlay runs INSIDE the sandboxed (opaque-origin) iframe, an element click is CAPTURED into
 * a structured element anchor, and it crosses to the parent as a well-formed `target` message. This
 * lane is NOT part of the `pnpm test` (jsdom) gate; run it via `pnpm test:e2e:browser`.
 */

const SAMPLE_HTML = `<!doctype html><html><head><style>body{font:16px system-ui;padding:24px}</style></head><body>
  <h1 data-lucid-id="title">Launch roadmap</h1>
  <ol>
    <li data-lucid-id="s1">Freeze scope.</li>
    <li data-lucid-id="s2">Ship the beta on Friday.</li>
  </ol>
</body></html>`;

test("the sandboxed overlay captures an element click into a structured target message", async ({
  page,
}) => {
  const srcdoc = buildLucidSrcdoc(SAMPLE_HTML).replace(/"/g, "&quot;");
  await page.setContent(
    `<!doctype html><html><body>
      <script>
        window.__lucidMessages = [];
        window.addEventListener("message", (event) => {
          // Trust only THIS frame's window (opaque origin => identity, not origin).
          if (event.source === document.getElementById("lucid")?.contentWindow) {
            window.__lucidMessages.push(event.data);
          }
        });
      </script>
      <iframe id="lucid" sandbox="${LUCID_IFRAME_SANDBOX}" srcdoc="${srcdoc}" style="width:600px;height:400px"></iframe>
    </body></html>`,
  );

  // The overlay announces itself once mounted inside the iframe.
  await expect
    .poll(() => page.evaluate(() => window.__lucidMessages?.some((m) => m?.kind === "ready")))
    .toBe(true);

  // Isolation: the iframe never got same-origin access.
  const sandbox = await page.locator("#lucid").getAttribute("sandbox");
  expect(sandbox).not.toContain("allow-same-origin");

  // Click a targetable element; the overlay captures its anchor and posts it out.
  await page.frameLocator("#lucid").locator('[data-lucid-id="s2"]').click();

  const target = await page.evaluate(() =>
    window.__lucidMessages?.find((m) => m?.kind === "target"),
  );
  expect(target).toBeTruthy();
  const anchor = (target?.anchor ?? {}) as {
    type?: string;
    lucidId?: string;
    fingerprint?: string;
  };
  expect(target?.target).toBe("element");
  expect(anchor.type).toBe("element");
  // The unique data-lucid-id is the primary anchor; a fingerprint/domPath fallback is always present.
  expect(anchor.lucidId ?? anchor.fingerprint).toBeTruthy();
  expect(String(target?.snippet)).toContain("Ship the beta");
});

declare global {
  interface Window {
    __lucidMessages?: Array<{
      kind?: string;
      target?: string;
      anchor?: Record<string, unknown>;
      snippet?: string;
    }>;
  }
}
