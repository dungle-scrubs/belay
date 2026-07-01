import { assert, test } from "vitest";
import {
  type BrowserSentryApi,
  type BrowserSentryInitOptions,
  bootstrapBrowserSentry,
  captureRenderCrash,
} from "./sentry";

/**
 * Browser Sentry bootstrap gating (plan 13 M10): disabled without VITE_TREVOR_SENTRY_DSN and under
 * test/CI, and when enabled it is errors-only (no tracing/replay/profiling) with the scrubbing beforeSend.
 */

function recordingApi(): {
  api: BrowserSentryApi;
  inits: BrowserSentryInitOptions[];
  captured: unknown[];
} {
  const inits: BrowserSentryInitOptions[] = [];
  const captured: unknown[] = [];
  return {
    api: { init: (o) => inits.push(o), captureException: (e) => captured.push(e) },
    inits,
    captured,
  };
}

test("browser Sentry is NOT initialized without a DSN", () => {
  const { api, inits } = recordingApi();
  assert.equal(bootstrapBrowserSentry(api, { MODE: "production" }), false);
  assert.equal(inits.length, 0);
  // captureRenderCrash is a no-op when disabled.
  captureRenderCrash(new Error("x"));
});

test("browser Sentry is NOT initialized under test/CI even with a DSN", () => {
  const { api, inits } = recordingApi();
  assert.equal(
    bootstrapBrowserSentry(api, { NODE_ENV: "test", VITE_TREVOR_SENTRY_DSN: "https://w@x/3" }),
    false,
  );
  assert.equal(inits.length, 0);
});

test("with a DSN, browser Sentry is errors-only with the scrubbing beforeSend + wires captureRenderCrash", () => {
  const { api, inits, captured } = recordingApi();
  assert.equal(
    bootstrapBrowserSentry(api, { MODE: "production", VITE_TREVOR_SENTRY_DSN: "https://w@x/3" }),
    true,
  );
  const [opts] = inits;
  assert.equal(opts?.dsn, "https://w@x/3");
  assert.equal(opts?.tracesSampleRate, 0);
  assert.equal(opts?.replaysSessionSampleRate, 0);
  assert.equal(opts?.replaysOnErrorSampleRate, 0);
  assert.equal(opts?.profilesSampleRate, 0);
  assert.equal(opts?.beforeSend({ request: { headers: {} } })?.request, undefined, "scrubs events");

  // The error boundary's crash now reaches Sentry.
  const err = new Error("render crash");
  captureRenderCrash(err);
  assert.deepEqual(captured, [err]);
});
