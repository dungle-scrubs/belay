import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceSignInState } from "@trevor/session";
import { afterEach, beforeEach, test } from "vitest";
import {
  type OAuthLogin,
  runSourceSignIn,
  signInTargetFor,
  writeOAuthCredential,
} from "./provider-auth";

/**
 * D-065 M5 host-driven source sign-in. The orchestration is pure-ish (the login is injected), so the
 * device-code -> complete/error/cancelled phase sequence, the credential write (preserving other
 * entries, pi's `{ type: "oauth", ... }` shape), and the no-secret boundary (the OAuth token never
 * reaches an emitted state) are all tested without any network.
 */

let dir: string;
let authPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "trevor-source-auth-"));
  authPath = join(dir, "auth.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SECRET = "sk-oauth-access-DO-NOT-LEAK";

/** A fake login that reports one device code then resolves with credentials (the success path). */
const fakeLoginOk: OAuthLogin = async ({ onDeviceCode }) => {
  onDeviceCode({ verificationUri: "https://auth.example/device", userCode: "ABCD-1234" });
  return { access: SECRET, refresh: "refresh-tok", expires: 123, accountId: "acct-1" };
};

test("signInTargetFor maps OpenAI to its auth entry; the Claude subscription and api-key sources have none", () => {
  assert.equal(signInTargetFor("openai")?.oauthName, "openai-codex");
  // 53 D-001/D-002: the Claude subscription authorizes via `claude setup-token` (a CLI token store),
  // not an in-app OAuth, and the Anthropic Direct API is a static key - neither has a sign-in target.
  assert.equal(signInTargetFor("claude-code"), null, "the Claude subscription has no in-app OAuth");
  assert.equal(signInTargetFor("anthropic"), null, "the Anthropic Direct API is a static key");
  assert.equal(signInTargetFor("deepseek"), null, "api-key sources have no sign-in flow");
  assert.equal(signInTargetFor("nope"), null);
});

test("a browser+paste sign-in emits the URL with acceptsCode, then completes on the pasted code", async () => {
  const states: SourceSignInState[] = [];
  // A browser+paste login (runSourceSignIn's generic onAuthUrl path): shows a URL, awaits the pasted
  // code, then returns credentials. No registered target is required - the login is injected, so this
  // pins the generic browser+paste capability the protocol keeps for any future source that needs it.
  const fakePasteLogin: OAuthLogin = async ({ onAuthUrl, requestCode }) => {
    onAuthUrl({ url: "https://provider.example/oauth/authorize?x=1" });
    const code = await requestCode();
    return { access: "paste-token", refresh: "r", expires: 1, via: code };
  };
  await runSourceSignIn({
    sourceId: "paste-source",
    oauthName: "paste-source",
    login: fakePasteLogin,
    authPath,
    signal: new AbortController().signal,
    emit: (s) => states.push(s),
    requestCode: async () => "PASTED-CODE",
  });
  assert.deepEqual(states, [
    {
      sourceId: "paste-source",
      phase: "device-code",
      verificationUri: "https://provider.example/oauth/authorize?x=1",
      acceptsCode: true,
    },
    { sourceId: "paste-source", phase: "complete" },
  ]);
  const stored = JSON.parse(await readFile(authPath, "utf8")) as Record<string, { type?: string }>;
  assert.equal(stored["paste-source"]?.type, "oauth", "the browser+paste credential is persisted");
});

test("a successful sign-in emits device-code then complete, and persists the credential", async () => {
  const states: SourceSignInState[] = [];
  await runSourceSignIn({
    sourceId: "openai",
    oauthName: "openai-codex",
    login: fakeLoginOk,
    authPath,
    signal: new AbortController().signal,
    emit: (s) => states.push(s),
    requestCode: async () => "",
  });

  assert.deepEqual(states, [
    {
      sourceId: "openai",
      phase: "device-code",
      verificationUri: "https://auth.example/device",
      userCode: "ABCD-1234",
    },
    { sourceId: "openai", phase: "complete" },
  ]);

  // The credential is written in pi's shape, ready for the credential resolver.
  const stored = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(stored["openai-codex"], {
    type: "oauth",
    access: SECRET,
    refresh: "refresh-tok",
    expires: 123,
    accountId: "acct-1",
  });

  // REDACTION: the emitted phases never carry the access token or any credential value.
  assert.ok(
    !JSON.stringify(states).includes(SECRET),
    "the OAuth token never reaches an emitted state",
  );
});

test("writeOAuthCredential preserves the other entries in the store", async () => {
  await writeFile(authPath, JSON.stringify({ deepseek: { key: "sk-deepseek" } }));
  await writeOAuthCredential(authPath, "openai-codex", { access: "a", refresh: "r", expires: 1 });
  const stored = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(stored.deepseek, { key: "sk-deepseek" }, "the existing api-key entry survives");
  assert.equal((stored["openai-codex"] as { type?: string }).type, "oauth");
});

test("a failed login emits an error phase with a sanitized detail, never throwing", async () => {
  const states: SourceSignInState[] = [];
  await runSourceSignIn({
    sourceId: "openai",
    oauthName: "openai-codex",
    login: async () => {
      throw new Error("device code expired");
    },
    authPath,
    signal: new AbortController().signal,
    emit: (s) => states.push(s),
    requestCode: async () => "",
  });
  assert.deepEqual(states, [{ sourceId: "openai", phase: "error", detail: "device code expired" }]);
  // Nothing was written on failure.
  await assert.rejects(readFile(authPath, "utf8"));
});

test("an aborted sign-in emits cancelled (not error), with no detail", async () => {
  const controller = new AbortController();
  controller.abort();
  const states: SourceSignInState[] = [];
  await runSourceSignIn({
    sourceId: "openai",
    oauthName: "openai-codex",
    login: async () => {
      throw new Error("aborted");
    },
    authPath,
    signal: controller.signal,
    emit: (s) => states.push(s),
    requestCode: async () => "",
  });
  assert.deepEqual(states, [{ sourceId: "openai", phase: "cancelled" }]);
});
