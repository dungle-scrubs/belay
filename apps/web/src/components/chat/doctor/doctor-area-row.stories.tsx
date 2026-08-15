import type { DoctorArea } from "@belay/session";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { DoctorAreaRow } from "./doctor-area-row";
import {
  coreOk,
  hooksLegacyMigration,
  hooksMissingScript,
  hooksOk,
  hooksSlow,
  hooksTrustChanged,
  hooksUnapproved,
  hooksUnconfigured,
  internetDisconnected,
  internetOk,
  longPathsSnapshot,
  lspDiagnosticWarning,
  lspError,
  lspMissing,
  lspOk,
  lspTimeout,
  lspUnconfigured,
  mcpAuthNeeded,
  mcpError,
  mcpOk,
  mcpTimeout,
  mcpUnconfigured,
  providersAuthMissing,
  providersCloudUnreachable,
  providersLocalUnreachable,
  providersWarm,
  sessionStuck,
  storageOk,
  storageRootInvalid,
  telemetryDisabled,
  telemetryFileWithDrops,
  toolsAstGrepMissing,
  toolsOk,
  updatesAvailable,
  webDocsStale,
  webFetchUnavailable,
  webFirecrawlAbsent,
  webOk,
  workspaceGit,
  workspaceNotGit,
} from "./doctor-fixtures";

/**
 * Individual Doctor area rows, one fixture state per row, rendered inside the
 * panel chrome they live in. Each story is one area's state matrix - ok / warning
 * / error / not-checked side by side - so the row treatments can be compared.
 * Healthy rows are one line; problem rows show their findings inline. Rows with a
 * chevron expand to reveal key facts.
 */
const meta: Meta<typeof DoctorAreaRow> = {
  title: "Chat/Doctor/Area Row",
  component: DoctorAreaRow,
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj<typeof DoctorAreaRow>;

const onAction = (label: string | undefined) => window.alert(`next action: ${label}`);

/** Rows rendered inside the real panel frame (border + dividers). */
function RowPanel({ areas }: { areas: readonly DoctorArea[] }) {
  return (
    <div className="@container mx-auto w-full max-w-2xl border border-border bg-card">
      <div className="divide-y divide-border">
        {areas.map((area) => (
          // Variants of one area share an id, so key on the unique verdict instead.
          <DoctorAreaRow
            key={`${area.id}:${area.verdict}`}
            area={area}
            onAction={(f) => onAction(f.nextAction?.label)}
          />
        ))}
      </div>
    </div>
  );
}

/** The four severities as rows: ok, warning, error, not checked. */
export const StatusTreatments: Story = {
  render: () => (
    <RowPanel areas={[providersWarm, lspDiagnosticWarning, mcpError, mcpUnconfigured]} />
  ),
};

/** Healthy areas - each a single quiet line; expand for the facts. */
export const Healthy: Story = {
  render: () => (
    <RowPanel areas={[coreOk, providersWarm, toolsOk, webOk, storageOk, workspaceGit]} />
  ),
};

/** Providers / Models / Auth: warm, auth missing, cloud unreachable, local down. */
export const Providers: Story = {
  render: () => (
    <RowPanel
      areas={[
        providersWarm,
        providersAuthMissing,
        providersCloudUnreachable,
        providersLocalUnreachable,
      ]}
    />
  ),
};

/** Internet: online vs disconnected. */
export const Internet: Story = {
  render: () => <RowPanel areas={[internetOk, internetDisconnected]} />,
};

/** Tools / Search: full tooling vs ast-grep missing. */
export const Tools: Story = {
  render: () => <RowPanel areas={[toolsOk, toolsAstGrepMissing]} />,
};

/** Web / Docs: ready, fetch degraded, Firecrawl absent, docs stale. */
export const WebDocs: Story = {
  render: () => <RowPanel areas={[webOk, webFetchUnavailable, webFirecrawlAbsent, webDocsStale]} />,
};

/** MCP (plan 23 M8): ready with counts, unconfigured, auth needed, server failure, handshake
 *  timeout - the host's real per-state detail strings through the generic peripheral row. */
export const Mcp: Story = {
  render: () => <RowPanel areas={[mcpOk, mcpUnconfigured, mcpAuthNeeded, mcpError, mcpTimeout]} />,
};

/** LSP (plan 24 M8): ready with freshness, unconfigured, missing binary with install hint,
 *  crash, initialize timeout, stored-diagnostics warning - the host's real per-state detail
 *  strings through the generic peripheral row. */
export const Lsp: Story = {
  render: () => (
    <RowPanel
      areas={[lspOk, lspUnconfigured, lspMissing, lspError, lspTimeout, lspDiagnosticWarning]}
    />
  ),
};

/** Hooks (plan 25 M9): ready with trust rollup, unconfigured, awaiting approval, trust changed,
 *  script missing, degrading handler, legacy HOOK.md migration - the host's real per-state
 *  detail strings through the generic peripheral row. */
export const Hooks: Story = {
  render: () => (
    <RowPanel
      areas={[
        hooksOk,
        hooksUnconfigured,
        hooksUnapproved,
        hooksTrustChanged,
        hooksMissingScript,
        hooksSlow,
        hooksLegacyMigration,
      ]}
    />
  ),
};

/** Storage / Roots: writable vs not writable. */
export const Storage: Story = {
  render: () => <RowPanel areas={[storageOk, storageRootInvalid]} />,
};

/** Workspace: Git worktree vs not a repository. */
export const Workspace: Story = {
  render: () => <RowPanel areas={[workspaceGit, workspaceNotGit]} />,
};

/** Session / Run and Updates: a stalled run, and an available update. */
export const SessionAndUpdates: Story = {
  render: () => <RowPanel areas={[sessionStuck, updatesAvailable]} />,
};

/** Telemetry (plan 13): the disabled local-only default, and a file exporter with drops. */
export const Telemetry: Story = {
  render: () => <RowPanel areas={[telemetryDisabled, telemetryFileWithDrops]} />,
};

/** The wrapping torture test: long model ids, deep paths, long errors, all
 *  contained inside the panel rows. */
export const LongPathsWrapping: Story = {
  render: () => (
    <RowPanel
      areas={longPathsSnapshot.areas.filter(
        (area) => area.id === "providers" || area.id === "storage",
      )}
    />
  ),
};
