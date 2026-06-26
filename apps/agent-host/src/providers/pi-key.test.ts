import assert from "node:assert/strict";
import { getModel } from "@earendil-works/pi-ai/compat";
import { test } from "vitest";
import { resolvePiModel } from "./pi-key";

/**
 * Characterization test for the static-key model lookup (M2 / D-005), including the synthesis
 * path the base relies on: a model id not yet in pi-ai's registry is resolved by cloning the
 * closest sibling and overriding the id, so a just-released model still starts the host.
 */

test("resolvePiModel returns the registry model when the id is known", () => {
  const model = resolvePiModel("deepseek", "deepseek-v4-pro");
  assert.equal(model.id, "deepseek-v4-pro");
  // It is the genuine registry entry, not a synthesized clone.
  assert.equal(model.contextWindow, getModel("deepseek", "deepseek-v4-pro")?.contextWindow);
});

test("resolvePiModel synthesizes an unregistered id from the closest sibling", () => {
  // A model id newer than the installed zai registry must still resolve (sibling clone + id override).
  const synthesized = resolvePiModel("zai", "glm-9.9-turbo");
  assert.equal(synthesized.id, "glm-9.9-turbo", "the synthesized model carries the requested id");
  // It inherits a real sibling's transport shape, so streaming can reach the backend.
  assert.ok(synthesized.contextWindow > 0);
  assert.ok((synthesized as { baseUrl?: string }).baseUrl ?? synthesized.api);
});

test("resolvePiModel throws when the provider has no registered models to clone", () => {
  assert.throws(
    () => resolvePiModel("no-such-provider", "whatever-1.0"),
    /no models registered for pi-ai provider "no-such-provider"/,
  );
});
