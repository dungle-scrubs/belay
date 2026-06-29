import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { SourceSignInState } from "@trevor/session";
import { msg } from "../messages";
import { ProviderAuthError } from "./errors";

export const AUTH_PATH = `${homedir()}/.pi/auth.json`;
export const SOURCE_AUTH_PATH = AUTH_PATH;

export interface CredentialResolver {
  resolveApiKey(): Promise<string>;
}

/**
 * The static-key value for a `~/.pi/auth.json` `{ key }` entry, or null when absent/empty. The one
 * owner of the `{ key }` shape predicate - both the credential resolver below and the catalog's
 * configured/key projection read a static key through here, so "what counts as a present key" is
 * defined once.
 */
export function staticKeyEntry(auth: Record<string, unknown>, authName: string): string | null {
  const entry = auth[authName] as { key?: unknown } | undefined;
  return typeof entry?.key === "string" && entry.key.length > 0 ? entry.key : null;
}

/** Whether a `~/.pi/auth.json` OAuth entry is present (the configured signal for an oauth source). */
export function oauthPresent(auth: Record<string, unknown>, oauthName: string): boolean {
  return auth[oauthName] != null;
}

async function readAuth(
  providerId: string,
  authPath: string,
  hint: string,
): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
  } catch (cause) {
    throw new ProviderAuthError({
      provider: providerId,
      detail: `cannot read ${authPath} (${hint})`,
      cause,
    });
  }
}

export function oauthCredentialResolver(params: {
  readonly providerId: string;
  readonly oauthName: string;
  readonly authPath?: string;
}): CredentialResolver {
  const authPath = params.authPath ?? AUTH_PATH;
  return {
    async resolveApiKey(): Promise<string> {
      const auth = await readAuth(params.providerId, authPath, "log in with the pi CLI");
      const credentials = auth[params.oauthName];
      if (!credentials) {
        throw new ProviderAuthError({
          provider: params.providerId,
          detail: `no ${params.oauthName} entry in ${authPath}`,
        });
      }
      const { getOAuthApiKey } = await import("@earendil-works/pi-ai/oauth");
      // biome-ignore lint/suspicious/noExplicitAny: pi-ai's OAuth name + credential shapes are internal.
      const oauth = getOAuthApiKey as (name: any, creds: any) => Promise<{ apiKey: string } | null>;
      const resolved = await oauth(params.oauthName, { [params.oauthName]: credentials });
      if (!resolved) {
        throw new ProviderAuthError({
          provider: params.providerId,
          detail: "OAuth refresh failed (re-login with the pi CLI)",
        });
      }
      return resolved.apiKey;
    },
  };
}

export function staticKeyCredentialResolver(params: {
  readonly providerId: string;
  readonly authName: string;
  readonly authPath?: string;
}): CredentialResolver {
  const authPath = params.authPath ?? AUTH_PATH;
  return {
    async resolveApiKey(): Promise<string> {
      const auth = await readAuth(
        params.providerId,
        authPath,
        `add a ${params.authName} key with the pi CLI`,
      );
      const key = staticKeyEntry(auth, params.authName);
      if (key === null) {
        throw new ProviderAuthError({
          provider: params.providerId,
          detail: `no ${params.authName}.key in ${authPath}`,
        });
      }
      return key;
    },
  };
}

export interface DeviceCode {
  readonly verificationUri: string;
  readonly userCode: string;
}

export interface LoginCallbacks {
  readonly onDeviceCode: (dc: DeviceCode) => void;
  readonly onAuthUrl: (info: { url: string; instructions?: string }) => void;
  readonly requestCode: () => Promise<string>;
  readonly signal: AbortSignal;
}
export type OAuthLogin = (cb: LoginCallbacks) => Promise<Record<string, unknown>>;

async function codexDeviceCodeLogin(cb: LoginCallbacks): Promise<Record<string, unknown>> {
  const { loginOpenAICodexDeviceCode } = await import("@earendil-works/pi-ai/oauth");
  const credentials = await loginOpenAICodexDeviceCode({
    onDeviceCode: (info) =>
      cb.onDeviceCode({ verificationUri: info.verificationUri, userCode: info.userCode }),
    signal: cb.signal,
  });
  return credentials as unknown as Record<string, unknown>;
}

async function anthropicLogin(cb: LoginCallbacks): Promise<Record<string, unknown>> {
  const { loginAnthropic } = await import("@earendil-works/pi-ai/oauth");
  const credentials = await loginAnthropic({
    onAuth: (info) => cb.onAuthUrl({ url: info.url, instructions: info.instructions }),
    onPrompt: () => cb.requestCode(),
  });
  return credentials as unknown as Record<string, unknown>;
}

const SIGN_IN_TARGETS: Readonly<Record<string, { oauthName: string; login: OAuthLogin }>> = {
  openai: { oauthName: "openai-codex", login: codexDeviceCodeLogin },
  anthropic: { oauthName: "anthropic", login: anthropicLogin },
};

export function signInTargetFor(sourceId: string): { oauthName: string; login: OAuthLogin } | null {
  return SIGN_IN_TARGETS[sourceId] ?? null;
}

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

export async function runSourceSignIn(opts: {
  readonly sourceId: string;
  readonly oauthName: string;
  readonly login: OAuthLogin;
  readonly authPath: string;
  readonly signal: AbortSignal;
  readonly emit: (state: SourceSignInState) => void;
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
