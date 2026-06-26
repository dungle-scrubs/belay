import { lookup } from "node:dns/promises";
import type { ProbeIo, ProbeTargets } from "./probe";

/**
 * The live node probe IO (D-060): DNS via `node:dns` and an HTTPS reachability check via `fetch`,
 * each bounded by a short timeout so a wedged network degrades to offline rather than hanging. The
 * targets are configurable via env so an operator can point at their own endpoints; the decision
 * logic stays in {@link probeInternet}, which this only feeds.
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

/** Races a promise against a timeout, rejecting if it does not settle in time. */
function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return run(controller.signal).finally(() => clearTimeout(timer));
}

export const nodeProbeIo: ProbeIo = {
  resolveDns: (host) =>
    withTimeout(async () => {
      await lookup(host);
    }, PROBE_TIMEOUT_MS),
  httpsReachable: (url) =>
    withTimeout(async (signal) => {
      // HEAD keeps it cheap; a non-error status (2xx/3xx) means the public endpoint answered us.
      const response = await fetch(url, { method: "HEAD", signal, redirect: "manual" });
      return response.status >= 200 && response.status < 400;
    }, PROBE_TIMEOUT_MS),
  now: () => new Date().toISOString(),
};
