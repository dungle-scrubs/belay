import type { SessionIdentity } from "./transport";

/**
 * The cross-surface coordination constants the host, web, and session-store must
 * agree on. Each of these rode as a bare literal on every surface - a `runtimeKind`
 * here, a default session id there - where a rename on one side silently broke
 * presence or split the host and browser into different sessions, with nothing to
 * catch it. Owning them here makes a change one edit and a mismatch a type error.
 */

/**
 * The session host and browser both attach to when none is given (the host reads
 * SESSION_ID, the web reads ?session=). They auto-pair only because both default to
 * THIS id, so it must be one value, not two literals that can drift apart.
 */
export const DEFAULT_SESSION_ID = "trevor-local";

/**
 * The `runtimeKind` each participant declares on its stream identity. The store
 * counts only a host-kind connection toward presence (a web viewer never does), so
 * the host's declared kind and the store's check are the SAME string or presence
 * silently stops working.
 */
export const RUNTIME_KIND = { host: "trevor", web: "web" } as const;
export type RuntimeKind = (typeof RUNTIME_KIND)[keyof typeof RUNTIME_KIND];

/**
 * The producerId each surface stamps on the events it publishes. The host suppresses
 * its own echo by comparing an event's producerId against its own (PRODUCER_IDS.host),
 * and history projection keys self-vs-other off it - so the namespace lives here once.
 * The `trevor` CLI stamps `cli` on the lifecycle events it publishes (e.g. session.archived).
 */
export const PRODUCER_IDS = { host: "trevor-host", web: "trevor-web", cli: "trevor-cli" } as const;
export type ProducerId = (typeof PRODUCER_IDS)[keyof typeof PRODUCER_IDS];

/**
 * The lease roles that ride `host.role` and that the web reads to tell the answering
 * leader from standbys. The lease adds a private "probing" start state on top of these
 * (see LeaseRole), but only these two cross the wire and reach the UI.
 */
export const HOST_ROLE = { leader: "leader", standby: "standby" } as const;
export type HostRole = (typeof HOST_ROLE)[keyof typeof HOST_ROLE];

/**
 * A pure, dependency-free 32-bit FNV-1a hash, rendered as 8 lowercase hex chars. Used to make a
 * project's session id collision-resistant on the full path (two repos sharing a basename still get
 * distinct ids). Deliberately NOT a crypto hash: this module is bundled into the browser, so it must
 * stay free of `node:crypto`; FNV-1a is more than enough to separate local project directories.
 */
export function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function idSlug(text: string, fallback: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  );
}

/**
 * Derives a stable, URL-safe session id from a canonical (absolute, resolved) project root: a
 * human-readable slug of the directory basename plus the short path hash. The slug strips everything
 * but lowercase alphanumerics (collapsing the rest to single dashes), so the id can never contain a
 * slash, space, or other character that would break a `?session=<id>` URL or a storage key. Stable
 * for a given root (the launcher reopens the same project into the same session) and distinct across
 * roots (the hash separates same-named directories under different parents). Source: D-085.
 */
export function projectSessionId(root: string): string {
  const base =
    root
      .split(/[/\\]+/)
      .filter(Boolean)
      .pop() ?? "project";
  const slug = idSlug(base, "project");
  return `${slug}-${shortHash(root)}`;
}

export interface FreshSessionIdOptions {
  readonly now?: Date;
  readonly random?: string;
  readonly prefix?: string;
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/**
 * Mints a URL-safe, human-scannable conversation id for a fresh durable session. The UTC stamp makes
 * screenshots identifiable at a glance, while the entropy hash keeps two clears in the same second
 * distinct. This is intentionally session identity, not project identity.
 */
export function freshSessionId(options: FreshSessionIdOptions = {}): string {
  const now = options.now ?? new Date();
  const random = options.random ?? crypto.randomUUID();
  const prefix = idSlug(options.prefix ?? "trevor", "trevor");
  const stamp = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}-${pad2(
    now.getUTCHours(),
  )}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}z`;

  return `${prefix}-${stamp}-${shortHash(random)}`;
}

/**
 * Encodes the participant identity + replay cursor as the `/sessions/{id}/stream`
 * query params, and `decodeStreamParams` reads them back. The client builder and the
 * store's parser share this one codec so a renamed/added identity field can't silently
 * desync them - the store would otherwise read an empty string and drop the host from
 * presence. It lives here, beside the identity vocabulary it serializes, so the names
 * have a single owner. NOTE: these names are also the wire contract the external Richter
 * service implements, so a participant reaches either backend unchanged; centralizing
 * removes client<->local-store drift but does NOT make the names free to rename
 * unilaterally.
 */
export function encodeStreamParams(identity: SessionIdentity, afterSeq: number): URLSearchParams {
  const params = new URLSearchParams();
  params.set("after", String(afterSeq));
  params.set("capabilities", JSON.stringify(identity.capabilities ?? {}));
  params.set("displayName", identity.displayName);
  params.set("instanceId", identity.instanceId);
  params.set("participantId", identity.participantId);
  params.set("runtimeKind", identity.runtimeKind);
  return params;
}

/** Parses the stream query params back into an identity + cursor (see encodeStreamParams). */
export function decodeStreamParams(params: URLSearchParams): {
  readonly identity: SessionIdentity;
  readonly afterSeq: number;
} {
  let capabilities: Record<string, unknown> = {};
  try {
    capabilities = JSON.parse(params.get("capabilities") ?? "{}") as Record<string, unknown>;
  } catch {
    capabilities = {};
  }
  return {
    afterSeq: Number(params.get("after") ?? 0) || 0,
    identity: {
      displayName: params.get("displayName") ?? "",
      runtimeKind: params.get("runtimeKind") ?? "",
      instanceId: params.get("instanceId") ?? "",
      participantId: params.get("participantId") ?? "",
      capabilities,
    },
  };
}
