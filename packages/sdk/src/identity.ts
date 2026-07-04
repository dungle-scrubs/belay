import { PRODUCER_IDS, type SessionIdentity, viewerIdentity } from "@trevor/session";

/**
 * The default identity + producer a headless `@trevor/sdk` client presents on a session stream. The SDK
 * is a NON-host participant (a reader/automation client), so it joins with a `viewerIdentity` - the same
 * runtime kind the browser and CLI use, which the store never counts toward host presence. It publishes
 * user turns under `PRODUCER_IDS.web` by default so its prompts are answerable exactly like a browser
 * prompt (never the host's own self-echo). A CLI or eval harness overrides `producerId` to attribute its
 * events (e.g. the CLI stamps `PRODUCER_IDS.cli` on lifecycle markers).
 */

/** The display name a headless SDK client presents on presence, distinct from a browser/CLI viewer. */
export const SDK_DISPLAY_NAME = "trevor-sdk";

/** The default producer a headless client stamps on the user turns it publishes (answerable, like web). */
export const DEFAULT_SDK_PRODUCER_ID: string = PRODUCER_IDS.web;

let sdkInstanceCounter = 0;

/**
 * Builds the default viewer identity for a headless client, with a per-process-unique `instanceId` so two
 * SDK clients in one process are distinguishable on presence. Callers may pass an explicit identity to
 * `createTrevorClient` instead when they own participant identity (e.g. an eval run tags itself).
 */
export function sdkIdentity(instanceId?: string): SessionIdentity {
  sdkInstanceCounter += 1;
  const id = instanceId ?? `sdk-${sdkInstanceCounter}`;
  return viewerIdentity({ displayName: SDK_DISPLAY_NAME, instanceId: id, participantId: id });
}
