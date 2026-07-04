import { fireEvent, render, screen } from "@testing-library/react";
import type { LoopControl, LoopInventoryRow } from "@trevor/session";
import { useRef } from "react";
import { expect, test, vi } from "vitest";
import { useComposer } from "@/hooks/use-composer";
import { createScrollFollowController } from "@/scroll-follow";
import type { HostStatus } from "../../derive";
import type { InventoryState } from "../../resume";
import type { SessionStream } from "../../session/use-session";
import { readOnlyToolBatches } from "../../transcript";
import { PanelHost } from "./panel-host";

const loopRow: LoopInventoryRow = {
  agentBacked: true,
  controls: ["pause"],
  durability: "session",
  loopId: "loop_1",
  progress: { completed: 1, max: 5 },
  runner: "current_session_prompt",
  status: "running",
  summary: "run tests",
};

function emptyInventory(): InventoryState {
  return {
    error: null,
    loading: false,
    refetch: vi.fn(),
    sessions: [],
  };
}

function PanelHostHarness(props: {
  readonly onLoopControl: (loopId: string, control: LoopControl) => void;
  readonly fileMenu?: {
    readonly open: boolean;
    readonly matches: readonly { path: string }[];
    readonly index: number;
  };
}) {
  const { onLoopControl, fileMenu } = props;
  const composer = useComposer();
  const transcriptRef = useRef<HTMLDivElement>(null);

  const host: HostStatus = {
    branch: null,
    cwd: null,
    git: null,
    leaderId: "host-1",
    present: true,
    standbyCount: 0,
    workspace: null,
  };
  const stream: SessionStream = {
    events: [],
    presence: [],
    replayThroughSeq: 0,
    replayed: true,
    status: "open",
  };

  return (
    <PanelHost
      archived={false}
      choosers={{
        inventory: emptyInventory(),
        onResume: vi.fn(),
        onSwitchWorktree: vi.fn(),
        resumeContext: {
          busy: false,
          currentProject: null,
          currentSessionId: "s",
          nowMs: 1_800_000_000_000,
        },
        resumeOpen: false,
        setResumeOpen: vi.fn(),
        setWorktreeOpen: vi.fn(),
        worktreeContext: { busy: false },
        worktreeOpen: false,
        worktrees: [],
      }}
      compose={{
        acceptCommand: vi.fn(),
        caret: 0,
        disabled: false,
        fileMenu: {
          open: fileMenu?.open ?? false,
          matches: fileMenu?.matches ?? [],
          index: fileMenu?.index ?? 0,
          query: "",
          truncated: false,
          loading: false,
          onPick: vi.fn(),
        },
        onCaretChange: vi.fn(),
        menuIndex: 0,
        menuMatches: [],
        menuOpen: false,
        onExpand: vi.fn(),
        onInputKeyDown: vi.fn(),
        onSubmit: (event) => event.preventDefault(),
        placeholder: "message",
        slashQuery: null,
        vimEnabled: false,
      }}
      composer={composer}
      handoff={{
        onApprove: vi.fn(),
        onEdit: vi.fn(),
        onReject: vi.fn(),
        pending: null,
      }}
      host={host}
      loopInventory={{ onControl: onLoopControl, rows: [loopRow] }}
      onUnarchive={vi.fn()}
      panel={{
        controls: null,
        footer: null,
        git: null,
        model: {},
        onClose: vi.fn(),
        onOpen: vi.fn(),
        open: false,
        ready: true,
        statusNode: null,
        subtitle: "open",
        title: "s",
      }}
      question={{ onAnswer: vi.fn(), pending: null }}
      scroll={{
        atBottom: true,
        bottomRequestId: 0,
        controller: createScrollFollowController(),
        hasUnseen: false,
        onScroll: vi.fn(),
        onUserGesture: vi.fn(),
        scrollToBottom: vi.fn(),
        transcriptRef,
      }}
      sessionName="session"
      sidebar={{
        currentProject: null,
        currentSessionId: "s",
        liveActivity: new Map(),
        nowMs: 1_800_000_000_000,
        onArchive: vi.fn(),
        onClose: vi.fn(),
        onDelete: vi.fn(),
        onOpen: vi.fn(),
        onRename: vi.fn(),
        onSelect: vi.fn(),
        open: false,
        sessions: [],
      }}
      stream={stream}
      tasks={[]}
      transcript={{
        active: null,
        awaitingResponse: false,
        compact: false,
        onDoctorRefresh: vi.fn(),
        onOpenPath: vi.fn(),
        queue: [],
        showThinking: true,
        toolBatches: readOnlyToolBatches([]),
        transcript: [],
        turnStartedAt: null,
      }}
    />
  );
}

test("PanelHost mounts live loop inventory above the composer and routes controls", () => {
  const controls: Array<{ loopId: string; control: LoopControl }> = [];
  render(
    <PanelHostHarness
      onLoopControl={(loopId, control) => {
        controls.push({ control, loopId });
      }}
    />,
  );

  expect(screen.getByText("run tests")).toBeTruthy();
  expect(screen.getByRole("textbox")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Pause loop_1" }));
  expect(controls).toEqual([{ control: "pause", loopId: "loop_1" }]);
});

test("an open file-mention menu with zero matches never points the composer at a dangling id", () => {
  render(
    <PanelHostHarness onLoopControl={vi.fn()} fileMenu={{ open: true, matches: [], index: 0 }} />,
  );

  // AutocompleteMenu renders no listbox/option DOM when there are zero matches (loading or
  // no-results); the composer must not claim aria-controls/aria-activedescendant point somewhere.
  const input = screen.getByRole("textbox");
  expect(input.getAttribute("aria-controls")).toBeNull();
  expect(input.getAttribute("aria-activedescendant")).toBeNull();
});

test("an open file-mention menu WITH matches points the composer at the active option", () => {
  render(
    <PanelHostHarness
      onLoopControl={vi.fn()}
      fileMenu={{ open: true, matches: [{ path: "apps/web/src/app.tsx" }], index: 0 }}
    />,
  );

  const input = screen.getByRole("textbox");
  expect(input.getAttribute("aria-controls")).toBe("file-mention-menu");
  expect(input.getAttribute("aria-activedescendant")).toBe("file-mention-menu-opt-0");
});
