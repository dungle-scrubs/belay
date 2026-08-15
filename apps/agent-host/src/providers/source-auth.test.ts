import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceSignInState } from "@belay/session";
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
  dir = await mkdtemp(join(tmpdir(), "belay-source-auth-"));
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

test("signInTargetFor maps OpenAI and the Claude subscription to their OAuth entries; api-key sources have none", () => {
  assert.equal(signInTargetFor("openai")?.oauthName, "openai-codex");
  // 53.1 D-001: the ONE Claude subscription (`anthropic`) has a real in-app OAuth (loginAnthropic PKCE);
  // the Anthropic *Direct API* (`anthropic-api`) is a static key, so it carries no sign-in target.
  assert.equal(
    signInTargetFor("anthropic")?.oauthName,
    "anthropic",
    "the Claude subscription signs in",
  );
  assert.equal(signInTargetFor("anthropic-api"), null, "the Anthropic Direct API is a static key");
  assert.equal(signInTargetFor("deepseek"), null, "api-key sources have no sign-in flow");
  assert.equal(signInTargetFor("nope"), null);
});

test("the Claude subscription browser+paste sign-in emits the URL with acceptsCode, then completes on the pasted code", async () => {
  const states: SourceSignInState[] = [];
  // The Claude subscription's `loginAnthropic` shape (53.1 D-001): it fires `onAuth` (the host's
  // onAuthUrl) with the provider URL, awaits the pasted redirect code (onPrompt -> requestCode), then
  // resolves the OAuth credential. This drives runSourceSignIn's generic browser+paste path for the
  // real Claude source, so a busy localhost callback port still completes via paste (53.1 R-2).
  const fakeAnthropicLogin: OAuthLogin = async ({ onAuthUrl, requestCode }) => {
    onAuthUrl({ url: "https://claude.ai/oauth/authorize?client_id=belay&x=1" });
    const code = await requestCode();
    return { access: "anthropic-oauth-token", refresh: "r", expires: 1, via: code };
  };
  await runSourceSignIn({
    sourceId: "anthropic",
    oauthName: "anthropic",
    login: fakeAnthropicLogin,
    authPath,
    signal: new AbortController().signal,
    emit: (s) => states.push(s),
    requestCode: async () => "PASTED-CODE",
  });
  assert.deepEqual(states, [
    {
      sourceId: "anthropic",
      phase: "device-code",
      verificationUri: "https://claude.ai/oauth/authorize?client_id=belay&x=1",
      acceptsCode: true,
    },
    { sourceId: "anthropic", phase: "complete" },
  ]);
  const stored = JSON.parse(await readFile(authPath, "utf8")) as Record<string, { type?: string }>;
  assert.equal(
    stored.anthropic?.type,
    "oauth",
    "the Claude subscription OAuth credential is persisted",
  );
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
