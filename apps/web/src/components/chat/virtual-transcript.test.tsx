import assert from "node:assert/strict";
import { act, render, waitFor } from "@testing-library/react";
import { type RefObject, useRef } from "react";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { VirtualTranscript } from "@/components/chat/virtual-transcript";
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

function Harness({
  rows,
  pinned = true,
  scrollToBottomRequest = 0,
  compact = false,
}: {
  readonly rows: readonly TranscriptRow[];
  readonly pinned?: boolean;
  readonly scrollToBottomRequest?: number;
  readonly compact?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={scrollRef}
      data-testid="scroll"
      style={{ height: 600, overflowY: "auto", width: 900 }}
    >
      <VirtualTranscript
        rows={rows}
        scrollRef={scrollRef as RefObject<HTMLDivElement | null>}
        pinned={pinned}
        scrollToBottomRequest={scrollToBottomRequest}
        showThinking
        compact={compact}
        onOpenPath={noop}
        onDoctorRefresh={noop}
        testInitialRect={{ width: 900, height: 600 }}
      />
    </div>
  );
}

/** A mixed live transcript: a user prompt, a streaming assistant (thinking, not done), a running tool,
 *  a completed tool, a final response, and the trailing working row. */
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
    { kind: "working", id: "working:live", interruptible: true, startedAt: 0 },
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

  test("does not scroll to bottom on appended rows while unpinned", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => userRow(index));
    const { container, rerender } = render(<Harness rows={rows} pinned={false} />);

    await waitFor(() => {
      assert.ok(container.querySelectorAll("[data-transcript-virtual-row]").length > 0);
    });
    const callsBefore = vi.mocked(HTMLElement.prototype.scrollTo).mock.calls.length;

    await act(async () => {
      rerender(<Harness rows={[...rows, userRow(100)]} pinned={false} />);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    assert.equal(
      vi.mocked(HTMLElement.prototype.scrollTo).mock.calls.length,
      callsBefore,
      "append while unpinned must not force the viewport back to the bottom",
    );
  });

  test("abandons auto-follow once the user unpins, even as rows keep appending", async () => {
    const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const scrollCalls = () => vi.mocked(HTMLElement.prototype.scrollTo).mock.calls.length;
    const rows = Array.from({ length: 100 }, (_, index) => userRow(index));
    const { container, rerender } = render(<Harness rows={rows} pinned={true} />);

    // Let the initial reveal fully settle (it scrolls to the live edge across several frames) so the
    // baseline below counts only scrolls that happen AFTER the user unpins.
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

    // The user scrolls up (pinned -> false). From here, appended/streamed rows must never pull the
    // viewport back down - the follow gate (mayAutoFollow) re-checks pinned at fire time.
    const callsAtUnpin = scrollCalls();
    await act(async () => {
      rerender(<Harness rows={[...rows, userRow(100)]} pinned={false} />);
      await raf();
      await raf();
      rerender(<Harness rows={[...rows, userRow(100), userRow(101)]} pinned={false} />);
      await raf();
      await raf();
    });

    assert.equal(
      scrollCalls(),
      callsAtUnpin,
      "no auto-follow scroll may run after the user unpins",
    );
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
});
