import assert from "node:assert/strict";
import { test } from "vitest";
import { belayConfigPath, loadBelayConfig } from "./node-config";

test("belayConfigPath follows BELAY_HOME", () => {
  assert.equal(belayConfigPath({ BELAY_HOME: "/cfg" }), "/cfg/config.jsonc");
});

test("loadBelayConfig reads JSONC model defaults", () => {
  const loaded = loadBelayConfig({
    env: { BELAY_HOME: "/cfg" },
    readFile: () => `{
      // default headless model
      "model": "openai/gpt-5",
      "reasoning": "high",
    }`,
  });

  assert.deepEqual(loaded, {
    path: "/cfg/config.jsonc",
    config: { model: "openai/gpt-5", reasoning: "high" },
    warning: null,
  });
});

test("loadBelayConfig degrades missing or malformed config to empty settings", () => {
  const missing = loadBelayConfig({
    env: { BELAY_HOME: "/cfg" },
    readFile: () => {
      throw new Error("missing");
    },
  });
  assert.deepEqual(missing, { path: "/cfg/config.jsonc", config: {}, warning: null });

  const malformed = loadBelayConfig({
    env: { BELAY_HOME: "/cfg" },
    readFile: () => "{ nope",
  });
  assert.deepEqual(malformed.config, {});
  assert.match(malformed.warning ?? "", /malformed/);
});
