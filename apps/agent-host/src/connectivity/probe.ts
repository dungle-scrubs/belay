import type { Fields } from "@host/transport/log";
import {
  type InternetSnapshot,
  type InternetStatus,
  isSnapshotStale,
  UNKNOWN_INTERNET,
} from "@trevor/session";

/**
 * The host-owned internet probe (D-060 M1): a small DNS + HTTPS reachability check against
 * CONFIGURED public endpoints, projected to an {@link InternetSnapshot}. The host machine is the
 * source of truth - this is its view of the PUBLIC internet, deliberately independent of provider
 * health, the session store, and the browser. The IO (DNS resolve, HTTPS reach) is injected so the
 * decision logic is deterministic and testable; the live host supplies node `dns` + `fetch` impls.
 */

/** Configured probe targets (a public DNS name + a public HTTPS URL), and whether probing is on. */
export interface ProbeTargets {
  readonly dnsHost: string;
  readonly httpsUrl: string;
  readonly enabled: boolean;
}

/** The injected probe IO: DNS resolution (throws on failure) and an HTTPS reachability check. */
export interface ProbeIo {
  readonly resolveDns: (host: string) => Promise<void>;
  /** True when the URL answered with a non-error status; false on an error status; throws on a
   *  transport failure (offline, reset, timeout). */
  readonly httpsReachable: (url: string) => Promise<boolean>;
  readonly now: () => string;
}

/** A structured probe log line: a level + message + flat redacted fields for the host log sink. */
export interface ProbeLogLine {
  readonly level: "info" | "warn";
  readonly message: string;
  readonly fields: Fields;
}

export function probeLogLine(prev: InternetSnapshot, next: InternetSnapshot): ProbeLogLine | null {
  if (next.checking) {
    return null;
  }
  const changed = prev.status !== next.status;
  const failed = next.status === "offline" && next.error != null;
  if (!changed && !failed) {
    return null;
  }

  const fields: Fields = {
    status: next.status,
    targetClass: next.targetClass,
    checkedAt: next.checkedAt,
  };
  if (changed) {
    fields.previous = prev.status;
  }
  if (next.error != null) {
    fields.error = next.error;
  }
  return {
    level: next.status === "offline" ? "warn" : "info",
    message: changed ? "internet status changed" : "internet probe failed",
    fields,
  };
}

/**
 * Runs one probe and returns a settled snapshot. Online requires BOTH the DNS resolve and the HTTPS
 * reach to succeed; any failure (LAN-up/WAN-down, captive portal, reset) reads as offline with a
 * SANITIZED reason (never the endpoint). A disabled probe returns `unknown`, never an assumed offline.
 */
export async function probeInternet(targets: ProbeTargets, io: ProbeIo): Promise<InternetSnapshot> {
  const checkedAt = io.now();

  if (!targets.enabled) {
    return {
      status: "unknown",
      checking: false,
      checkedAt,
      error: "probe disabled",
      targetClass: "none",
    };
  }

  const errors: string[] = [];
  let dnsOk = false;
  try {
    await io.resolveDns(targets.dnsHost);
    dnsOk = true;
  } catch {
    errors.push("DNS lookup failed");
  }

  let httpsOk = false;
  try {
    httpsOk = await io.httpsReachable(targets.httpsUrl);
    if (!httpsOk) {
      errors.push("HTTPS probe returned an error status");
    }
  } catch {
    errors.push("HTTPS probe failed");
  }

  const status: InternetStatus = dnsOk && httpsOk ? "online" : "offline";
  return {
    status,
    checking: false,
    checkedAt,
    error: status === "online" ? null : errors.join("; ") || "public internet unreachable",
    targetClass: "dns+https",
  };
}

/**
 * A bounded internet monitor (D-060 M2): holds the latest snapshot, caches it for `cacheMs` to avoid
 * constant network checks, dedupes concurrent refreshes, and emits each transition (a `checking`
 * start and the settled result) through `onChange` so the host can publish `host.internet`. A probe
 * never throws out of here - a failed probe settles `checking` back off, keeping the prior status.
 */
export class InternetMonitor {
  private snapshot: InternetSnapshot = UNKNOWN_INTERNET;
  private inFlight: Promise<InternetSnapshot> | null = null;

  constructor(
    private readonly probe: () => Promise<InternetSnapshot>,
    private readonly cacheMs: number,
    private readonly nowMs: () => number,
    private readonly onChange: (snapshot: InternetSnapshot) => void = () => {},
    private readonly onLogLine: (line: ProbeLogLine) => void = () => {},
  ) {}

  current(): InternetSnapshot {
    return this.snapshot;
  }

  isStale(): boolean {
    return isSnapshotStale(this.snapshot, this.nowMs(), this.cacheMs);
  }

  /** Forces a probe now (used by an explicit UI refresh), exposing `checking` while it runs. */
  refresh(): Promise<InternetSnapshot> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.set({ ...this.snapshot, checking: true });
    this.inFlight = this.probe()
      .then((next) => {
        this.inFlight = null;
        this.set(next);
        return next;
      })
      .catch(() => {
        this.inFlight = null;
        const settled = { ...this.snapshot, checking: false };
        this.set(settled);
        return settled;
      });
    return this.inFlight;
  }

  /** Refreshes only when the cached snapshot is stale (the ~30s cache); a no-op otherwise. */
  refreshIfStale(): Promise<InternetSnapshot> {
    if (this.snapshot.checking || !this.isStale()) {
      return Promise.resolve(this.snapshot);
    }
    return this.refresh();
  }

  private set(snapshot: InternetSnapshot): void {
    const previous = this.snapshot;
    this.snapshot = snapshot;
    const line = probeLogLine(previous, snapshot);
    if (line) {
      this.onLogLine(line);
    }
    this.onChange(snapshot);
  }
}
