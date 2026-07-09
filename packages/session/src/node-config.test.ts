import assert from "node:assert/strict";
import { test } from "vitest";
import { loadTrevorConfig, trevorConfigPath } from "./node-config";

test("trevorConfigPath follows TREVOR_HOME", () => {
  assert.equal(trevorConfigPath({ TREVOR_HOME: "/cfg" }), "/cfg/config.jsonc");
});

test("loadTrevorConfig reads JSONC model defaults", () => {
  const loaded = loadTrevorConfig({
    env: { TREVOR_HOME: "/cfg" },
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

test("loadTrevorConfig degrades missing or malformed config to empty settings", () => {
  const missing = loadTrevorConfig({
    env: { TREVOR_HOME: "/cfg" },
    readFile: () => {
      throw new Error("missing");
    },
  });
  assert.deepEqual(missing, { path: "/cfg/config.jsonc", config: {}, warning: null });

  const malformed = loadTrevorConfig({
    env: { TREVOR_HOME: "/cfg" },
    readFile: () => "{ nope",
  });
  assert.deepEqual(malformed.config, {});
  assert.match(malformed.warning ?? "", /malformed/);
});
