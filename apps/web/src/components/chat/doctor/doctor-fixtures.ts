/**
 * Fixture `doctor.current` payloads for the Storybook stories. These stand in
 * for the host snapshot until D-073 wires real probes: one variant per area
 * state, plus assembled snapshots (healthy, mixed, many findings, not checked,
 * stale, long paths). Shared by the dashboard and area-card stories.
 *
 * Content is Trevor-flavoured on purpose - qwen local + gpt cloud, the
 * ~/.trevorV2 / ~/.trevor / ~/.pi roots, rg + ast-grep, Firecrawl - so the
 * layout is exercised against believable text lengths.
 */
import {
  DOCTOR_AREA_ORDER,
  type DoctorArea,
  type DoctorHostContext,
  type DoctorSnapshot,
  type DoctorSnapshotState,
} from "@/commands/doctor";

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
  verdict: "Web fetch and docs ready.",
  facts: [
    { label: "web_fetch", value: "static + Jina", status: "ok" },
    { label: "firecrawl", value: "configured", status: "ok" },
    { label: "docs", value: "fresh (2h ago)" },
  ],
};

export const webFetchUnavailable: DoctorArea = {
  id: "web",
  label: "Web / Docs",
  status: "warn",
  verdict: "Web fetch backends degraded.",
  facts: [
    { label: "web_fetch", value: "static only", status: "warn" },
    { label: "firecrawl", value: "configured", status: "ok" },
  ],
  findings: [
    {
      id: "web.fetch.degraded",
      status: "warn",
      title: "Readability backend unavailable",
      message:
        "Jina returned errors, so only raw static fetch is available; thin or JS-heavy pages may not render.",
      nextAction: { label: "Retry later; Firecrawl covers heavy pages" },
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

export const mcpOk: DoctorArea = {
  id: "mcp",
  label: "MCP",
  status: "ok",
  verdict: "2 servers connected.",
  facts: [
    { label: "servers", value: "2 connected", status: "ok" },
    { label: "tools", value: "11 available" },
  ],
};

export const mcpUnconfigured: DoctorArea = {
  id: "mcp",
  label: "MCP",
  status: "not_checked",
  verdict: "No MCP servers configured.",
  facts: [{ label: "servers", value: "none", status: "not_checked" }],
  nextAction: { label: "Add a server to enable MCP tools" },
};

export const mcpAuthNeeded: DoctorArea = {
  id: "mcp",
  label: "MCP",
  status: "warn",
  verdict: "1 of 2 servers needs authentication.",
  facts: [
    { label: "servers", value: "2 configured" },
    { label: "connected", value: "1 of 2", status: "warn" },
  ],
  findings: [
    {
      id: "mcp.gmail.auth",
      status: "warn",
      title: "Gmail server needs auth",
      message:
        "The server is configured but unauthenticated; its tools stay unavailable until you sign in.",
      nextAction: { label: "Authenticate the server" },
    },
  ],
};

export const mcpError: DoctorArea = {
  id: "mcp",
  label: "MCP",
  status: "error",
  verdict: "1 server failed to start.",
  facts: [{ label: "connected", value: "1 of 2", status: "error" }],
  findings: [
    {
      id: "mcp.toolproxy.error",
      status: "error",
      title: "tool-proxy failed to start",
      message: "The MCP server exited during startup; its tools won't be offered this session.",
      evidence: "spawn tool-proxy\nError: command not found: tool-proxy\nexit code 127",
      nextAction: { label: "Check the server command and restart" },
    },
  ],
};

// --- LSP -------------------------------------------------------------------

export const lspOk: DoctorArea = {
  id: "lsp",
  label: "LSP",
  status: "ok",
  verdict: "Language server ready.",
  facts: [
    { label: "server", value: "typescript-language-server", status: "ok" },
    { label: "diagnostics", value: "0 issues" },
  ],
};

export const lspMissing: DoctorArea = {
  id: "lsp",
  label: "LSP",
  status: "warn",
  verdict: "Configured LSP command not found.",
  facts: [{ label: "server", value: "not on PATH", status: "warn" }],
  findings: [
    {
      id: "lsp.command.missing",
      status: "warn",
      title: "typescript-language-server not on PATH",
      message:
        "The configured language server binary wasn't found; Trevor falls back to search, tests, and compiler output.",
      nextAction: {
        label: "Install the server",
        command: "pnpm add -g typescript-language-server",
      },
    },
  ],
};

export const lspUnavailable: DoctorArea = {
  id: "lsp",
  label: "LSP",
  status: "not_checked",
  verdict: "Language server did not respond in time.",
  facts: [{ label: "server", value: "timed out", status: "not_checked" }],
  findings: [
    {
      id: "lsp.unavailable",
      status: "not_checked",
      title: "LSP probe timed out",
      message:
        "The server didn't answer within the probe budget; pull diagnostics will retry on demand.",
    },
  ],
};

export const lspDiagnosticWarning: DoctorArea = {
  id: "lsp",
  label: "LSP",
  status: "warn",
  verdict: "Language server reporting warnings.",
  facts: [
    { label: "server", value: "typescript-language-server", status: "ok" },
    { label: "diagnostics", value: "3 warnings", status: "warn" },
  ],
  findings: [
    {
      id: "lsp.diagnostics",
      status: "warn",
      title: "3 workspace warnings",
      message:
        "The language server reports unused variables and an implicit any in the open project.",
      nextAction: { label: "Review diagnostics in the editor" },
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
    { label: "config", value: "~/.trevorV2" },
    { label: "state", value: "~/.trevor", status: "ok" },
    { label: "auth", value: "~/.pi" },
  ],
};

export const storageRootInvalid: DoctorArea = {
  id: "storage",
  label: "Storage / Roots",
  status: "error",
  verdict: "State root is not writable.",
  facts: [
    { label: "config", value: "~/.trevorV2" },
    { label: "state", value: "~/.trevor · not writable", status: "error" },
  ],
  findings: [
    {
      id: "storage.state.notwritable",
      status: "error",
      title: "State root not writable",
      message: "Trevor can't write its state root, so durable loops, leases, and caches will fail.",
      source: "~/.trevor",
      evidence: "stat: EACCES permission denied\nowner: root  mode: 0755",
      nextAction: { label: "Fix ownership", command: "chown -R $USER ~/.trevor" },
    },
  ],
};

// --- Workspace -------------------------------------------------------------

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
