import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { ProviderAuthError } from "./errors";
import {
  oauthCredentialResolver,
  persistRefreshedOAuth,
  staticKeyCredentialResolver,
} from "./provider-auth";

/**
 * Characterization tests for the credential strategies (M2 / D-005).
 *
 * The two resolvers are the only thing the pi-ai providers vary on. These pin the static-key
 * path end-to-end (present / missing file / missing entry / empty key) and the OAuth path's
 * missing-file / missing-entry failures - all surfacing the same typed ProviderAuthError with an
 * actionable detail, against a temp auth file (no dependency on the machine's real ~/.pi).
 */

async function writeAuth(contents: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "trevor-auth-"));
  const path = join(dir, "auth.json");
  await writeFile(path, JSON.stringify(contents), "utf8");
  return path;
}

test("static key: resolves the bearer key from auth.json[authName].key", async () => {
  const authPath = await writeAuth({ deepseek: { key: "sk-deepseek-123" } });
  const resolver = staticKeyCredentialResolver({
    providerId: "deepseek",
    authName: "deepseek",
    authPath,
  });
  assert.equal(await resolver.resolveApiKey(), "sk-deepseek-123");
});

test("static key: a missing auth file fails as ProviderAuthError with a fix hint", async () => {
  const resolver = staticKeyCredentialResolver({
    providerId: "glm",
    authName: "zai",
    authPath: join(tmpdir(), "trevor-does-not-exist", "auth.json"),
  });
  const error = await resolver.resolveApiKey().then(
    () => null,
    (e) => e,
  );
  assert.ok(error instanceof ProviderAuthError);
  assert.equal(error.provider, "glm");
  assert.match(error.detail, /cannot read .*auth\.json \(add a zai key with the pi CLI\)/);
});

test("static key: a missing entry or empty key fails as ProviderAuthError", async () => {
  const noEntry = staticKeyCredentialResolver({
    providerId: "deepseek",
    authName: "deepseek",
    authPath: await writeAuth({ other: { key: "x" } }),
  });
  const e1 = await noEntry.resolveApiKey().then(
    () => null,
    (e) => e,
  );
  assert.ok(e1 instanceof ProviderAuthError);
  assert.match(e1.detail, /no deepseek\.key in/);

  const emptyKey = staticKeyCredentialResolver({
    providerId: "deepseek",
    authName: "deepseek",
    authPath: await writeAuth({ deepseek: { key: "" } }),
  });
  const e2 = await emptyKey.resolveApiKey().then(
    () => null,
    (e) => e,
  );
  assert.ok(e2 instanceof ProviderAuthError);
  assert.match(e2.detail, /no deepseek\.key in/);
});

test("oauth: a missing auth file fails as ProviderAuthError with a login hint", async () => {
  const resolver = oauthCredentialResolver({
    providerId: "codex",
    oauthName: "openai-codex",
    authPath: join(tmpdir(), "trevor-does-not-exist", "auth.json"),
  });
  const error = await resolver.resolveApiKey().then(
    () => null,
    (e) => e,
  );
  assert.ok(error instanceof ProviderAuthError);
  assert.equal(error.provider, "codex");
  assert.match(error.detail, /cannot read .*auth\.json \(log in with the pi CLI\)/);
});

test("oauth: no openai-codex entry fails as ProviderAuthError before any refresh", async () => {
  const resolver = oauthCredentialResolver({
    providerId: "codex",
    oauthName: "openai-codex",
    authPath: await writeAuth({ deepseek: { key: "x" } }),
  });
  const error = await resolver.resolveApiKey().then(
    () => null,
    (e) => e,
  );
  assert.ok(error instanceof ProviderAuthError);
  assert.match(error.detail, /no openai-codex entry in/);
});

test("persistRefreshedOAuth writes the rotated credential and preserves every other entry", async () => {
  // The refresh-persist contract: pi-ai returns post-refresh credentials FOR THE CALLER to store.
  // Dropping them strands ~/.pi/auth.json on a rotated-away refresh token and freezes `expires` in
  // the past - the silent corruption behind "Failed to refresh OAuth token" wedges.
  const authPath = await writeAuth({
    anthropic: { type: "oauth", refresh: "old-refresh", access: "old-access", expires: 1 },
    deepseek: { key: "sk-deepseek-123" },
  });
  const rotated = { type: "oauth", refresh: "new-refresh", access: "new-access", expires: 9999 };
  await persistRefreshedOAuth(authPath, "anthropic", rotated);
  const stored = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(stored.anthropic, rotated, "the refreshed credential replaces the stale one");
  assert.deepEqual(
    stored.deepseek,
    { key: "sk-deepseek-123" },
    "other providers' entries are untouched",
  );
});

test("persistRefreshedOAuth rejects on an unreadable store (callers persist best-effort)", async () => {
  // The resolver swallows this rejection: a persist failure must never fail the turn that just
  // resolved a working key. This pins that the failure surfaces as a rejection to swallow, not a
  // silent partial write.
  await assert.rejects(
    persistRefreshedOAuth(join(tmpdir(), "trevor-does-not-exist", "auth.json"), "anthropic", {}),
  );
});
