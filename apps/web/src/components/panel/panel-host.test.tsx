import type { LoopControl, LoopInventoryRow, TaskSnapshot } from "@belay/session";
import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { expect, test, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useComposer } from "@/hooks/use-composer";
import { createScrollFollowUi } from "@/hooks/use-scroll-follow";
import { createScrollFollowController } from "@/scroll-follow";
import type { HostStatus } from "../../derive";
import type { InventoryState } from "../../resume";
import type { SessionStream } from "../../session/use-session";
import { readOnlyToolBatches } from "../../transcript";
import type { ResumeHostRowState } from "../chat/resume-host-row";
import { PanelHost } from "./panel-host";

/** Wraps in TooltipProvider (needed by ProjectLabel's Radix tooltip inside the sidebar). */
function renderWithTooltip(ui: Parameters<typeof render>[0]) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

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
  readonly turnStatusHeader?: {
    readonly headline: string;
    readonly startedAt?: number;
    readonly outputTokens?: number;
    readonly state?: string;
  };
  readonly tasks?: readonly TaskSnapshot[];
  readonly sidebar?: {
    readonly open?: boolean;
    readonly width?: number;
    readonly onResize?: (width: number) => void;
  };
  readonly resumeHost?: ResumeHostRowState | null;
}) {
  const { onLoopControl, fileMenu, turnStatusHeader, tasks, sidebar, resumeHost } = props;
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
        commandPreview: null,
        caret: 0,
        disabled: false,
        disabledReason: "Resume host to continue",
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
        controls: null,
        statusSlot: null,
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
        git: null,
        model: {},
        onClose: vi.fn(),
        onOpen: vi.fn(),
        open: false,
        ready: true,
        subtitle: "open",
        title: "s",
      }}
      question={{ onAnswer: vi.fn(), pending: null }}
      scroll={{
        controller: createScrollFollowController(),
        onScroll: vi.fn(),
        onUserGesture: vi.fn(),
        scrollToBottom: vi.fn(),
        transcriptRef,
        ui: createScrollFollowUi().ui,
      }}
      sessionName="session"
      sidebar={{
        open: sidebar?.open ?? false,
        width: sidebar?.width ?? 352,
        onResize: sidebar?.onResize ?? vi.fn(),
        groups: [],
        searchQuery: "",
        onSearch: vi.fn(),
        onToggleProject: vi.fn(),
        onSelect: vi.fn(),
        onShowMore: vi.fn(),
        onAddProject: vi.fn(),
        onNewSession: vi.fn(),
        onArchiveSession: vi.fn(),
        onRenameSession: vi.fn(),
        onRenameProject: vi.fn(),
        onRemoveProject: vi.fn(),
        currentSessionId: "s",
        liveActivity: new Map(),
        onClose: vi.fn(),
        onOpen: vi.fn(),
      }}
      stream={stream}
      tasks={tasks ?? []}
      transcript={{
        rowConfig: {
          compact: false,
          onDoctorRefresh: vi.fn(),
          onOpenPath: vi.fn(),
          showThinking: true,
        },
        onUnqueue: vi.fn(),
        queue: [],
        toolBatches: readOnlyToolBatches([]),
        transcript: [
          { kind: "user", id: "u1", text: "hello from history", artifacts: [], pastes: [] },
        ],
        ...(turnStatusHeader ? { turnStatusHeader } : {}),
      }}
      resumeHost={resumeHost}
    />
  );
}

