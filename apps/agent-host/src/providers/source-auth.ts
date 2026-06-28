import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { SourceSignInState } from "@trevor/session";
import { msg } from "../messages";

/**
 * Host-driven source SIGN-IN flows (D-065 M5). The chooser never accepts an API key; for an OAuth
 * source it asks the host to run a sign-in, and the host drives a device-code flow: it reports the
 * verification URL + short user code (a code, never a secret), waits for the user to authorize, then
 * persists the resulting OAuth credential to the pi auth store and re-reads the catalog so the source
 * flips to ready. This module owns the orchestration + the credential write; the actual provider
 * login is injected (the real one wraps pi-ai's Codex device-code flow) so the orchestration is
 * unit-tested without any network.
 */

/** The pi auth store the host reads/writes provider credentials from (same file as credentials.ts). */
export const SOURCE_AUTH_PATH = `${homedir()}/.pi/auth.json`;

/** The device-code a login surfaces: a URL to open + a short user code to enter (NOT an API key). */
export interface DeviceCode {
  readonly verificationUri: string;
  readonly userCode: string;
}

/**
 * The callbacks a login flow drives. Two shapes are covered, both rendered by the same no-key panel:
 *  - DEVICE-CODE (Codex): `onDeviceCode` shows a URL + a short code; the provider polls, no paste.
 *  - BROWSER + PASTE (Anthropic): `onAuthUrl` shows a URL; after authorizing the user pastes the
 *    returned code back, awaited via `requestCode`.
 * Injectable so the orchestration is tested with a fake login (no network).
 */
export interface LoginCallbacks {
  readonly onDeviceCode: (dc: DeviceCode) => void;
  readonly onAuthUrl: (info: { url: string; instructions?: string }) => void;
  readonly requestCode: () => Promise<string>;
  readonly signal: AbortSignal;
}
export type OAuthLogin = (cb: LoginCallbacks) => Promise<Record<string, unknown>>;

/** The real OpenAI Codex device-code login (pi-ai), imported lazily so tests never load the network path. */
async function codexDeviceCodeLogin(cb: LoginCallbacks): Promise<Record<string, unknown>> {
  const { loginOpenAICodexDeviceCode } = await import("@earendil-works/pi-ai/oauth");
  const credentials = await loginOpenAICodexDeviceCode({
    onDeviceCode: (info) =>
      cb.onDeviceCode({ verificationUri: info.verificationUri, userCode: info.userCode }),
    signal: cb.signal,
  });
  return credentials as unknown as Record<string, unknown>;
}

/** The real Anthropic (Claude Pro/Max) login (pi-ai): opens a URL, then the user pastes the returned
 *  code back. `requestCode` resolves with that code (and rejects on abort, unwinding the login). */
async function anthropicLogin(cb: LoginCallbacks): Promise<Record<string, unknown>> {
  const { loginAnthropic } = await import("@earendil-works/pi-ai/oauth");
  const credentials = await loginAnthropic({
    onAuth: (info) => cb.onAuthUrl({ url: info.url, instructions: info.instructions }),
    onPrompt: () => cb.requestCode(),
  });
  return credentials as unknown as Record<string, unknown>;
}

/** The sources that support a host-driven sign-in (the OAuth subscriptions). The api-key sources are
 *  configured by adding a key to the auth store, not by a sign-in flow. */
const SIGN_IN_TARGETS: Readonly<Record<string, { oauthName: string; login: OAuthLogin }>> = {
  openai: { oauthName: "openai-codex", login: codexDeviceCodeLogin },
  anthropic: { oauthName: "anthropic", login: anthropicLogin },
};

/** The sign-in target (auth.json entry + login flow) for a source, or null when it has no sign-in. */
export function signInTargetFor(sourceId: string): { oauthName: string; login: OAuthLogin } | null {
  return SIGN_IN_TARGETS[sourceId] ?? null;
}

/**
 * Persists an OAuth credential under `oauthName` in the pi auth store, preserving every OTHER entry
 * (read-modify-write). The stored shape matches pi's existing entries: `{ type: "oauth", ...creds }`,
 * so the same credential resolver reads it back on the next turn.
 */
export async function writeOAuthCredential(
  authPath: string,
  oauthName: string,
  credentials: Record<string, unknown>,
): Promise<void> {
  let auth: Record<string, unknown> = {};
  try {
    auth = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
  } catch {
    // A missing/garbled store starts fresh - the write below recreates it with just this entry.
  }
  auth[oauthName] = { type: "oauth", ...credentials };
  await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`);
}

/**
 * Runs a source sign-in to completion, emitting each phase. NEVER throws: a failure emits an `error`
 * phase (or `cancelled` when the signal aborted), so a bad login can't crash the host. On success the
 * credential is written and `complete` is emitted - the caller then refreshes the catalog so the
 * source flips to ready (and the auth.json key is never echoed into any emitted state).
 */
export async function runSourceSignIn(opts: {
  readonly sourceId: string;
  readonly oauthName: string;
  readonly login: OAuthLogin;
  readonly authPath: string;
  readonly signal: AbortSignal;
  readonly emit: (state: SourceSignInState) => void;
  /** Awaits a user-pasted code for the browser+paste flow (Anthropic); the caller resolves it when a
   *  code arrives. Device-code flows never call it. */
  readonly requestCode: () => Promise<string>;
}): Promise<void> {
  try {
    const credentials = await opts.login({
      onDeviceCode: (dc) =>
        opts.emit({
          sourceId: opts.sourceId,
          phase: "device-code",
          verificationUri: dc.verificationUri,
          userCode: dc.userCode,
        }),
      onAuthUrl: (info) =>
        opts.emit({
          sourceId: opts.sourceId,
          phase: "device-code",
          verificationUri: info.url,
          acceptsCode: true,
        }),
      requestCode: opts.requestCode,
      signal: opts.signal,
    });
    await writeOAuthCredential(opts.authPath, opts.oauthName, credentials);
    opts.emit({ sourceId: opts.sourceId, phase: "complete" });
  } catch (error) {
    opts.emit(
      opts.signal.aborted
        ? { sourceId: opts.sourceId, phase: "cancelled" }
        : { sourceId: opts.sourceId, phase: "error", detail: msg(error) },
    );
  }
}
