/**
 * Fixture `doctor.current` payloads for the Storybook stories. These stand in
 * for the host snapshot until D-073 wires real probes: one variant per area
 * state, plus assembled snapshots (healthy, mixed, many findings, not checked,
 * stale, long paths). Shared by the dashboard and area-card stories.
 *
 * Content is Trevor-flavoured on purpose - qwen local + gpt cloud, the
 * ~/.trevorV2 / ~/.pi roots, rg + ast-grep, Firecrawl - so the
 * layout is exercised against believable text lengths.
 */
import {
  DOCTOR_AREA_ORDER,
  type DoctorArea,
  type DoctorHostContext,
  type DoctorSnapshot,
  type DoctorSnapshotState,
} from "@trevor/session";

export const HOST: DoctorHostContext = {
  workspace: "~/dev/trevorV2/apps/agent-host",
  instanceId: "1d8e680d",
  role: "leader",
};

// --- Core ------------------------------------------------------------------

export const coreOk: DoctorArea = {
  id: "core",
  label: "Core",
  status: "ok",
  verdict: "Host online and serving turns.",
  facts: [
    { label: "host", value: "1d8e680d" },
    { label: "role", value: "leader", status: "ok" },
    { label: "uptime", value: "2h 14m" },
    { label: "build", value: "v2.0.0-dev (a1c3f90)" },
  ],
};

// --- Session / Run ---------------------------------------------------------

export const sessionOk: DoctorArea = {
  id: "session",
  label: "Session / Run",
  status: "ok",
  verdict: "No active run; last turn completed cleanly.",
  facts: [
    { label: "run", value: "idle" },
    { label: "last turn", value: "assistant.completed · 3.2s" },
    { label: "context", value: "18% of 64k" },
  ],
};

export const sessionStuck: DoctorArea = {
  id: "session",
  label: "Session / Run",
  status: "warn",
  verdict: "Active run has been waiting on a tool for 90s.",
  facts: [
    { label: "run", value: "running", status: "warn" },
    { label: "context", value: "31% of 64k" },
  ],
  findings: [
    {
      id: "session.run.stalled",
      status: "warn",
      title: "Turn waiting on bash",
      message: "The current run has been blocked on a single tool call for 90s with no output.",
      evidence: "runId: 7f2a91c4\nstep: 12/40\ntool: bash\ncommand: pnpm test\nelapsed: 90.4s",
      nextAction: { label: "Interrupt the run, then retry", command: "Esc" },
    },
  ],
};

// --- Providers / Models / Auth ---------------------------------------------

export const providersWarm: DoctorArea = {
  id: "providers",
  label: "Providers / Models / Auth",
  status: "ok",
  verdict: "2 providers reachable and warm.",
  facts: [
    { label: "qwen", value: "Qwen (local) · warm", status: "ok" },
    { label: "gpt", value: "GPT-5.5 (cloud) · warm", status: "ok" },
  ],
};

export const providersAuthMissing: DoctorArea = {
  id: "providers",
  label: "Providers / Models / Auth",
  status: "error",
  verdict: "Cloud provider has no API key.",
  facts: [
    { label: "qwen", value: "Qwen (local) · warm", status: "ok" },
    { label: "gpt", value: "GPT-5.5 (cloud) · no auth", status: "error" },
  ],
  findings: [
    {
      id: "providers.gpt.auth",
      status: "error",
      title: "GPT-5.5 missing API key",
      message: "No credentials resolved for the cloud provider, so cloud turns will fail.",
      source: "~/.trevorV2/.env.op",
      nextAction: { label: "Add the key, then reload", command: "opchain primary --read op run" },
    },
  ],
};

export const providersCloudUnreachable: DoctorArea = {
  id: "providers",
  label: "Providers / Models / Auth",
  status: "error",
  verdict: "Cloud provider unreachable.",
  facts: [
    { label: "qwen", value: "Qwen (local) · warm", status: "ok" },
    { label: "gpt", value: "GPT-5.5 (cloud) · unreachable", status: "error" },
  ],
  findings: [
    {
      id: "providers.gpt.unreachable",
      status: "error",
      title: "GPT-5.5 unreachable",
      message: "The last readiness probe to the cloud endpoint failed.",
      evidence: "GET https://api.openai.com/v1/models\nError: ETIMEDOUT after 5000ms",
      nextAction: { label: "Check network and provider status" },
    },
  ],
};

