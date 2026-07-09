import assert from "node:assert/strict";
import { act, render, waitFor } from "@testing-library/react";
import { type RefObject, useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { VirtualTranscript } from "@/components/chat/virtual-transcript";
import { createScrollFollowController, type ScrollFollowController } from "@/scroll-follow";
import type { TranscriptRow } from "../../transcript-rows";

const noop = () => {};

function userRow(index: number): TranscriptRow {
  return {
    kind: "message",
    id: `message:u-${index}`,
    compactAbove: false,
    message: {
      kind: "user",
      id: `u-${index}`,
      text: `prompt ${index}`,
      artifacts: [],
      pastes: [],
    },
  };
}

function toolRow(index: number, compactAbove = true): TranscriptRow {
  return {
    kind: "message",
    id: `message:t-${index}`,
    compactAbove,
    message: {
      kind: "tool",
      id: `t-${index}`,
      name: "task_create",
      args: JSON.stringify({ subject: `task ${index}` }),
      done: true,
      result: "created",
    },
  };
}

function assistantRow(id: string, text: string): TranscriptRow {
  return {
    kind: "message",
    id: `message:${id}`,
    compactAbove: false,
    message: {
      kind: "assistant",
      id,
      runId: "r1",
      text,
      thinking: "",
      done: true,
      warm: false,
      model: "glm",
    },
  };
}

function thinkingAssistantRow({
  done,
  id,
  text = "",
  thinking,
}: {
  readonly done: boolean;
  readonly id: string;
  readonly text?: string;
  readonly thinking: string;
}): TranscriptRow {
  return {
    kind: "message",
    id: `message:${id}`,
    compactAbove: false,
    message: {
      kind: "assistant",
      id,
      runId: "r1",
      text,
      thinking,
      done,
      warm: false,
      model: "glm",
    },
  };
}

/** Wrap a controller so a test can count the writes it APPROVES, by class (the "did it auto-follow /
 *  did it compensate?" signal that survives jsdom having no real geometry - where a yank and a no-op
 *  top-anchored compensation both target scrollTop 0). */
function trackApprovedWrites(controller: ScrollFollowController): {
  follow: number;
  anchor: number;
} {
  const tracker = { follow: 0, anchor: 0 };
  const original = controller.requestWrite.bind(controller);
  controller.requestWrite = (writeClass, options) => {
    const decision = original(writeClass, options);
    if (decision.allowed) {
      if (writeClass === "follow") {
        tracker.follow += 1;
      } else {
        tracker.anchor += 1;
      }
    }
    return decision;
  };
  return tracker;
}

function Harness({
  rows,
  pinned = true,
  scrollToBottomRequest = 0,
  compact = false,
  controller: providedController,
}: {
  readonly rows: readonly TranscriptRow[];
  readonly pinned?: boolean;
  readonly scrollToBottomRequest?: number;
  readonly compact?: boolean;
  /** A test may supply its own controller (to pre-set pin state or spy on it); otherwise the harness
   *  keeps one in sync with the `pinned` prop. */
  readonly controller?: ScrollFollowController;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // A real controller mirroring the `pinned` prop. The initial value is baked in at creation so the
  // very first render (which the virtualizer's initialOffset reads) is correct; subsequent prop flips
  // are mirrored in an EFFECT - the controller is a subscribable store, and mutating it during render
  // is a footgun the moment anything subscribes.
  const internalControllerRef = useRef<ScrollFollowController | null>(null);
  if (internalControllerRef.current === null) {
    internalControllerRef.current = createScrollFollowController({ initialPinned: pinned });
  }
  const controller = providedController ?? internalControllerRef.current;
  useEffect(() => {
    if (providedController) {
      return; // the test owns the provided controller's state
    }
    if (pinned && !controller.isPinned()) {
      controller.repin("jump");
    } else if (!pinned && controller.isPinned()) {
      controller.gesture("up");
    }
  }, [pinned, providedController, controller]);
  return (
    <div
      ref={scrollRef}
      data-testid="scroll"
      style={{ height: 600, overflowY: "auto", width: 900 }}
    >
      <VirtualTranscript
        rows={rows}
        scrollRef={scrollRef as RefObject<HTMLDivElement | null>}
        controller={controller}
        scrollToBottomRequest={scrollToBottomRequest}
        rowConfig={{ showThinking: true, compact, onOpenPath: noop, onDoctorRefresh: noop }}
        testInitialRect={{ width: 900, height: 600 }}
      />
    </div>
  );
}

/** A mixed live transcript: a user prompt, a streaming assistant (thinking, not done), a running tool,
 *  a completed tool, and a final response. The live-turn indicator is the pinned TurnStatusHeader
 *  (plan 50), not a transcript row, so no trailing working row appears here. */
function liveRows(): TranscriptRow[] {
  return [
    userRow(1),
    {
      kind: "message",
      id: "message:a-stream",
      compactAbove: false,
      message: {
        kind: "assistant",
        id: "a-stream",
        runId: "r1",
        text: "",
        thinking: "deciding what to read first",
        done: false,
        warm: false,
        model: "glm",
      },
    },
    {
      kind: "message",
      id: "message:t-run",
      compactAbove: false,
      message: {
        kind: "tool",
        id: "t-run",
        name: "bash",
        args: JSON.stringify({ command: "pnpm build" }),
        done: false,
      },
    },
    toolRow(2),
    {
      kind: "message",
      id: "message:a-final",
      compactAbove: false,
      message: {
        kind: "assistant",
        id: "a-final",
        runId: "r1",
        text: "All done.",
        thinking: "",
        done: true,
        warm: false,
        model: "glm",
      },
    },
  ];
}

describe("VirtualTranscript", () => {
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  );
  const originalScrollTo = HTMLElement.prototype.scrollTo;

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        return 72;
      },
    });
    HTMLElement.prototype.scrollTo = vi.fn(function scrollTo(
      this: HTMLElement,
      options?: ScrollToOptions | number,
      y?: number,
    ) {
      const top = typeof options === "number" ? y : options?.top;
      if (typeof top === "number") {
        this.scrollTop = top;
        this.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalOffsetHeight) {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
    }
    HTMLElement.prototype.scrollTo = originalScrollTo;
  });

  test("mounts a bounded row set for a large transcript", async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => userRow(index));
    const { container } = render(<Harness rows={rows} />);

    await waitFor(() => {
      assert.ok(container.querySelectorAll("[data-transcript-virtual-row]").length > 0);
    });

    const mounted = container.querySelectorAll("[data-transcript-virtual-row]");
    assert.equal(
      container
        .querySelector("[data-transcript-virtual-list]")
        ?.getAttribute("data-transcript-row-count"),
      "1000",
    );
    assert.ok(mounted.length < 80, `expected fewer than 80 mounted rows, saw ${mounted.length}`);
  });

  test("renders large virtualized transcripts as fixed-height absolute turn items", async () => {
    const rows = Array.from({ length: 120 }, (_, index) => [
      userRow(index),
      assistantRow(`a-${index}`, `response ${index} `.repeat(12)),
      toolRow(index),
    ]).flat();
    const { container } = render(<Harness rows={rows} />);

    await waitFor(() => {
      assert.ok(container.querySelectorAll("[data-transcript-virtual-turn]").length > 0);
    });

    const list = container.querySelector<HTMLElement>("[data-transcript-virtual-list]");
    assert.ok(list);
    assert.equal(list.getAttribute("data-transcript-row-count"), String(rows.length));
    assert.equal(list.getAttribute("data-transcript-turn-count"), "120");
    assert.ok(Number.parseFloat(list.style.height) > 0, "virtualized layout owns total height");
    assert.equal(list.style.paddingTop, "", "range offsets are diagnostic data, not CSS spacers");
    await waitFor(() => {
      assert.ok(
        Number(list.getAttribute("data-transcript-padding-top")) > 0 ||
          Number(list.getAttribute("data-transcript-padding-bottom")) > 0,
        "spacer padding should represent an unmounted transcript region",
      );
    });

    const turns = Array.from(
      container.querySelectorAll<HTMLElement>("[data-transcript-virtual-turn]"),
    );
    assert.ok(turns.length < 80, `expected fewer than 80 mounted turns, saw ${turns.length}`);
    for (const turn of turns) {
      assert.notEqual(turn.style.transform, "");
      assert.equal(turn.classList.contains("absolute"), true);
    }
    for (const row of container.querySelectorAll<HTMLElement>("[data-transcript-virtual-row]")) {
      assert.equal(row.style.transform, "");
      assert.equal(row.classList.contains("absolute"), false);
    }
  });

  test("reveals only after the initial live-edge range is mounted", async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => userRow(index));
    const { container } = render(<Harness rows={rows} />);
    const list = container.querySelector("[data-transcript-virtual-list]");

    assert.equal(list?.getAttribute("data-transcript-ready"), "false");

    await waitFor(() => {
      assert.equal(
        container
          .querySelector("[data-transcript-virtual-list]")
          ?.getAttribute("data-transcript-ready"),
        "true",
      );
    });
  });

  test("routes explicit bottom requests through the virtualizer", async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => userRow(index));
    const { container, rerender } = render(<Harness rows={rows} scrollToBottomRequest={0} />);

    await waitFor(() => {
      assert.ok(container.querySelectorAll("[data-transcript-virtual-row]").length > 0);
    });
    const callsBefore = vi.mocked(HTMLElement.prototype.scrollTo).mock.calls.length;

    rerender(<Harness rows={rows} scrollToBottomRequest={1} />);

    await waitFor(() => {
      assert.ok(vi.mocked(HTMLElement.prototype.scrollTo).mock.calls.length > callsBefore);
    });
  });

  test("does not follow the live edge on appended rows while unpinned", async () => {
    // jsdom has no real geometry (scrollHeight 0), so a yank and a benign top-anchored compensation both
    // target scrollTop 0 - the meaningful signal is that NO follow write reaches the virtualizer's
    // scrollToFn while unpinned. followLiveEdge checks mayFollow() (the pin gate) without recording a
    // ledger entry, so a denied follow while unpinned never calls scrollToLiveEdge at all. The
    // real-position "no yank" assertion lives in the Lane B e2e specs.
    const controller = createScrollFollowController();
    controller.gesture("up"); // the user has scrolled up
    const follows = trackApprovedWrites(controller);
    const rows = Array.from({ length: 100 }, (_, index) => userRow(index));
    const { container, rerender } = render(<Harness rows={rows} controller={controller} />);

    await waitFor(() => {
      assert.ok(container.querySelectorAll("[data-transcript-virtual-row]").length > 0);
    });
    follows.follow = 0; // ignore any writes during the initial reveal; count only post-append

    await act(async () => {
      rerender(<Harness rows={[...rows, userRow(100)]} controller={controller} />);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    assert.equal(
      follows.follow,
      0,
      "append while unpinned must not approve a follow write to the live edge",
    );
  });

  test("abandons auto-follow once the user unpins, even as rows keep appending", async () => {
    const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const controller = createScrollFollowController(); // starts pinned
    const follows = trackApprovedWrites(controller);
    const rows = Array.from({ length: 100 }, (_, index) => userRow(index));
    const { container, rerender } = render(<Harness rows={rows} controller={controller} />);

    // Let the initial reveal fully settle (it follows the live edge across several frames while pinned).
    await waitFor(() => {
      assert.equal(
        container
          .querySelector("[data-transcript-virtual-list]")
          ?.getAttribute("data-transcript-ready"),
        "true",
      );
    });
    await act(async () => {
      for (let i = 0; i < 6; i += 1) {
        await raf();
      }
    });

    // The user scrolls up (unpin the controller AND drop the prop). From here, appended rows must never
    // pull the viewport back down - every follow request is denied at fire time by the controller.
    controller.gesture("up");
    follows.follow = 0;
    await act(async () => {
      rerender(<Harness rows={[...rows, userRow(100)]} controller={controller} />);
      await raf();
      await raf();
      rerender(<Harness rows={[...rows, userRow(100), userRow(101)]} controller={controller} />);
      await raf();
      await raf();
    });

    assert.equal(follows.follow, 0, "no auto-follow write may be approved after the user unpins");
  });

  test("while pinned, an appended row DOES approve a follow write (stick-to-bottom)", async () => {
    const controller = createScrollFollowController(); // pinned
    const follows = trackApprovedWrites(controller);
    const rows = Array.from({ length: 100 }, (_, index) => userRow(index));
    const { container, rerender } = render(<Harness rows={rows} controller={controller} />);
    await waitFor(() => {
      assert.ok(container.querySelectorAll("[data-transcript-virtual-row]").length > 0);
    });
    follows.follow = 0;

    await act(async () => {
      rerender(<Harness rows={[...rows, userRow(100)]} controller={controller} />);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    assert.ok(follows.follow > 0, "a pinned append must follow the live edge");
  });

  test("while pinned, a same-row thinking collapse and answer start follows the live edge", async () => {
    const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const controller = createScrollFollowController();
    const follows = trackApprovedWrites(controller);
    const rows = [
      userRow(1),
      thinkingAssistantRow({
        id: "a-live",
        thinking: "checking the repo\nreading the transcript\nchoosing the fix",
        done: false,
      }),
    ];
    const { container, rerender } = render(<Harness rows={rows} controller={controller} />);
    await waitFor(() => {
      assert.equal(
        container
          .querySelector("[data-transcript-virtual-list]")
          ?.getAttribute("data-transcript-ready"),
        "true",
      );
    });
    follows.follow = 0;

    await act(async () => {
      rerender(
        <Harness
          rows={[
            rows[0] as TranscriptRow,
            thinkingAssistantRow({
              id: "a-live",
              thinking: "checking the repo\nreading the transcript\nchoosing the fix",
              text: "Yes. The answer is now streaming.",
              done: true,
            }),
          ]}
          controller={controller}
        />,
      );
      await raf();
      await raf();
    });

    assert.ok(
      follows.follow > 0,
      "settling the existing assistant row must keep a pinned transcript on the live edge",
    );
  });

  test("the settle loop terminates on user intent instead of force-scrolling to the edge", async () => {
    // The user scrolled up before the initial reveal finished settling (an unpinned controller from
    // the very first frame). The settle loop must reveal where the user is, approving no follow write,
    // rather than force-scrolling them to the live edge - the pre-12.2 not-ready trap.
    const controller = createScrollFollowController();
    controller.gesture("up");
    const follows = trackApprovedWrites(controller);
    const rows = Array.from({ length: 1000 }, (_, index) => userRow(index));
    const { container } = render(<Harness rows={rows} controller={controller} />);

    await waitFor(() => {
      assert.equal(
        container
          .querySelector("[data-transcript-virtual-list]")
          ?.getAttribute("data-transcript-ready"),
        "true",
        "the settle loop still reveals the transcript",
      );
    });
    assert.equal(
      follows.follow,
      0,
      "a settle loop that saw the user unpin must not follow the edge",
    );
  });

  test("while unpinned, a virtualizer re-measure may compensate but never follows", async () => {
    // Browser verification covers real visual anchor compensation. In jsdom the important ownership
    // boundary is that TanStack's measurement correction is classified as anchor compensation, never
    // bottom-follow. Transcript row changes are covered separately by the visual-anchor browser specs.
    const controller = createScrollFollowController();
    controller.gesture("up");
    const writes = trackApprovedWrites(controller);
    const rows = Array.from({ length: 200 }, (_, index) => userRow(index));
    const { container, rerender } = render(<Harness rows={rows} controller={controller} />);
    await waitFor(() => {
      assert.ok(container.querySelectorAll("[data-transcript-virtual-row]").length > 0);
    });
    writes.anchor = 0;
    writes.follow = 0;

    // Grow a row's measured height, forcing the virtualizer to re-anchor via scrollToFn.
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        return 220;
      },
    });
    await act(async () => {
      rerender(<Harness rows={rows} controller={controller} />);
      for (let i = 0; i < 4; i += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });

    assert.equal(writes.follow, 0, "a re-measure while unpinned must not be a follow write");
    assert.ok(writes.anchor > 0, "TanStack virtualizer re-measures stay in anchor compensation");
  });

  test("does not mount read-only batch continuations as placeholder rows", async () => {
    const rows: TranscriptRow[] = [
      userRow(0),
      {
        kind: "tool_batch",
        id: "tool-batch:t1",
        compactAbove: false,
        tools: [
          { kind: "tool", id: "t1", name: "read", args: "{}", done: true },
          { kind: "tool", id: "t2", name: "glob", args: "{}", done: true },
          { kind: "tool", id: "t3", name: "grep", args: "{}", done: true },
        ],
      },
      userRow(1),
    ];
    const { container } = render(<Harness rows={rows} />);

    await waitFor(() => {
      assert.equal(container.querySelectorAll("[data-transcript-virtual-row]").length, 3);
    });
    assert.equal(
      container
        .querySelector("[data-transcript-virtual-list]")
        ?.getAttribute("data-transcript-row-count"),
      "3",
    );
  });

  test("compact tool rows do not use negative-margin overlap inside virtual rows", async () => {
    const rows = [userRow(0), toolRow(1, false), toolRow(2, true), toolRow(3, true), userRow(4)];
    const { container } = render(<Harness rows={rows} />);

    await waitFor(() => {
      assert.ok(container.querySelectorAll("[data-transcript-virtual-row]").length > 0);
    });

    assert.equal(container.querySelector(".-mt-6"), null);
  });

  test("regular mode keeps full space after the last tool before assistant markdown", async () => {
    const rows = [
      toolRow(1, false),
      toolRow(2, true),
      assistantRow("a-after-tools", "Yes - the tool returned rows."),
      toolRow(3, false),
      toolRow(4, true),
    ];
    const { container } = render(<Harness rows={rows} compact={false} />);

    await waitFor(() => {
      assert.ok(
        container.querySelector('[data-transcript-virtual-row][data-index="4"]'),
        "all rows mounted",
      );
    });

    assert.ok(
      container
        .querySelector('[data-transcript-virtual-row][data-index="0"]')
        ?.classList.contains("pb-2"),
    );
    assert.ok(
      container
        .querySelector('[data-transcript-virtual-row][data-index="1"]')
        ?.classList.contains("pb-8"),
    );
    assert.ok(
      container
        .querySelector('[data-transcript-virtual-row][data-index="2"]')
        ?.classList.contains("pb-8"),
    );
    assert.ok(
      container
        .querySelector('[data-transcript-virtual-row][data-index="3"]')
        ?.classList.contains("pb-2"),
    );
  });

  test("toggling compact mode mid-stream (streaming + running rows) keeps every row mounted", async () => {
    const rows = liveRows();
    const { container, rerender } = render(<Harness rows={rows} compact={false} />);
    await waitFor(() => {
      assert.ok(container.querySelectorAll("[data-transcript-virtual-row]").length > 0);
    });
    const regularCount = container
      .querySelector("[data-transcript-virtual-list]")
      ?.getAttribute("data-transcript-row-count");
    assert.equal(regularCount, String(rows.length));

    // Toggle compact ON while a turn streams + a tool runs - no crash, same row count/keys.
    rerender(<Harness rows={rows} compact={true} />);
    await waitFor(() => {
      assert.ok(container.querySelectorAll("[data-transcript-virtual-row]").length > 0);
    });
    assert.equal(
      container
        .querySelector("[data-transcript-virtual-list]")
        ?.getAttribute("data-transcript-row-count"),
      String(rows.length),
      "compact mode does not add or drop rows",
    );

    // And back to regular while still live.
    rerender(<Harness rows={rows} compact={false} />);
    await waitFor(() => {
      assert.ok(container.querySelectorAll("[data-transcript-virtual-row]").length > 0);
    });
  });

  test("an assistant Mermaid diagram row still lets the virtual list settle", async () => {
    const rows = [
      userRow(0),
      assistantRow(
        "a-mermaid",
        `Here is the flow:

\`\`\`mermaid
graph TD
  A-->B
\`\`\``,
      ),
      userRow(1),
    ];
    const { container } = render(<Harness rows={rows} />);

    await waitFor(() => {
      assert.equal(
        container
          .querySelector("[data-transcript-virtual-list]")
          ?.getAttribute("data-transcript-ready"),
        "true",
      );
    });
    assert.ok(container.querySelector('[data-testid="mermaid-block"]'));
    assert.equal(
      container
        .querySelector("[data-transcript-virtual-list]")
        ?.getAttribute("data-transcript-row-count"),
      String(rows.length),
    );
  });

  test("user prompts and the final response stay full while compact, tools/thinking collapse", async () => {
    const rows = liveRows();
    const { container } = render(<Harness rows={rows} compact={true} />);
    await waitFor(() => {
      assert.ok(container.querySelectorAll("[data-transcript-virtual-row]").length > 0);
    });
    // The user prompt and the final assistant response render their full text.
    assert.ok(container.textContent?.includes("prompt 1"), "user prompt stays full");
    assert.ok(container.textContent?.includes("All done."), "final response stays full");
    // A compact-eligible row (the running bash tool) shows its one-line summary, not the full block.
    assert.ok(
      container.textContent?.includes("pnpm build"),
      "running tool compacts to its summary",
    );
  });

  test("toggling compact while scrolled up does not yank the viewport to the bottom", async () => {
    const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const controller = createScrollFollowController({ initialPinned: false });
    const writes = trackApprovedWrites(controller);
    // Tool rows are compact-eligible, so toggling compact really changes their heights.
    const rows = Array.from({ length: 100 }, (_, index) => toolRow(index, false));
    const { container, rerender } = render(
      <Harness rows={rows} controller={controller} compact={false} />,
    );
    await waitFor(() => {
      assert.ok(container.querySelectorAll("[data-transcript-virtual-row]").length > 0);
    });
    writes.follow = 0;

    await act(async () => {
      rerender(<Harness rows={rows} controller={controller} compact={true} />);
      await raf();
      await raf();
    });

    assert.equal(
      writes.follow,
      0,
      "a compact toggle while unpinned may compensate an anchor but must not follow the bottom",
    );
  });

  test("toggling compact while pinned keeps the view anchored to the live edge", async () => {
    const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const controller = createScrollFollowController();
    const writes = trackApprovedWrites(controller);
    const rows = Array.from({ length: 80 }, (_, index) => [
      userRow(index),
      toolRow(index, false),
    ]).flat();
    const { container, rerender } = render(
      <Harness rows={rows} controller={controller} compact={false} />,
    );
    await waitFor(() => {
      assert.ok(container.querySelectorAll("[data-transcript-virtual-row]").length > 0);
    });
    writes.follow = 0;

    await act(async () => {
      rerender(<Harness rows={rows} controller={controller} compact={true} />);
      await raf();
      await raf();
    });

    assert.ok(
      writes.follow > 0,
      "a compact toggle while pinned re-anchors to the live edge as heights change",
    );
  });
});
