import type {
  DoctorArea,
  DoctorAreaId,
  DoctorFinding,
  DoctorNextAction,
  DoctorStatus,
} from "@trevor/session";
import { area } from "./area";
import type { DoctorProbeInput, DoctorWebDocs, PeripheralState } from "./probe-input";

/**
 * The connectivity + integration areas of the /doctor grid (D-073): Internet (the binary
 * online/offline advisory, D-060), Web / Docs (web-search key presence, the web_fetch backend
 * ladder, docs-cache freshness, plan 04), and the peripheral subsystems (MCP / LSP / Hooks) mapped
 * from their lifecycle states. Redaction-safe: booleans, enums, and sanitized error categories only,
 * never a key value.
 *
 * Responsible for: the Internet, Web/Docs, and MCP/LSP/Hooks areas.
 * Not for: the host/session, provider, or platform areas - its sibling areas-* modules.
 */

export function internetArea(input: DoctorProbeInput): DoctorArea {
  const snap = input.internet;
  const status: DoctorStatus =
    snap.status === "online" ? "ok" : snap.status === "offline" ? "warn" : "not_checked";
  // Binary by design - just "am I online?". The verdict is one word; the probe mechanics (DNS+HTTPS,
  // the sanitized error) live as collapsed facts for debugging, not in the resting line, and there is
  // no redundant finding row repeating the verdict.
  const verdict =
    snap.status === "online" ? "online" : snap.status === "offline" ? "offline" : "not checked";
  const facts: DoctorArea["facts"] = [
    ...(snap.checkedAt ? [{ label: "checked", value: snap.checkedAt }] : []),
    ...(snap.status === "offline" && snap.error
      ? [{ label: "detail", value: snap.error, status: "warn" as const }]
      : []),
  ];
  return area("internet", "Internet", verdict, [], facts, status);
}

/** The docs-cache finding: ok when fresh, warn when stale (with a refresh action), else not_checked. */
function docsFinding(docs: DoctorWebDocs["docs"]): DoctorFinding {
  if (!docs.present) {
    return {
      id: "web.docs",
      status: "not_checked",
      title: "Docs cache",
      message: "No docs cache is present.",
    };
  }
  if (docs.stale) {
    return {
      id: "web.docs",
      status: "warn",
      title: "Docs cache",
      message: "The docs cache is stale.",
      nextAction: { label: "Refresh the docs cache" },
    };
  }
  return {
    id: "web.docs",
    status: "ok",
    title: "Docs cache",
    message: "The docs cache is present and fresh.",
  };
}

/**
 * The web_fetch backend-ladder finding (plan 04): static is always available, so the ladder is never
 * "unconfigured"; the message reports each backend's readiness (Jina available vs keyed, Firecrawl
 * configured vs unconfigured) and appends the sanitized last-backend error category when one has been
 * observed. Reads only enums + an error category, never a key value, so the area stays redaction-safe.
 */
function webFetchFinding(fetch: DoctorWebDocs["fetch"]): DoctorFinding {
  const jina = fetch.jina === "keyed" ? "Jina keyed" : "Jina available";
  const firecrawl =
    fetch.firecrawl === "configured" ? "Firecrawl configured" : "Firecrawl unconfigured";
  const ladder = `static, ${jina}, ${firecrawl}`;
  const message = fetch.lastError
    ? `Backend ladder ready (${ladder}). Last backend error: ${fetch.lastError}.`
    : `Backend ladder ready (${ladder}).`;
  return {
    id: "web.fetch",
    status: "ok",
    title: "Web fetch",
    message,
    ...(fetch.firecrawl === "unconfigured"
      ? { nextAction: { label: "Set FIRECRAWL_API_KEY to enable the rendered fallback" } }
      : {}),
  };
}

/**
 * Builds the Web / Docs area (D-073, plan 04) from {@link DoctorWebDocs} config facts: web-search key
 * presence, the web_fetch backend ladder's readiness, and docs-cache staleness. Redaction-safe by
 * construction - it reads only booleans/enums + a sanitized error category, never a key value. An
 * unconfigured web-search key is `not_checked` (not an error); the fetch ladder is always ready
 * (static needs no config); a stale docs cache warns.
 */
export function webDocsArea(input: DoctorProbeInput): DoctorArea {
  const w = input.web;
  const findings: DoctorFinding[] = [
    w.searchConfigured
      ? {
          id: "web.search",
          status: "ok",
          title: "Web search",
          message: "A web-search provider key is configured.",
        }
      : {
          id: "web.search",
          status: "not_checked",
          title: "Web search",
          message: "No web-search provider key is configured.",
          nextAction: { label: "Set BRAVE_API_KEY or SERPER_API_KEY to enable web_search" },
        },
    webFetchFinding(w.fetch),
    docsFinding(w.docs),
  ];
  const statuses = findings.map((f) => f.status);
  const verdict = statuses.every((s) => s === "not_checked")
    ? "Web/docs tools are not configured."
    : statuses.includes("warn")
      ? "Some web/docs state needs attention."
      : "Web/docs tools are configured.";
  return area("web", "Web / Docs", verdict, findings);
}

/**
 * Builds a peripheral-subsystem area (MCP / LSP / Hooks, D-073) from its {@link PeripheralState}.
 * Maps each state to a status + verdict + next action: `unconfigured`/`timeout` stay `not_checked`
 * (nothing wrong / degraded, never a false error), `ready` is `ok`, `unavailable`/`auth-needed` warn
 * with a repair action, and `error` is an error with an inspect action. Pure, so the mapping is
 * unit-tested for every state.
 */
export function peripheralArea(
  id: DoctorAreaId,
  label: string,
  state: PeripheralState,
): DoctorArea {
  let status: DoctorStatus;
  let message: string;
  let nextAction: DoctorNextAction | undefined;
  switch (state.kind) {
    case "unconfigured":
      status = "not_checked";
      message = `${label} is not configured.`;
      break;
    case "ready":
      status = "ok";
      message = state.detail;
      break;
    case "unavailable":
      status = "warn";
      message = state.detail ?? `${label} is configured but unavailable.`;
      nextAction = { label: `Check the ${label} integration` };
      break;
    case "auth-needed":
      status = "warn";
      message = state.detail ?? `${label} needs authentication.`;
      nextAction = { label: `Authenticate ${label}` };
      break;
    case "error":
      status = "error";
      message = state.detail ?? `${label} reported an error.`;
      nextAction = { label: `Inspect the ${label} integration` };
      break;
    case "timeout":
      status = "not_checked";
      message = state.detail ?? `${label} check timed out.`;
      nextAction = { label: "Re-run /doctor to retry" };
      break;
  }
  const finding: DoctorFinding = {
    id: `${id}.status`,
    status,
    title: label,
    message,
    ...(nextAction ? { nextAction } : {}),
  };
  return area(id, label, message, [finding]);
}