export const providersLocalUnreachable: DoctorArea = {
  id: "providers",
  label: "Providers / Models / Auth",
  status: "warn",
  verdict: "Local runtime not responding; cloud still available.",
  facts: [
    { label: "qwen", value: "Qwen (local) · unreachable", status: "warn" },
    { label: "gpt", value: "GPT-5.5 (cloud) · warm", status: "ok" },
  ],
  findings: [
    {
      id: "providers.qwen.unreachable",
      status: "warn",
      title: "LM Studio not reachable",
      message: "Local model host did not respond; turns will fall back to cloud.",
      source: "http://127.0.0.1:1234",
      evidence: "last load: 14m ago\nlast error: connect ECONNREFUSED 127.0.0.1:1234",
      nextAction: { label: "Start the local model server", command: "emberlm up" },
    },
  ],
};

// --- Internet --------------------------------------------------------------

export const internetOk: DoctorArea = {
  id: "internet",
  label: "Internet",
  status: "ok",
  verdict: "Online.",
  facts: [
    { label: "reach", value: "online", status: "ok" },
    { label: "latency", value: "42ms" },
  ],
};

export const internetDisconnected: DoctorArea = {
  id: "internet",
  label: "Internet",
  status: "error",
  verdict: "No internet connectivity.",
  findings: [
    {
      id: "internet.offline",
      status: "error",
      title: "Offline",
      message:
        "Outbound connectivity probe failed; cloud providers, web fetch, and docs refresh are unavailable.",
      evidence: "probe: HEAD https://1.1.1.1\nError: ENETUNREACH",
      nextAction: { label: "Reconnect to a network" },
    },
  ],
};

// --- Tools / Search --------------------------------------------------------

export const toolsOk: DoctorArea = {
  id: "tools",
  label: "Tools / Search",
  status: "ok",
  verdict: "Search tooling available.",
  facts: [
    { label: "rg", value: "available", status: "ok" },
    { label: "ast_grep", value: "available", status: "ok" },
    { label: "registered", value: "7 tools" },
  ],
};

export const toolsAstGrepMissing: DoctorArea = {
  id: "tools",
  label: "Tools / Search",
  status: "warn",
  verdict: "ripgrep available; ast-grep missing.",
  facts: [
    { label: "rg", value: "available", status: "ok" },
    { label: "ast_grep", value: "missing", status: "warn" },
  ],
  findings: [
    {
      id: "tools.astgrep.missing",
      status: "warn",
      title: "ast-grep not installed",
      message: "Structural search falls back to text search until ast-grep is on PATH.",
      nextAction: { label: "Install ast-grep", command: "brew install ast-grep" },
    },
  ],
};

// --- Web / Docs ------------------------------------------------------------

export const webOk: DoctorArea = {
  id: "web",
  label: "Web / Docs",
  status: "ok",
  verdict: "Web/docs tools are configured.",
  findings: [
    {
      id: "web.search",
      status: "ok",
      title: "Web search",
      message: "A web-search provider key is configured.",
    },
    {
      id: "web.fetch",
      status: "ok",
      title: "Web fetch",
      message: "Backend ladder ready (static, Jina keyed, Firecrawl configured).",
    },
    {
      id: "web.docs",
      status: "ok",
      title: "Docs cache",
      message: "The docs cache is present and fresh.",
    },
  ],
};

export const webFetchUnavailable: DoctorArea = {
  id: "web",
  label: "Web / Docs",
  status: "ok",
  verdict: "Web/docs tools are configured.",
  findings: [
    {
      id: "web.search",
      status: "ok",
      title: "Web search",
      message: "A web-search provider key is configured.",
    },
    {
      id: "web.fetch",
      status: "ok",
      title: "Web fetch",
      message:
        "Backend ladder ready (static, Jina keyed, Firecrawl unconfigured). Last backend error: jina error.",
      nextAction: { label: "Set FIRECRAWL_API_KEY to enable the rendered fallback" },
    },
  ],
};

