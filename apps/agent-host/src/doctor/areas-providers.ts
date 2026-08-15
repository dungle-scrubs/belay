import type { DoctorArea, DoctorFact, DoctorFinding, DoctorNextAction } from "@belay/session";
import type { ProviderIncidentCategory } from "../providers/provider-incidents";
import { area } from "./area";
import type { DoctorCatalogSource, DoctorProbeInput } from "./probe-input";

/**
 * The Providers / Models / Auth area of the /doctor grid: per-provider reachability, the recent
 * terminal provider-failure counts (D-076 M6), the latest categorized incident per provider (D-007),
 * and the D-065 catalog sources that need auth/setup - plus the catalog overview and
 * unclassified-observation facts. Redaction-safe by construction: statuses, counts, and sanitized
 * one-liners only, never a key value.
 *
 * Responsible for: the Providers area - reachability, failure outcomes, incidents, catalog sources.
 * Not for: probing providers - build.ts - or the other grid areas - its sibling areas-* modules.
 */

/**
 * The four actionable provider-incident categories (D-007), each with the finding title, one-line
 * verdict, and repair action it drives. Provider-neutral: the category is a typed value the loop
 * derived, never a DeepSeek-specific string, so a new provider with the same failure shape reuses
 * the same finding copy. The leaked/upstream detail rides as the finding's collapsed evidence.
 */
const INCIDENT_CATEGORY: Record<
  ProviderIncidentCategory,
  { readonly title: string; readonly message: string; readonly nextAction?: DoctorNextAction }
> = {
  auth_quota: {
    title: "Provider auth / quota",
    message: "The last turn failed on a credential or quota/billing error.",
    nextAction: { label: "Re-authenticate or check the provider's billing/quota" },
  },
  transport: {
    title: "Provider transport failure",
    message: "The last turn was interrupted by a transient provider transport error.",
    nextAction: { label: "Retry the turn; if it persists, check provider/internet status" },
  },
  malformed_protocol: {
    title: "Malformed provider protocol",
    message: "The model rendered raw tool-call markup as text instead of a typed tool call.",
    nextAction: { label: "Inspect provider diagnostics or switch models before retrying" },
  },
  unsafe_retry: {
    title: "Unsafe partial-stream retry",
    message:
      "A provider stream dropped after partial output, so the turn could not be auto-retried.",
    nextAction: { label: "Retry the turn manually; partial output was not replayed" },
  },
};

