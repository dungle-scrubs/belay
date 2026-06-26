import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { ProviderAuthError } from "./errors";

/**
 * The credential STRATEGY a pi-ai-backed provider varies on. Everything else - the
 * stream/readiness/capabilities template - is shared in PiAiProviderBase; only HOW the
 * bearer key is obtained differs:
 *   - an OAuth token refreshed from ~/.pi/auth.json (Codex), or
 *   - a static API key read from it (DeepSeek / GLM / MiniMax).
 * Both read the one shared `AUTH_PATH`. `resolveApiKey` throws ProviderAuthError with an
 * actionable detail when the credential is absent or unusable, so a missing/bad credential
 * reads as "auth failed - re-auth", never a hang. This module owns that one decision; the
 * provider base owns everything that does not vary by credential.
 */

/** The single pi credentials file both strategies read. */
export const AUTH_PATH = `${homedir()}/.pi/auth.json`;

/** Resolves a provider's bearer API key, or throws ProviderAuthError. */
export interface CredentialResolver {
  resolveApiKey(): Promise<string>;
}

/** Reads + parses the pi auth file, raising a ProviderAuthError (with a per-strategy hint on
 *  how to fix it) when it cannot be read. Shared by both strategies so the read path is one. */
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

/**
 * OAuth strategy (Codex): the auth file holds an OAuth credential under `oauthName`; the key
 * is minted/refreshed by pi-ai's `getOAuthApiKey`. A missing entry or a failed refresh is an
 * auth failure, not an outage.
 */
export function oauthCredentialResolver(params: {
  /** Provider id used in the error envelope, e.g. "codex". */
  readonly providerId: string;
  /** The auth.json / pi-ai OAuth key, e.g. "openai-codex". */
  readonly oauthName: string;
  /** Override the credentials path (tests); defaults to the shared AUTH_PATH. */
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

/**
 * Static-key strategy (DeepSeek / GLM / MiniMax): the auth file holds `{ key }` under
 * `authName`. A missing file/entry/empty key is an auth failure; a key the API later rejects
 * surfaces from the stream (pi-ai.ts classifies auth-status errors), so a bad key still reads
 * as "auth failed" rather than a stall.
 */
export function staticKeyCredentialResolver(params: {
  /** Provider id used in the error envelope, e.g. "deepseek". */
  readonly providerId: string;
  /** Top-level key in auth.json holding `{ key }` for this provider. */
  readonly authName: string;
  /** Override the credentials path (tests); defaults to the shared AUTH_PATH. */
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
      const entry = auth[params.authName] as { key?: unknown } | undefined;
      if (!entry || typeof entry.key !== "string" || entry.key.length === 0) {
        throw new ProviderAuthError({
          provider: params.providerId,
          detail: `no ${params.authName}.key in ${authPath}`,
        });
      }
      return entry.key;
    },
  };
}
