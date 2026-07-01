import assert from "node:assert/strict";
import { test } from "vitest";
import { bootstrapNodeSentry, type SentryApi, type SentryInitOptions } from "./sentry";

/**
 * Node Sentry bootstrap gating (plan 13 M9): disabled without a DSN and under test/CI, and when enabled
 * it is errors-only with the scrubbing beforeSend.
 */

function recordingApi(): { api: SentryApi; inits: SentryInitOptions[] } {
  const inits: SentryInitOptions[] = [];
  return { api: { init: (o) => inits.push(o) }, inits };
}

test("Sentry is NOT initialized without a DSN (the default)", () => {
  const { api, inits } = recordingApi();
  assert.equal(bootstrapNodeSentry(api, { NODE_ENV: "production" }), false);
  assert.equal(inits.length, 0);
});

test("Sentry is NOT initialized under test/CI even when a DSN is set", () => {
  const { api, inits } = recordingApi();
  assert.equal(
    bootstrapNodeSentry(api, { NODE_ENV: "test", TREVOR_SENTRY_DSN: "https://a@x/1" }),
    false,
  );
  assert.equal(bootstrapNodeSentry(api, { CI: "1", TREVOR_SENTRY_DSN: "https://a@x/1" }), false);
  assert.equal(inits.length, 0, "the suite never initializes Sentry");
});

test("with a DSN, Sentry initializes errors-only with the scrubbing beforeSend", () => {
  const { api, inits } = recordingApi();
  assert.equal(
    bootstrapNodeSentry(api, { NODE_ENV: "production", TREVOR_SENTRY_DSN: "https://a@x/1" }),
    true,
  );
  assert.equal(inits.length, 1);
  const [opts] = inits;
  assert.equal(opts?.dsn, "https://a@x/1");
  assert.equal(opts?.tracesSampleRate, 0, "no performance tracing");
  assert.equal(opts?.profilesSampleRate, 0, "no profiling");
  assert.equal(opts?.enableLogs, false, "no structured-log capture");
  // The beforeSend is the shared scrubber: it drops the request block.
  const scrubbed = opts?.beforeSend({ request: { headers: { authorization: "Bearer x" } } });
  assert.equal(scrubbed?.request, undefined, "beforeSend scrubs the event");
});

test("release + environment tags are bounded and present when configured (M11)", () => {
  const { api, inits } = recordingApi();
  bootstrapNodeSentry(api, {
    NODE_ENV: "production",
    TREVOR_SENTRY_DSN: "https://a@x/1",
    SENTRY_RELEASE: "trevor@2.0.1",
  });
  assert.equal(inits[0]?.environment, "production");
  assert.equal(inits[0]?.release, "trevor@2.0.1");

  // With no release env, the tag is simply absent (never a raw path or high-cardinality value).
  const bare = recordingApi();
  bootstrapNodeSentry(bare.api, { NODE_ENV: "production", TREVOR_SENTRY_DSN: "https://a@x/1" });
  assert.equal(bare.inits[0]?.release, undefined);
});