export const webFirecrawlAbsent: DoctorArea = {
  id: "web",
  label: "Web / Docs",
  status: "warn",
  verdict: "Firecrawl disabled (no API key).",
  facts: [
    { label: "web_fetch", value: "static + Jina", status: "ok" },
    { label: "firecrawl", value: "no API key", status: "warn" },
    { label: "docs", value: "fresh (2h ago)" },
  ],
  findings: [
    {
      id: "web.firecrawl.absent",
      status: "warn",
      title: "Firecrawl not configured",
      message:
        "Heavy or JS-rendered pages that static fetch and Jina can't read won't be retrievable. This backend is optional.",
      source: "FIRECRAWL_API_KEY",
      nextAction: { label: "Set FIRECRAWL_API_KEY to enable" },
    },
  ],
};

export const webDocsStale: DoctorArea = {
  id: "web",
  label: "Web / Docs",
  status: "warn",
  verdict: "Docs cache is stale.",
  facts: [
    { label: "web_fetch", value: "static + Jina", status: "ok" },
    { label: "firecrawl", value: "configured", status: "ok" },
    { label: "docs", value: "stale (26h ago)", status: "warn" },
  ],
  findings: [
    {
      id: "web.docs.stale",
      status: "warn",
      title: "Docs cache older than 24h",
      message:
        "Cached docs are past their freshness window and may be outdated; prefer local source and search.",
      nextAction: { label: "Refresh via web_fetch when needed" },
    },
  ],
};

// --- MCP -------------------------------------------------------------------
// These mirror the HOST's real MCP area shape (plan 23 M8): the runtime status snapshot is
// folded by doctor/mcp-status into ONE PeripheralState whose detail string becomes both the
// verdict and the single `mcp.status` finding via the generic peripheralArea mapping - no
// facts, no per-server findings, redacted targets only, and never any tool-proxy naming (D-001).

const MCP_READY_DETAIL =
  "2 servers (stdio+http) · 2 ready · 11 tools / 3 resources / 2 prompts · checked 2m ago";

export const mcpOk: DoctorArea = {
  id: "mcp",
  label: "MCP",
  status: "ok",
  verdict: MCP_READY_DETAIL,
  findings: [{ id: "mcp.status", status: "ok", title: "MCP", message: MCP_READY_DETAIL }],
};

export const mcpUnconfigured: DoctorArea = {
  id: "mcp",
  label: "MCP",
  status: "not_checked",
  verdict: "MCP is not configured.",
  findings: [
    { id: "mcp.status", status: "not_checked", title: "MCP", message: "MCP is not configured." },
  ],
};

const MCP_AUTH_DETAIL = 'MCP server "linear" (https://mcp.linear.app/mcp) needs authentication';

export const mcpAuthNeeded: DoctorArea = {
  id: "mcp",
  label: "MCP",
  status: "warn",
  verdict: MCP_AUTH_DETAIL,
  findings: [
    {
      id: "mcp.status",
      status: "warn",
      title: "MCP",
      message: MCP_AUTH_DETAIL,
      nextAction: { label: "Authenticate MCP" },
    },
  ],
};

const MCP_ERROR_DETAIL =
  'MCP server "github" crashed: child exited (code 127, signal null); stderr tail: command not found: github-mcp';

export const mcpError: DoctorArea = {
  id: "mcp",
  label: "MCP",
  status: "error",
  verdict: MCP_ERROR_DETAIL,
  findings: [
    {
      id: "mcp.status",
      status: "error",
      title: "MCP",
      message: MCP_ERROR_DETAIL,
      nextAction: { label: "Inspect the MCP integration" },
    },
  ],
};

const MCP_TIMEOUT_DETAIL = 'MCP request "initialize" to "notion" timed out after 30000ms';

export const mcpTimeout: DoctorArea = {
  id: "mcp",
  label: "MCP",
  status: "not_checked",
  verdict: MCP_TIMEOUT_DETAIL,
  findings: [
    {
      id: "mcp.status",
      status: "not_checked",
      title: "MCP",
      message: MCP_TIMEOUT_DETAIL,
      nextAction: { label: "Re-run /doctor to retry" },
    },
  ],
};

// --- LSP -------------------------------------------------------------------
// These mirror the HOST's real LSP area shape (plan 24 M8): the manager status snapshot is
// folded by doctor/lsp-status into ONE PeripheralState whose detail string becomes both the
// verdict and the single `lsp.status` finding via the generic peripheralArea mapping - plus
// the diagnostic-warning finding (`lsp.diagnostics`) when stored diagnostics carry errors.
// Details are scrubbed (home paths abbreviated) and bounded; no facts, no per-file findings.