test("PanelHost mounts live loop inventory above the composer and routes controls", () => {
  const controls: Array<{ loopId: string; control: LoopControl }> = [];
  renderWithTooltip(
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

test("PanelHost contains page overflow so only the transcript scrolls", () => {
  const { container } = renderWithTooltip(<PanelHostHarness onLoopControl={vi.fn()} />);

  const shell = container.firstElementChild;
  expect(shell?.className).toContain("h-svh");
  expect(shell?.className).toContain("overflow-hidden");

  const main = container.querySelector("main");
  expect(main?.className).toContain("min-h-0");
  expect(main?.className).toContain("overflow-hidden");

  const transcriptScroller = container.querySelector("[data-transcript-scroll]");
  expect(transcriptScroller?.className).toContain("min-h-0");
  expect(transcriptScroller?.className).toContain("overflow-y-auto");
});

test("an open file-mention menu with zero matches never points the composer at a dangling id", () => {
  renderWithTooltip(
    <PanelHostHarness onLoopControl={vi.fn()} fileMenu={{ open: true, matches: [], index: 0 }} />,
  );

  // AutocompleteMenu renders no listbox/option DOM when there are zero matches (loading or
  // no-results); the composer must not claim aria-controls/aria-activedescendant point somewhere.
  const input = screen.getByRole("textbox");
  expect(input.getAttribute("aria-controls")).toBeNull();
  expect(input.getAttribute("aria-activedescendant")).toBeNull();
});

test("an open file-mention menu WITH matches points the composer at the active option", () => {
  renderWithTooltip(
    <PanelHostHarness
      onLoopControl={vi.fn()}
      fileMenu={{ open: true, matches: [{ path: "apps/web/src/app.tsx" }], index: 0 }}
    />,
  );

  const input = screen.getByRole("textbox");
  expect(input.getAttribute("aria-controls")).toBe("file-mention-menu");
  expect(input.getAttribute("aria-activedescendant")).toBe("file-mention-menu-opt-0");
});

test("plan 50: the pinned turn-status header renders above the task list during an active turn", () => {
  const { container } = renderWithTooltip(
    <PanelHostHarness
      onLoopControl={vi.fn()}
      turnStatusHeader={{
        headline: "Adding schemas and tests…",
        startedAt: Date.now(),
        outputTokens: 2600,
        state: "thinking",
      }}
      tasks={[
        {
          id: "t1",
          subject: "Add schemas and tests",
          activeForm: "Adding schemas and tests…",
          status: "in_progress",
          blockedBy: [],
          blocks: [],
        },
      ]}
    />,
  );
  const text = container.textContent ?? "";
  // The header line, its live output-token cell, and the esc-to-interrupt affordance are present.
  expect(text).toMatch(/↓ 2\.6k tokens · thinking/);
  expect(text).toMatch(/esc to interrupt/);
  // The header is pinned ABOVE the checklist: its headline text precedes the "tasks 0/1" count.
  expect(text.indexOf("Adding schemas and tests…")).toBeLessThan(text.indexOf("tasks 0/1"));
});

test("plan 50: no pinned header (and no esc-to-interrupt) when no turn is active", () => {
  const { container } = renderWithTooltip(<PanelHostHarness onLoopControl={vi.fn()} />);
  expect(container.textContent ?? "").not.toMatch(/esc to interrupt/);
});

test("the transcript well keeps its scroll identity and shows the themed (not hidden) scrollbar", () => {
  const { container } = renderWithTooltip(<PanelHostHarness onLoopControl={vi.fn()} />);

  // The one scroll owner is still marked `data-transcript-scroll` (scroll-follow + the virtualizer bind
  // to it) and keeps its scroll model; the force-hidden scrollbar utilities are gone, so the themed
  // native bar in index.css `[data-transcript-scroll]` paints instead (plan 33 M2).
  const well = container.querySelector("[data-transcript-scroll]");
  expect(well).toBeTruthy();
  const cls = well?.getAttribute("class") ?? "";
  expect(cls).toContain("overflow-y-auto");
  expect(cls).not.toContain("scrollbar-width:none");
  expect(cls).not.toContain("scrollbar]:hidden");
});

test("sidebar drag previews width locally and persists once on release", () => {
  const onResize = vi.fn();
  const { container } = renderWithTooltip(
    <PanelHostHarness onLoopControl={vi.fn()} sidebar={{ open: true, width: 352, onResize }} />,
  );

  const sidebarShell = screen.getByRole("button", { name: "Resize sidebar" }).parentElement;
  expect(sidebarShell).toBeTruthy();
  expect(sidebarShell?.getAttribute("style")).toContain("width: 352px");

  const handle = screen.getByRole("button", { name: "Resize sidebar" });
  fireEvent.mouseDown(handle, { clientX: 300 });
  fireEvent.mouseMove(document, { clientX: 340 });
  fireEvent.mouseMove(document, { clientX: 390 });

  expect(onResize).not.toHaveBeenCalled();
  expect(sidebarShell?.getAttribute("style")).toContain("width: 442px");

  fireEvent.mouseUp(handle);

  expect(onResize).toHaveBeenCalledTimes(1);
  expect(onResize).toHaveBeenCalledWith(442);
  expect(container.querySelector("[data-transcript-scroll]")).toBeTruthy();
});

test("manual resume row appears above the composer without hiding transcript content", () => {
  renderWithTooltip(
    <PanelHostHarness
      onLoopControl={vi.fn()}
      resumeHost={{
        phase: "manual",
        updatedAt: new Date(2026, 6, 8, 12).toISOString(),
        nowMs: new Date(2026, 6, 9, 12).getTime(),
        onResume: vi.fn(),
      }}
    />,
  );

  expect(screen.getByText("hello from history")).toBeTruthy();
  expect(screen.getByText("this session")).toBeTruthy();
  expect(screen.getByText(/^Last activity /)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
  expect(screen.getByRole("textbox").getAttribute("disabled")).not.toBeNull();
});

test("resume row renders starting, failed retry, and unlaunchable states", () => {
  const retry = vi.fn();
  const { rerender } = renderWithTooltip(
    <PanelHostHarness
      onLoopControl={vi.fn()}
      resumeHost={{ phase: "starting", label: "Starting host..." }}
    />,
  );
  expect(screen.getByText("Starting host...")).toBeTruthy();

  rerender(
    <TooltipProvider>
      <PanelHostHarness
        onLoopControl={vi.fn()}
        resumeHost={{ phase: "failed", error: "Launch failed", onRetry: retry }}
      />
    </TooltipProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledTimes(1);

  rerender(
    <TooltipProvider>
      <PanelHostHarness
        onLoopControl={vi.fn()}
        resumeHost={{
          phase: "unlaunchable",
          updatedAt: new Date(2026, 6, 9, 12).toISOString(),
          nowMs: new Date(2026, 6, 9, 13).getTime(),
        }}
      />
    </TooltipProvider>,
  );
  expect(screen.getByText("No launch root is available")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
});
