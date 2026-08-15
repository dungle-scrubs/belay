import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveModelConfig } from "./config";

test("model config precedence is flag over env over file over host default", () => {
  const loadedConfig = {
    path: "/cfg/config.jsonc",
    config: { model: "file/model", reasoning: "low" },
    warning: null,
  };

  assert.deepEqual(
    resolveModelConfig({
      flagModel: "flag/model",
      flagReasoning: "high",
      env: { TREVOR_MODEL: "env/model", TREVOR_REASONING: "medium" },
      loadedConfig,
    }),
    { model: "flag/model", reasoning: "high", warning: null },
  );
  assert.deepEqual(
    resolveModelConfig({
      env: { TREVOR_MODEL: "env/model", TREVOR_REASONING: "medium" },
      loadedConfig,
    }),
    { model: "env/model", reasoning: "medium", warning: null },
  );
  assert.deepEqual(resolveModelConfig({ env: {}, loadedConfig }), {
    model: "file/model",
    reasoning: "low",
    warning: null,
  });
  assert.deepEqual(
    resolveModelConfig({
      env: {},
      loadedConfig: { path: "/cfg/config.jsonc", config: {}, warning: null },
    }),
    { warning: null },
  );
});