const LSP_READY_DETAIL = "typescript-language-server ready · checked 2m ago";

export const lspOk: DoctorArea = {
  id: "lsp",
  label: "LSP",
  status: "ok",
  verdict: LSP_READY_DETAIL,
  findings: [{ id: "lsp.status", status: "ok", title: "LSP", message: LSP_READY_DETAIL }],
};

export const lspUnconfigured: DoctorArea = {
  id: "lsp",
  label: "LSP",
  status: "not_checked",
  verdict: "LSP is not configured.",
  findings: [
    { id: "lsp.status", status: "not_checked", title: "LSP", message: "LSP is not configured." },
  ],
};

const LSP_MISSING_DETAIL =
  "typescript-language-server is not installed (checked ~/dev/trevorV2/node_modules/.bin and " +
  "PATH); install: pnpm add -g typescript-language-server";

export const lspMissing: DoctorArea = {
  id: "lsp",
  label: "LSP",
  status: "warn",
  verdict: LSP_MISSING_DETAIL,
  findings: [
    {
      id: "lsp.status",
      status: "warn",
      title: "LSP",
      message: LSP_MISSING_DETAIL,
      nextAction: { label: "Check the LSP integration" },
    },
  ],
};

const LSP_ERROR_DETAIL =
  'LSP server "typescript-language-server" crashed: child exited (code 1, signal null); ' +
  "stderr tail: TypeError: Cannot read properties of undefined";

export const lspError: DoctorArea = {
  id: "lsp",
  label: "LSP",
  status: "error",
  verdict: LSP_ERROR_DETAIL,
  findings: [
    {
      id: "lsp.status",
      status: "error",
      title: "LSP",
      message: LSP_ERROR_DETAIL,
      nextAction: { label: "Inspect the LSP integration" },
    },
  ],
};

const LSP_TIMEOUT_DETAIL =
  'LSP request "initialize" to "typescript-language-server" timed out after 10000ms';

export const lspTimeout: DoctorArea = {
  id: "lsp",
  label: "LSP",
  status: "not_checked",
  verdict: LSP_TIMEOUT_DETAIL,
  findings: [
    {
      id: "lsp.status",
      status: "not_checked",
      title: "LSP",
      message: LSP_TIMEOUT_DETAIL,
      nextAction: { label: "Re-run /doctor to retry" },
    },
  ],
};

const LSP_DIAGNOSTIC_DETAIL =
  "typescript-language-server ready · diagnostics: 2 errors, 1 warning in 2 files · checked 40s ago";

export const lspDiagnosticWarning: DoctorArea = {
  id: "lsp",
  label: "LSP",
  status: "warn",
  verdict: LSP_DIAGNOSTIC_DETAIL,
  findings: [
    { id: "lsp.status", status: "ok", title: "LSP", message: LSP_DIAGNOSTIC_DETAIL },
    {
      id: "lsp.diagnostics",
      status: "warn",
      title: "Workspace diagnostics",
      message: "The language server reports 2 errors, 1 warning in 2 files.",
      nextAction: { label: "Pull details with lsp_diagnostics" },
    },
  ],
};

// --- Hooks -----------------------------------------------------------------

export const hooksOk: DoctorArea = {
  id: "hooks",
  label: "Hooks",
  status: "ok",
  verdict: "All hook scripts present.",
  facts: [
    { label: "pre-turn", value: "ok", status: "ok" },
    { label: "post-turn", value: "ok", status: "ok" },
  ],
};

export const hooksMissingScript: DoctorArea = {
  id: "hooks",
  label: "Hooks",
  status: "error",
  verdict: "A configured hook script is missing.",
  findings: [
    {
      id: "hooks.preturn.missing",
      status: "error",
      title: "pre-turn hook script not found",
      message:
        "The configured hook points at a file that doesn't exist, so the turn pipeline can't run it.",
      source: "~/.trevorV2/hooks/pre-turn.sh",
      nextAction: { label: "Restore the script or remove the hook" },
    },
  ],
};

