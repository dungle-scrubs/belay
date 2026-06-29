import type { Meta, StoryObj } from "@storybook/react-vite";
import type { RecallResult } from "@trevor/session";
import { storyFrame } from "@/components/chat/story-frame";
import { SessionRecallResults } from "./session-recall";

/**
 * D-044 M5: the Session-recall transcript surface, Storybook-first. Every state recall can land in
 * - searching, one hit, many sessions, no hits, partial, stale, and error - so the visible result
 * is reviewed before the live wiring. Fixtures are production-shaped `RecallResult`s (the wire
 * contract), not story-only markup.
 */

const meta: Meta<typeof SessionRecallResults> = {
  title: "Chat/SessionRecall",
  component: SessionRecallResults,
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj<typeof SessionRecallResults>;

// A fixed "now" so relative timestamps render deterministically across stories + tests.
const NOW = Date.parse("2026-06-26T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const Frame = storyFrame("w-[44rem]");

function result(over: Partial<RecallResult>): RecallResult {
  return {
    status: "ok",
    query: "which database did we choose for the durable log",
    findings: [],
    sources: [],
    diagnostics: [],
    activity: {
      searchedSessions: 0,
      searchedFolds: 0,
      searchedRecords: 0,
      anchors: 0,
      neighborhoods: 0,
    },
    ...over,
  };
}

const ONE_HIT = result({
  findings: [
    {
      summary:
        "You chose SQLite (via node:sqlite, WAL mode) as the durable session log, because the host needs synchronous, gap-free seq assignment and a single-file store [S1]. Postgres was considered but dropped as overkill for a local-first store [S2].",
      citations: ["sib-store#41", "sib-store#12"],
    },
  ],
  sources: [
    {
      id: "sib-store#41",
      sessionId: "sib-store",
      sessionLabel: "set up the session store",
      origin: "sibling-session",
      seq: 41,
      range: { fromSeq: 41, toSeq: 41 },
      kind: "assistant",
      timestamp: ago(1000 * 60 * 60 * 26),
      excerpt:
        "…we'll back the durable log with SQLite in WAL mode so replay and append never interleave; seq is MAX(seq)+1 per session…",
    },
    {
      id: "sib-store#12",
      sessionId: "sib-store",
      sessionLabel: "set up the session store",
      origin: "sibling-session",
      seq: 12,
      range: { fromSeq: 12, toSeq: 12 },
      kind: "user",
      timestamp: ago(1000 * 60 * 60 * 27),
      excerpt: "should we use postgres for the log or keep it local-first?",
    },
  ],
  activity: {
    searchedSessions: 3,
    searchedFolds: 4,
    searchedRecords: 318,
    anchors: 2,
    neighborhoods: 2,
  },
});

export const OneHit: Story = {
  render: () => (
    <Frame>
      <SessionRecallResults query={ONE_HIT.query} result={ONE_HIT} nowMs={NOW} />
    </Frame>
  ),
};

export const Searching: Story = {
  render: () => (
    <Frame>
      <SessionRecallResults
        query="how did we handle the lease takeover timing"
        result={null}
        status="running"
        nowMs={NOW}
      />
    </Frame>
  ),
};

const MULTI = result({
  query: "everything we decided about compaction",
  findings: [
    {
      summary:
        "Compaction folds older turns into a ~1k-token rolling summary at 80% of the window, down to 50% [S1]. The fold is recall-aware: it notes dropped-but-recallable detail [S2]. The current session's compacted-away detail is searchable here while the active-prompt tail is excluded [S3].",
      citations: ["cur#88", "sib-a#5", "sib-b#30"],
    },
  ],
  sources: [
    {
      id: "cur#88",
      sessionId: "cur",
      sessionLabel: "(this session) implement recall",
      origin: "current-compacted",
      seq: 88,
      range: { fromSeq: 70, toSeq: 88 },
      kind: "fold",
      timestamp: ago(1000 * 60 * 18),
      excerpt:
        "folded: discussed COMPACT_WHEN=0.8, COMPACT_TO=0.5, and the ~1k-token summary budget…",
    },
    {
      id: "sib-a#5",
      sessionId: "sib-a",
      sessionLabel: "cross-turn compaction",
      origin: "sibling-session",
      seq: 5,
      range: { fromSeq: 5, toSeq: 5 },
      kind: "assistant",
      timestamp: ago(1000 * 60 * 60 * 24 * 3),
      excerpt:
        "the summarizer is tool-less and notes what detail is dropped but could be recalled later…",
    },
    {
      id: "sib-b#30",
      sessionId: "sib-b",
      sessionLabel: "history projection",
      origin: "sibling-session",
      seq: 30,
      range: { fromSeq: 30, toSeq: 30 },
      kind: "tool",
      timestamp: ago(1000 * 60 * 60 * 24 * 9),
      excerpt:
        "grep: history-projection.ts: a turn is in the active prompt when seq > fold.throughSeq…",
    },
  ],
  activity: {
    searchedSessions: 5,
    searchedFolds: 9,
    searchedRecords: 1042,
    anchors: 3,
    neighborhoods: 3,
  },
});

export const MultipleSessions: Story = {
  render: () => (
    <Frame>
      <SessionRecallResults query={MULTI.query} result={MULTI} nowMs={NOW} />
    </Frame>
  ),
};

export const NoHits: Story = {
  render: () => (
    <Frame>
      <SessionRecallResults
        query="what color did we paint the bikeshed"
        result={result({
          status: "no_hits",
          activity: {
            searchedSessions: 4,
            searchedFolds: 6,
            searchedRecords: 503,
            anchors: 0,
            neighborhoods: 0,
          },
        })}
        nowMs={NOW}
      />
    </Frame>
  ),
};

export const PartialSearch: Story = {
  render: () => (
    <Frame>
      <SessionRecallResults
        query={ONE_HIT.query}
        result={result({
          status: "partial",
          findings: ONE_HIT.findings,
          sources: ONE_HIT.sources,
          diagnostics: [
            {
              sessionId: "sib-old",
              kind: "unreadable",
              detail: "socket closed before replay completed",
            },
          ],
          activity: {
            searchedSessions: 2,
            searchedFolds: 3,
            searchedRecords: 210,
            anchors: 2,
            neighborhoods: 2,
          },
        })}
        nowMs={NOW}
      />
    </Frame>
  ),
};

export const StaleSession: Story = {
  render: () => (
    <Frame>
      <SessionRecallResults
        query="the worktree locking approach"
        result={result({
          status: "partial",
          findings: [
            {
              summary:
                "Each managed worktree gets a per-session advisory lock; a cwd-path lock was deferred [S1].",
              citations: ["sib-wt#9"],
            },
          ],
          sources: [
            {
              id: "sib-wt#9",
              sessionId: "sib-wt",
              sessionLabel: "managed worktrees",
              origin: "sibling-session",
              seq: 9,
              range: { fromSeq: 9, toSeq: 9 },
              kind: "assistant",
              timestamp: ago(1000 * 60 * 60 * 24 * 7 * 3),
              excerpt:
                "the per-session lock holds; the dedicated cwd-path advisory lock is deferred…",
            },
          ],
          diagnostics: [
            {
              sessionId: "sib-wt",
              kind: "stale",
              detail: "host announced but not live; read from the durable log",
            },
          ],
          activity: {
            searchedSessions: 3,
            searchedFolds: 2,
            searchedRecords: 140,
            anchors: 1,
            neighborhoods: 1,
          },
        })}
        nowMs={NOW}
      />
    </Frame>
  ),
};

export const Unavailable: Story = {
  render: () => (
    <Frame>
      <SessionRecallResults
        query="anything from before"
        result={result({ status: "unavailable" })}
        nowMs={NOW}
      />
    </Frame>
  ),
};

export const ErrorState: Story = {
  render: () => (
    <Frame>
      <SessionRecallResults
        query={ONE_HIT.query}
        result={result({
          status: "error",
          diagnostics: [
            {
              sessionId: "",
              kind: "unreadable",
              detail: "reasoning pass failed: qwen unavailable: connection reset",
            },
          ],
        })}
        nowMs={NOW}
      />
    </Frame>
  ),
};
