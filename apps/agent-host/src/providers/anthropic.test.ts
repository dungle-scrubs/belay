import assert from "node:assert/strict";
import { Effect } from "effect";
import { test } from "vitest";
import { anthropicProvider } from "./anthropic";
import { PiAiProviderBase } from "./pi-ai-base";

/**
 * Unit test for the Claude subscription OAuth provider (53.1 D-001). anthropicProvider builds a
 * PiAiProviderBase on the anthropic registry with the OAuth credential strategy - the same base
 * codex/pi-key share (pi-ai-base.test.ts pins the strategy-driven behavior). This pins the anthropic
 * wiring: the id/label/model surface, the cloud kind, and the Claude reasoning + vision shape (from the
 * anthropic registry, or the safe fallback for a just-released id). The OAuth-resolver DISPATCH is
 * covered where it is observable - catalog.test.ts (`providerForSource` routes `anthropic` here, never
 * codex / the deleted Agent-SDK route) and credentials.test.ts (`oauthCredentialResolver` failure modes) - since the
 * resolver is private and reads the real ~/.pi/auth.json, so a hermetic readiness assertion is awkward.
 */

test("anthropicProvider builds a cloud pi-ai provider on the anthropic registry", () => {
  const provider = anthropicProvider({ model: "claude-opus-4-0", label: "Claude subscription" });
  assert.ok(provider instanceof PiAiProviderBase, "the OAuth Claude provider is a pi-ai base");
  assert.equal(provider.id, "anthropic");
  assert.equal(provider.label, "Claude subscription");
  assert.equal(provider.model, "claude-opus-4-0");
  assert.equal(provider.kind, "cloud");
});

test("anthropicProvider advertises Claude's disableable, high-reaching reasoning + vision", () => {
  const provider = anthropicProvider({ model: "claude-opus-4-0", label: "Claude subscription" });
  // From the anthropic registry shape or the declared fallback ({ levels: ["off","high"], images:true }).
  assert.ok(provider.reasoningLevels.includes("off"), "thinking is disableable");
  assert.ok(provider.reasoningLevels.includes("high"), "a high thinking level is advertised");
  assert.ok(
    provider.reasoningLevels.includes(provider.defaultReasoning),
    "the default reasoning is one of the advertised levels",
  );
  assert.equal(Effect.runSync(provider.capabilities()).images, true, "Claude is vision-capable");
});