export const hooksSlow: DoctorArea = {
  id: "hooks",
  label: "Hooks",
  status: "warn",
  verdict: "A hook is running slowly.",
  findings: [
    {
      id: "hooks.postturn.slow",
      status: "warn",
      title: "post-turn hook is slow",
      message:
        "The post-turn hook averaged 4.8s over the last 5 turns, adding latency to every turn.",
      evidence: "samples: 5.1s, 4.6s, 4.9s, 4.2s, 5.0s",
      nextAction: { label: "Profile or simplify the hook" },
    },
  ],
};

export const hooksTrustChanged: DoctorArea = {
  id: "hooks",
  label: "Hooks",
  status: "warn",
  verdict: "Hook trust changed since last run.",
  findings: [
    {
      id: "hooks.trust.changed",
      status: "warn",
      title: "Hook script modified",
      message: "A hook script changed on disk and is paused pending re-approval before it runs.",
      source: "~/.trevorV2/hooks/pre-turn.sh",
      nextAction: { label: "Review the change and re-approve" },
    },
  ],
};

// --- Storage / Roots -------------------------------------------------------

export const storageOk: DoctorArea = {
  id: "storage",
  label: "Storage / Roots",
  status: "ok",
  verdict: "All roots resolved and writable.",
  facts: [
    { label: "config", value: "~/.trevorV2", status: "ok" },
    { label: "state", value: "~/.local/state/trevorV2", status: "ok" },
    { label: "legacy", value: "~/.trevor · none", status: "not_checked" },
    { label: "temp", value: "/var/folders/4p/T", status: "ok" },
    { label: "external:pi", value: "~/.pi · external (read-only)", status: "ok" },
    { label: "external:agents", value: "~/.agents · external (read-only)", status: "ok" },
  ],
};

export const storageRootInvalid: DoctorArea = {
  id: "storage",
  label: "Storage / Roots",
  status: "error",
  verdict: "A storage root needs attention.",
  facts: [
    { label: "config", value: "~/.trevorV2", status: "ok" },
    { label: "state", value: "~/.local/state/trevorV2 · not writable", status: "error" },
    { label: "legacy", value: "~/.trevor · none", status: "not_checked" },
  ],
  findings: [
    {
      id: "storage.state",
      status: "error",
      title: "state not writable",
      message: "Trevor cannot write this root.",
      source: "~/.local/state/trevorV2",
      evidence: "stat: EACCES permission denied\nowner: root  mode: 0755",
      nextAction: { label: "Check permissions on", command: "~/.local/state/trevorV2" },
    },
  ],
};

/** Storage/Roots with leftover ~/.trevor data: a warn finding nudges the import (D-009). */
export const storageLegacyImportable: DoctorArea = {
  id: "storage",
  label: "Storage / Roots",
  status: "warn",
  verdict: "Legacy data is importable.",
  facts: [
    { label: "config", value: "~/.trevorV2", status: "ok" },
    { label: "state", value: "~/.local/state/trevorV2", status: "ok" },
    { label: "legacy", value: "~/.trevor · legacy data (importable)", status: "warn" },
  ],
  findings: [
    {
      id: "storage.legacy",
      status: "warn",
      title: "Legacy data",
      message: "Importable ~/.trevor data is present.",
      source: "~/.trevor",
      nextAction: {
        label: "Import ~/.trevor data via migration or set SESSION_STORE_DB / BLOB_STORE_DIR",
      },
    },
  ],
};

// --- Workspace -------------------------------------------------------------

export const telemetryDisabled: DoctorArea = {
  id: "telemetry",
  label: "Telemetry",
  status: "ok",
  verdict: "disabled (local-only default; nothing remote)",
  facts: [
    { label: "exporter", value: "none" },
    { label: "remote", value: "off" },
    { label: "sentry", value: "off" },
    { label: "provider trace", value: "off" },
    { label: "drops", value: "0" },
    { label: "redaction self-test", value: "pass" },
  ],
  findings: [
    {
      id: "telemetry.mode",
      status: "ok",
      title: "Telemetry",
      message: "disabled (local-only default; nothing remote)",
    },
  ],
};

