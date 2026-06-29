/**
 * The SSRF guard for every web_fetch backend (static now; Jina/Firecrawl/docs later). It rejects a
 * URL before any network IO: non-http(s) schemes, malformed URLs, embedded userinfo, and any host
 * that is - or resolves to - loopback, a private range, link-local, IPv6 unique-local, or the cloud
 * metadata IP. A hostname is checked against an injected DNS resolver so a public-looking name that
 * points at a private address is still blocked; resolution that fails or is unavailable degrades to
 * "unknown" and rejects rather than fetching blind. Pure and resolver-injectable so it is reusable
 * and deterministically testable.
 */

/** Resolves a hostname to its IP literals. Injected so tests are deterministic and so a backend can
 *  supply the real DNS lookup. Returning an empty array means "no addresses found". */
export type ResolveHost = (host: string) => readonly string[];

/** A URL the guard refused, carrying a sanitized reason (host/scheme only, never credentials). */
export class UnsafeUrlError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "UnsafeUrlError";
  }
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Parses and validates `raw`, returning the safe `URL` or throwing `UnsafeUrlError`. When
 * `resolveHost` is supplied, a hostname (not already an IP literal) is resolved and every
 * returned address is checked too. Resolution throwing or returning nothing rejects as "unknown".
 */
export function assertSafeUrl(raw: string, resolveHost?: ResolveHost): URL {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("malformed URL");
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new UnsafeUrlError(`unsupported scheme "${url.protocol}"`);
  }

  // Embedded credentials (`user:pass@host`) mark an authenticated-browsing intent web_fetch refuses,
  // and are a classic SSRF-confusion vector, so reject before touching the host.
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeUrlError("URL must not carry userinfo (user:pass@)");
  }

  const host = hostnameWithoutBrackets(url.hostname);

  if (host === "") {
    throw new UnsafeUrlError("URL has no host");
  }

  assertSafeHost(host, resolveHost);

  return url;
}

/** Strips the `[...]` IPv6 brackets `URL.hostname` keeps, leaving a bare address or name. */
function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function assertSafeHost(host: string, resolveHost: ResolveHost | undefined): void {
  const lower = host.toLowerCase();

  if (lower === "localhost" || lower.endsWith(".localhost")) {
    throw new UnsafeUrlError("loopback host is not allowed");
  }

  const literal = classifyAddress(host);

  if (literal === "unsafe") {
    throw new UnsafeUrlError(`private or local address "${host}" is not allowed`);
  }

  // A literal IP is fully decided by its own classification; no DNS step applies.
  if (literal === "safe") {
    return;
  }

  // A hostname: resolve it (when a resolver is injected) and block if ANY address is unsafe, so a
  // public-looking name pointed at a private IP can't slip a fetch through.
  if (!resolveHost) {
    return;
  }

  let addresses: readonly string[];

  try {
    addresses = resolveHost(host);
  } catch {
    throw new UnsafeUrlError(`could not resolve host "${host}" (unknown safety)`);
  }

  if (addresses.length === 0) {
    throw new UnsafeUrlError(`could not resolve host "${host}" (unknown safety)`);
  }

  for (const address of addresses) {
    if (classifyAddress(address) !== "safe") {
      throw new UnsafeUrlError(`host "${host}" resolves to a private or local address`);
    }
  }
}

/** "safe"/"unsafe" for an IP literal; "hostname" when `value` is not an IP and needs DNS. */
function classifyAddress(value: string): "safe" | "unsafe" | "hostname" {
  const v4 = parseIpv4(value);

  if (v4) {
    return isUnsafeIpv4(v4) ? "unsafe" : "safe";
  }

  if (looksLikeIpv6(value)) {
    return isUnsafeIpv6(value) ? "unsafe" : "safe";
  }

  return "hostname";
}

function parseIpv4(value: string): readonly number[] | undefined {
  const parts = value.split(".");

  if (parts.length !== 4) {
    return undefined;
  }

  const octets: number[] = [];

  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return undefined;
    }

    const octet = Number(part);

    if (octet > 255) {
      return undefined;
    }

    octets.push(octet);
  }

  return octets;
}

function isUnsafeIpv4(octets: readonly number[]): boolean {
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;

  // Loopback 127.0.0.0/8.
  if (a === 127) return true;
  // Private 10.0.0.0/8.
  if (a === 10) return true;
  // Private 172.16.0.0/12.
  if (a === 172 && b >= 16 && b <= 31) return true;
  // Private 192.168.0.0/16.
  if (a === 192 && b === 168) return true;
  // Link-local 169.254.0.0/16 (covers the cloud metadata IP 169.254.169.254).
  if (a === 169 && b === 254) return true;
  // "This host" 0.0.0.0/8 (an unspecified-address SSRF target).
  if (a === 0) return true;
  // Carrier-grade NAT 100.64.0.0/10.
  if (a === 100 && b >= 64 && b <= 127) return true;

  return false;
}

function looksLikeIpv6(value: string): boolean {
  return value.includes(":");
}

function isUnsafeIpv6(value: string): boolean {
  const lower = value.toLowerCase();

  // Loopback ::1 and unspecified ::.
  if (lower === "::1" || lower === "::") return true;

  const head = lower.split("%")[0] ?? lower;

  // IPv4-mapped dotted form (::ffff:a.b.c.d): classify on the embedded IPv4.
  const dotted = head.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);

  if (dotted?.[1]) {
    const v4 = parseIpv4(dotted[1]);
    return v4 ? isUnsafeIpv4(v4) : true;
  }

  // IPv4-mapped hex form (::ffff:HHHH:HHHH) - the shape `URL.hostname` normalizes the dotted form
  // to - reconstruct the embedded IPv4 from the last two hextets and classify on it.
  const hexMapped = head.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);

  if (hexMapped?.[1] && hexMapped[2]) {
    const high = Number.parseInt(hexMapped[1], 16);
    const low = Number.parseInt(hexMapped[2], 16);
    const v4 = [high >> 8, high & 0xff, low >> 8, low & 0xff];

    return isUnsafeIpv4(v4);
  }

  const firstHextet = head.split(":")[0] ?? "";
  const group = Number.parseInt(firstHextet || "0", 16);

  // Link-local fe80::/10.
  if ((group & 0xffc0) === 0xfe80) return true;
  // Unique-local fc00::/7.
  if ((group & 0xfe00) === 0xfc00) return true;

  return false;
}

/** A single redirect hop the guard inspects before it is followed. */
export interface RedirectHop {
  readonly from: URL;
  readonly to: string;
}

/**
 * Validates one redirect hop's target through the same guard, plus two redirect-specific rules:
 * a redirect must never DOWNGRADE the scheme (https -> http), and it must not revisit a URL already
 * seen on the chain (loop). `seen` is the set of canonical hrefs visited so far. Returns the safe
 * resolved target URL or throws `UnsafeUrlError`.
 */
export function assertSafeRedirect(
  hop: RedirectHop,
  seen: ReadonlySet<string>,
  resolveHost?: ResolveHost,
): URL {
  let target: URL;

  try {
    target = new URL(hop.to, hop.from);
  } catch {
    throw new UnsafeUrlError("malformed redirect target");
  }

  if (hop.from.protocol === "https:" && target.protocol === "http:") {
    throw new UnsafeUrlError("redirect downgrades https to http");
  }

  const safe = assertSafeUrl(target.toString(), resolveHost);

  if (seen.has(safe.toString())) {
    throw new UnsafeUrlError("redirect loop detected");
  }

  return safe;
}
