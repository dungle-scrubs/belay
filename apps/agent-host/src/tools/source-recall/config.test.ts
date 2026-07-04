import assert from "node:assert/strict";
import { test } from "vitest";
import {
  loadSourceRecallConfig,
  normalizeSourceRecallConfig,
  redactSourceRecallProvider,
} from "./config";

/**
 * Plan 38 M8: the `source-recall.json` provider config decoder - tolerant normalization, structured
 * validation issues, per-kind defaults, and the redacted inspection projection. A malformed entry is
 * dropped as data; a missing file degrades to empty (the tools then report "unavailable").
 */

test("normalizes a valid two-provider config with defaults and declaration-order priority", () => {
  const cfg = normalizeSourceRecallConfig({
    providers: {
      local: { kind: "source-recall", endpoint: "http://127.0.0.1:7249", repo: "api" },
      trace: {
        kind: "aleutian",
        endpoint: "http://127.0.0.1:12217",
        enabled: false,
        projectRoot: "/dev/app",
        languages: ["go", "python"],
      },
    },
  });
  assert.equal(cfg.issues.length, 0);
  assert.equal(cfg.providers.length, 2);

  const local = cfg.providers.find((p) => p.id === "local");
  assert.equal(local?.enabled, true, "enabled defaults to true");
  assert.equal(local?.timeoutMs, 10_000, "source-recall default timeout");
  assert.equal(local?.priority, 0);
  assert.equal(local?.repo, "api");

  const trace = cfg.providers.find((p) => p.id === "trace");
  assert.equal(trace?.enabled, false);
  assert.equal(trace?.timeoutMs, 30_000, "aleutian default timeout");
  assert.equal(trace?.transport, "http", "aleutian transport defaults to http");
  assert.deepEqual(trace?.languages, ["go", "python"]);
});

test("an aleutian mcp-transport provider needs no endpoint", () => {
  const cfg = normalizeSourceRecallConfig({
    providers: { m: { kind: "aleutian", transport: "mcp" } },
  });
  assert.equal(cfg.issues.length, 0);
  assert.equal(cfg.providers[0]?.transport, "mcp");
  assert.equal(cfg.providers[0]?.endpoint, "");
});

test("drops entries with invalid kind / endpoint / id / transport as structured issues", () => {
  const cfg = normalizeSourceRecallConfig({
    providers: {
      good: { kind: "source-recall", endpoint: "http://127.0.0.1:7249" },
      badkind: { kind: "elasticsearch", endpoint: "http://127.0.0.1:9200" },
      badurl: { kind: "source-recall", endpoint: "not-a-url" },
      "bad id": { kind: "source-recall", endpoint: "http://127.0.0.1:7249" },
      badtransport: { kind: "aleutian", transport: "grpc", endpoint: "http://127.0.0.1:1" },
    },
  });
  assert.equal(cfg.providers.length, 1);
  assert.equal(cfg.providers[0]?.id, "good");
  const kinds = cfg.issues.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ["invalid_endpoint", "invalid_id", "invalid_kind", "invalid_transport"]);
});

test("a non-object providers value is a single invalid_shape issue", () => {
  const cfg = normalizeSourceRecallConfig({ providers: [1, 2, 3] });
  assert.equal(cfg.providers.length, 0);
  assert.equal(cfg.issues[0]?.kind, "invalid_shape");
});

test("redaction keeps origin + path, strips userinfo/query/fragment", () => {
  const redacted = redactSourceRecallProvider({
    id: "local",
    kind: "source-recall",
    endpoint: "http://user:pw@127.0.0.1:7249/base?token=secret#frag",
    enabled: true,
    timeoutMs: 10_000,
    priority: 0,
  });
  assert.equal(redacted.endpoint, "http://127.0.0.1:7249/base");
  assert.ok(!redacted.endpoint.includes("secret"));
  assert.ok(!redacted.endpoint.includes("pw"));
});

test("a missing config file degrades to empty (no providers, no throw)", () => {
  const cfg = loadSourceRecallConfig(() => {
    throw new Error("ENOENT");
  });
  assert.deepEqual(cfg.providers, []);
});

test("a malformed JSON config degrades to empty via loadJsonConfig", () => {
  const cfg = loadSourceRecallConfig(() => "{ not json");
  assert.deepEqual(cfg.providers, []);
});
