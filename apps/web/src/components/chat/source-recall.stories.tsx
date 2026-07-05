import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  SourceRecallIndexStatus,
  SourceRecallRefreshResult,
  SourceRecallResult,
} from "@trevor/session";
import { storyFrame } from "@/components/chat/story-frame";
import { SourceRecallRefresh, SourceRecallResults, SourceRecallStatus } from "./source-recall";

/**
 * Plan 38 M9: the indexed source-recall transcript surface, Storybook-first. Every state a query can
 * land in - searching, hits, stale index, no results, unready, unavailable, error - plus the index
 * status and refresh surfaces. Fixtures are production-shaped wire results (the D-001 contract), not
 * story-only markup, and are deliberately distinct from the session-recall stories.
 */

const meta: Meta<typeof SourceRecallResults> = {
  title: "Chat/SourceRecall",
  component: SourceRecallResults,
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj<typeof SourceRecallResults>;

const NOW = Date.parse("2026-07-05T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const Frame = storyFrame("w-[44rem]");

function result(over: Partial<SourceRecallResult>): SourceRecallResult {
  return {
    status: "ok",
    providerId: "source-recall:local",
    providerKind: "source-recall",
    query: "how are sessions verified before a turn runs",
    repo: "trevor",
    results: [],
    freshness: {
      indexedAt: ago(1000 * 60 * 20),
      lastCommit: "abc123",
      fileCount: 320,
      chunkCount: 4100,
      vectorCount: 4100,
      stale: false,
    },
    latencyMs: 38,
    capped: false,
    truncated: false,
    diagnostics: [],
    ...over,
  };
}

const HITS = result({
  results: [
    {
      providerId: "source-recall:local",
      filePath: "apps/agent-host/src/agent/turn.ts",
      startLine: 88,
      endLine: 140,
      symbolName: "verifyTurnPreconditions",
      symbolType: "function",
      snippet:
        "async function verifyTurnPreconditions(session: Session) {\n  const lease = await acquireLease(session.id);\n  if (!lease.ok) return deny(lease.reason);\n  return allow();\n}",
      score: 0.94,
      matchReason: "bm25+vector",
      searchQuality: "ast",
      repoName: "trevor",
    },
    {
      providerId: "source-recall:local",
      filePath: "packages/session/src/identity.ts",
      startLine: 12,
      endLine: 30,
      symbolName: "sessionIdentity",
      symbolType: "function",
      snippet: "export function sessionIdentity(raw: string): Identity { /* ... */ }",
      score: 0.81,
      matchReason: "vector",
      searchQuality: "ast",
      repoName: "trevor",
    },
  ],
});

export const Hits: Story = {
  render: () => (
    <Frame>
      <SourceRecallResults query={HITS.query} result={HITS} nowMs={NOW} onOpenPath={() => {}} />
    </Frame>
  ),
};

export const Searching: Story = {
  render: () => (
    <Frame>
      <SourceRecallResults
        query="where do we assemble the system prompt"
        result={null}
        status="running"
        nowMs={NOW}
      />
    </Frame>
  ),
};

export const StaleIndex: Story = {
  render: () => (
    <Frame>
      <SourceRecallResults
        query={HITS.query}
        result={result({
          status: "stale",
          results: HITS.results,
          freshness: {
            indexedAt: ago(1000 * 60 * 60 * 30),
            lastCommit: "abc123",
            fileCount: 320,
            chunkCount: 4100,
            vectorCount: 4100,
            stale: true,
          },
        })}
        nowMs={NOW}
      />
    </Frame>
  ),
};

export const NoResults: Story = {
  render: () => (
    <Frame>
      <SourceRecallResults
        query="the bikeshed color constant"
        result={result({ status: "no_results", results: [] })}
        nowMs={NOW}
      />
    </Frame>
  ),
};

export const Unavailable: Story = {
  render: () => (
    <Frame>
      <SourceRecallResults
        query="anything indexed"
        result={result({
          status: "unavailable",
          providerId: null,
          providerKind: null,
          freshness: null,
          latencyMs: null,
          diagnostics: [
            { kind: "unconfigured", detail: "no source-recall provider is configured or enabled" },
          ],
        })}
        nowMs={NOW}
      />
    </Frame>
  ),
};

export const ErrorState: Story = {
  render: () => (
    <Frame>
      <SourceRecallResults
        query={HITS.query}
        result={result({
          status: "error",
          results: [],
          freshness: null,
          latencyMs: null,
          diagnostics: [
            { kind: "malformed_response", detail: "backend returned a 512-byte non-JSON body" },
          ],
        })}
        nowMs={NOW}
      />
    </Frame>
  ),
};

const STATUS: SourceRecallIndexStatus = {
  status: "ok",
  providerId: "source-recall:local",
  providerKind: "source-recall",
  capabilities: ["chunk_search", "semantic_index", "status", "refresh"],
  repos: [
    {
      name: "trevor",
      readiness: "ready",
      freshness: {
        indexedAt: ago(1000 * 60 * 20),
        lastCommit: null,
        fileCount: 320,
        chunkCount: 4100,
        vectorCount: 4100,
        stale: false,
      },
    },
    {
      name: "docs",
      readiness: "unready",
      freshness: {
        indexedAt: null,
        lastCommit: null,
        fileCount: 40,
        chunkCount: 0,
        vectorCount: 0,
        stale: false,
      },
    },
  ],
  diagnostics: [],
};

export const IndexStatus: StoryObj<typeof SourceRecallStatus> = {
  render: () => (
    <Frame>
      <SourceRecallStatus result={STATUS} nowMs={NOW} />
    </Frame>
  ),
};

const REFRESH: SourceRecallRefreshResult = {
  status: "ok",
  providerId: "source-recall:local",
  providerKind: "source-recall",
  repo: "trevor",
  filesUpdated: 7,
  refreshMs: 214,
  diagnostics: [],
};

export const RefreshDone: StoryObj<typeof SourceRecallRefresh> = {
  render: () => (
    <Frame>
      <SourceRecallRefresh result={REFRESH} />
    </Frame>
  ),
};

export const RefreshRateLimited: StoryObj<typeof SourceRecallRefresh> = {
  render: () => (
    <Frame>
      <SourceRecallRefresh
        result={{
          ...REFRESH,
          status: "rate_limited",
          filesUpdated: null,
          refreshMs: null,
          diagnostics: [{ kind: "rate_limited", detail: "retry in 8.0s" }],
        }}
      />
    </Frame>
  ),
};