export function providersArea(input: DoctorProbeInput): DoctorArea {
  const findings: DoctorFinding[] = input.providers.map((p) => ({
    id: `providers.${p.key}`,
    status: p.status === "unreachable" ? (p.kind === "local" ? "warn" : "error") : "ok",
    title: `${p.label} (${p.model})`,
    message:
      p.status === "unreachable"
        ? p.kind === "local"
          ? "runtime not reachable (start it to use this model)"
          : "unreachable"
        : p.status,
    ...(p.status === "unreachable" && p.kind === "local"
      ? { nextAction: { label: "Start the local runtime (LM Studio)" } }
      : {}),
  }));
  // Recent terminal provider-failure outcomes (D-076 M6) as two SEPARATE findings: retry exhaustion
  // (a transient outage Belay auto-retried and still couldn't recover) is distinct from a
  // non-retryable terminal failure (auth/quota/rejected - never eligible for retry). Each is shown
  // only when it has happened, so a clean session adds neither.
  const pf = input.providerFailures;
  if (pf && pf.retryExhausted > 0) {
    findings.push({
      id: "providers.retryExhausted",
      status: "warn",
      title: "Provider retry exhaustion",
      message: `${pf.retryExhausted} turn${pf.retryExhausted === 1 ? "" : "s"} exhausted the auto-reconnect budget on a transient provider outage.`,
      ...(pf.lastRetryExhausted ? { evidence: pf.lastRetryExhausted } : {}),
      nextAction: { label: "Retry the turn; if it persists, check provider/internet status" },
    });
  }
  if (pf && pf.nonRetryableTerminal > 0) {
    findings.push({
      id: "providers.terminal",
      status: "warn",
      title: "Non-retryable provider failure",
      message: `${pf.nonRetryableTerminal} turn${pf.nonRetryableTerminal === 1 ? "" : "s"} ended with a terminal provider failure that was not eligible for retry.`,
      ...(pf.lastTerminal ? { evidence: pf.lastTerminal } : {}),
    });
  }
  // The LATEST incident per provider (D-007), categorized into the four actionable buckets
  // (auth/quota, transport, malformed protocol, unsafe retry). One finding per provider that has had
  // an incident; the sanitized upstream detail rides as collapsed evidence. Distinct from the COUNTS
  // above - this names what the last failure actually was and what to do about it.
  for (const incident of input.providerIncidents ?? []) {
    const category = INCIDENT_CATEGORY[incident.category];
    findings.push({
      id: `providers.incident.${incident.provider}`,
      status: "warn",
      title: `${category.title} - ${incident.provider}`,
      message: category.message,
      evidence: incident.detail,
      ...(category.nextAction ? { nextAction: category.nextAction } : {}),
    });
  }
  // D-065 catalog source auth/config state: surface the sources that need ACTION. The legacy roster
  // above lists only configured runnable providers, so a needs-auth / expired / rejected source would
  // otherwise be invisible in /doctor. Status + counts only - a key never enters a finding.
  const catalog = input.catalogSources ?? [];
  // One predicate drives BOTH the per-source findings and the "N ready / M need setup" overview, so
  // the count can never disagree with the findings shown.
  const needsSetup = (s: DoctorCatalogSource): boolean =>
    s.status === "error" || s.status === "needs-auth" || s.auth === "none" || s.auth === "expired";
  for (const s of catalog) {
    if (!needsSetup(s)) {
      continue;
    }
    const errored = s.status === "error";
    const expired = s.auth === "expired";
    const nextAction: DoctorNextAction =
      s.type === "oauth"
        ? { label: `Sign in to ${s.label}` }
        : s.type === "local"
          ? { label: `Start the ${s.label} runtime` }
          : { label: `Add the ${s.label} key to ~/.pi/auth.json` };
    findings.push({
      id: `providers.source.${s.sourceId}`,
      status: errored ? "error" : "warn",
      title: `${s.label} source`,
      message: errored
        ? "the configured key was rejected by the provider"
        : expired
          ? "the sign-in has expired - re-authenticate"
          : "not configured - no key or sign-in present",
      nextAction,
    });
  }

  const sourceCount = input.providers.length;
  const verdict = sourceCount
    ? `${sourceCount} source${sourceCount === 1 ? "" : "s"}`
    : "no providers";

  const facts: DoctorFact[] = [];
  // A one-line catalog overview (D-065): how many sources are ready vs need setup, and the total live
  // model count across configured sources. Counts only - this is the source/catalog picture the
  // legacy roster can't give (it omits unconfigured sources entirely).
  if (catalog.length > 0) {
    const setupCount = catalog.filter(needsSetup).length;
    const ready = catalog.length - setupCount;
    const models = catalog.reduce((total, s) => total + s.modelCount, 0);
    facts.push({
      label: "catalog",
      value: `${catalog.length} source${catalog.length === 1 ? "" : "s"} (${ready} ready${setupCount ? `, ${setupCount} need setup` : ""}) · ${models} model${models === 1 ? "" : "s"}`,
    });
  }
  // Unclassified-failure observations (D-076 M6): a redacted diagnostic FACT (counts only), so it
  // informs without inflating the area severity - an unknown shape isn't a current health problem,
  // it's a breadcrumb for improving the classifier. Omitted entirely when nothing has been observed.
  const obs = input.observations;
  if (obs && obs.distinct > 0) {
    // The busiest shape id is a stable fingerprint (hex), useful for correlating with the structured
    // failure log; it carries no message, auth, or payload value, so it stays inside the redacted fact.
    const busiest = obs.top?.[0];
    const topSuffix = busiest ? ` · top ${busiest.fingerprint}×${busiest.count}` : "";
    facts.push({
      label: "observations",
      value: `${obs.distinct} unclassified shape${obs.distinct === 1 ? "" : "s"} · ${obs.unknown} sighting${obs.unknown === 1 ? "" : "s"}${topSuffix}`,
    });
  }
  return area(
    "providers",
    "Providers / Models / Auth",
    verdict,
    findings,
    facts.length > 0 ? facts : undefined,
  );
}