export const telemetryFileWithDrops: DoctorArea = {
  id: "telemetry",
  label: "Telemetry",
  status: "warn",
  verdict: "file exporter + Sentry",
  facts: [
    { label: "exporter", value: "file" },
    { label: "remote", value: "off" },
    { label: "sentry", value: "configured" },
    { label: "provider trace", value: "on" },
    { label: "drops", value: "12", status: "warn" },
    { label: "redaction self-test", value: "pass" },
  ],
  findings: [
    { id: "telemetry.mode", status: "ok", title: "Telemetry", message: "file exporter + Sentry" },
    {
      id: "telemetry.drops",
      status: "warn",
      title: "Exporter drops",
      message: "12 telemetry record(s) dropped (byte cap or write failure)",
    },
  ],
};

export const workspaceGit: DoctorArea = {
  id: "workspace",
  label: "Workspace",
  status: "ok",
  verdict: "Git worktree on main.",
  facts: [
    { label: "cwd", value: "~/dev/trevorV2/apps/agent-host" },
    { label: "branch", value: "main", status: "ok" },
    { label: "status", value: "3 files changed" },
  ],
};

export const workspaceNotGit: DoctorArea = {
  id: "workspace",
  label: "Workspace",
  status: "warn",
  verdict: "Working directory is not a Git worktree.",
  facts: [
    { label: "cwd", value: "~/dev/scratch" },
    { label: "git", value: "none", status: "warn" },
  ],
  findings: [
    {
      id: "workspace.notgit",
      status: "warn",
      title: "Not a Git repository",
      message:
        "Diff-aware tools and branch-scoped review won't work here. Run git init if this should be tracked.",
      nextAction: { label: "Initialize a repository", command: "git init" },
    },
  ],
};

// --- Updates / Version -----------------------------------------------------

export const updatesOk: DoctorArea = {
  id: "updates",
  label: "Updates / Version",
  status: "ok",
  verdict: "Up to date.",
  facts: [
    { label: "version", value: "v2.0.0-dev" },
    { label: "channel", value: "dev" },
    { label: "latest", value: "up to date", status: "ok" },
  ],
};

export const updatesAvailable: DoctorArea = {
  id: "updates",
  label: "Updates / Version",
  status: "warn",
  verdict: "A newer version is available.",
  facts: [
    { label: "version", value: "v2.0.0-dev" },
    { label: "latest", value: "v2.1.0", status: "warn" },
  ],
  findings: [
    {
      id: "updates.available",
      status: "warn",
      title: "Update available: v2.1.0",
      message: "You're a version behind. Updating is optional but recommended.",
      nextAction: { label: "Update Trevor", command: "trevor update" },
    },
  ],
};

// --- Snapshot assembly -----------------------------------------------------

/** Sort areas into the canonical dashboard order regardless of input order. */
function ordered(areas: readonly DoctorArea[]): DoctorArea[] {
  return [...areas].sort(
    (a, b) => DOCTOR_AREA_ORDER.indexOf(a.id) - DOCTOR_AREA_ORDER.indexOf(b.id),
  );
}

function snapshot(
  state: DoctorSnapshotState,
  checkedAt: string | undefined,
  areas: readonly DoctorArea[],
): DoctorSnapshot {
  return { state, checkedAt, host: HOST, areas: ordered(areas) };
}

/** The full healthy baseline - one ok area per id, canonical order. */
export const HEALTHY_AREAS: readonly DoctorArea[] = [
  coreOk,
  sessionOk,
  providersWarm,
  internetOk,
  toolsOk,
  webOk,
  mcpOk,
  lspOk,
  hooksOk,
  storageOk,
  workspaceGit,
  updatesOk,
];

export const healthySnapshot: DoctorSnapshot = snapshot("ready", "checked just now", HEALTHY_AREAS);

/** A realistic degraded host: a couple of errors, several warnings, the rest ok. */
export const mixedSnapshot: DoctorSnapshot = snapshot("ready", "checked 18s ago", [
  coreOk,
  sessionOk,
  providersAuthMissing,
  internetOk,
  toolsAstGrepMissing,
  webDocsStale,
  mcpAuthNeeded,
  lspDiagnosticWarning,
  hooksOk,
  storageOk,
  workspaceGit,
  updatesAvailable,
]);

