import { lookup } from "node:dns/promises";
import { raceTimeout } from "@trevor/session/async";
import type { ProbeIo, ProbeTargets } from "./probe";

/**
 * The live node probe IO (D-060): DNS via `node:dns` and an HTTPS reachability check via `fetch`,
 * each bounded by a short timeout so a wedged network degrades to offline rather than hanging. The
 * targets are configurable via env so an operator can point at their own endpoints; the decision
 * logic stays in {@link probeInternet}, which this only feeds.
 *
 * Responsible for: live probe IO - timeout-bounded DNS + HTTPS checks, env-configured targets.
 * Not for: the online/offline decision and the monitor - probe.ts.
 */

/** Per-check timeout: a slow/blackholed network settles as offline instead of hanging the probe. */
const PROBE_TIMEOUT_MS = 4_000;

/** The configured probe targets, from env or public defaults. `TREVOR_INTERNET_PROBE=0` disables it. */
export function defaultProbeTargets(): ProbeTargets {
  return {
    dnsHost: process.env.TREVOR_INTERNET_DNS ?? "cloudflare.com",
    httpsUrl: process.env.TREVOR_INTERNET_URL ?? "https://www.cloudflare.com/cdn-cgi/trace",
    enabled: process.env.TREVOR_INTERNET_PROBE !== "0",
  };
}

export const nodeProbeIo: ProbeIo = {
  resolveDns: (host) =>
    raceTimeout(async () => {
      await lookup(host);
    }, PROBE_TIMEOUT_MS),
  httpsReachable: (url) =>
    raceTimeout(async (signal) => {
      // ANY HTTP response means we reached the public endpoint over HTTPS - the network is up. The
      // status itself doesn't matter (a 404/405 still proves connectivity); only a thrown fetch (DNS
      // failure, connection refused, TLS error, timeout) is "unreachable". GET, not HEAD: some
      // endpoints (e.g. Cloudflare's /cdn-cgi/trace) 404 a HEAD, which used to read as a false offline.
      await fetch(url, { method: "GET", signal, redirect: "manual" });
      return true;
    }, PROBE_TIMEOUT_MS),
  now: () => new Date().toISOString(),
};