/** Many findings across many areas - the dense, worst-case layout. */
export const manyFindingsSnapshot: DoctorSnapshot = snapshot("ready", "checked 4s ago", [
  coreOk,
  sessionStuck,
  providersCloudUnreachable,
  internetOk,
  toolsAstGrepMissing,
  webFirecrawlAbsent,
  mcpError,
  lspMissing,
  hooksSlow,
  storageRootInvalid,
  workspaceNotGit,
  updatesAvailable,
]);

/** Every area un-probed - the cold-start / probes-skipped layout. */
export const notCheckedSnapshot: DoctorSnapshot = snapshot(
  "ready",
  "not yet checked",
  DOCTOR_AREA_ORDER.map((id) => {
    const label = HEALTHY_AREAS.find((area) => area.id === id)?.label ?? id;
    return {
      id,
      label,
      status: "not_checked" as const,
      verdict: "Not checked.",
    } satisfies DoctorArea;
  }),
);

/** Healthy data, but the snapshot has aged past its freshness window. */
export const staleSnapshot: DoctorSnapshot = snapshot("stale", "checked 7m ago", HEALTHY_AREAS);

/** A re-probe in flight over the previous (mixed) data - strip shows refreshing. */
export const refreshingSnapshot: DoctorSnapshot = {
  ...mixedSnapshot,
  state: "refreshing",
};

/** First probe, nothing rendered yet - the dashboard shows its skeleton. */
export const loadingSnapshot: DoctorSnapshot = {
  state: "refreshing",
  host: HOST,
  areas: [],
};

// --- Long-path / wrapping torture test -------------------------------------

const providersLongName: DoctorArea = {
  id: "providers",
  label: "Providers / Models / Auth",
  status: "error",
  verdict: "Cloud provider unreachable with a very long upstream identifier.",
  facts: [
    {
      label: "model",
      value: "anthropic.claude-opus-4-8-20260115-v2:0-256k-extended-thinking-preview",
      status: "ok",
    },
    {
      label: "endpoint",
      value: "https://gateway.internal.us-east-1.models.example-corp.com/v1/chat/completions",
      status: "error",
    },
  ],
  findings: [
    {
      id: "providers.long.unreachable",
      status: "error",
      title: "openai-compatible-gateway-us-east-1.models.example-corp.internal unreachable",
      message:
        "The readiness probe to a deeply-nested upstream gateway failed; the full URL and error must wrap inside the card rather than overflow it.",
      source:
        "https://gateway.internal.us-east-1.models.example-corp.com/v1/chat/completions?deployment=claude-opus-4-8-extended-thinking-preview&region=us-east-1",
      evidence:
        "POST https://gateway.internal.us-east-1.models.example-corp.com/v1/chat/completions\nError: getaddrinfo ENOTFOUND gateway.internal.us-east-1.models.example-corp.com\n  at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:118:26)",
      nextAction: {
        label: "Verify the gateway hostname",
        command:
          "TREVOR_PROVIDER_GPT_BASE_URL=https://gateway.internal.us-east-1.models.example-corp.com/v1",
      },
    },
  ],
};

const storageLongPath: DoctorArea = {
  id: "storage",
  label: "Storage / Roots",
  status: "error",
  verdict: "A state root under a very deep path is not writable.",
  facts: [
    {
      label: "state",
      value:
        "~/Library/Application Support/com.example.trevor/v2/state/runs/2026-06-25/durable-loops",
      status: "error",
    },
  ],
  findings: [
    {
      id: "storage.long.notwritable",
      status: "error",
      title: "Deeply-nested state directory is not writable",
      message: "The resolved root sits several levels deep and must wrap cleanly across lines.",
      source:
        "/Users/kevin/Library/Application Support/com.example.trevor/v2/state/runs/2026-06-25/durable-loops/loop_7f2a91c4e3b8/checkpoints",
      nextAction: {
        label: "Fix ownership",
        command:
          'chown -R "$USER" "/Users/kevin/Library/Application Support/com.example.trevor/v2/state"',
      },
    },
  ],
};

/** Extreme strings everywhere: long model ids, deep paths, long errors. */
export const longPathsSnapshot: DoctorSnapshot = snapshot("ready", "checked 11s ago", [
  coreOk,
  sessionOk,
  providersLongName,
  internetOk,
  toolsOk,
  webOk,
  mcpOk,
  lspOk,
  hooksOk,
  storageLongPath,
  workspaceGit,
  updatesOk,
]);
