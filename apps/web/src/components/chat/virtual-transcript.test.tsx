import assert from "node:assert/strict";
import { act, render, waitFor } from "@testing-library/react";
import { type RefObject, useRef } from "react";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { ConcurrentTool } from "@/components/chat/concurrent-tools";
import { VirtualTranscript } from "@/components/chat/virtual-transcript";
import type { ToolMessage as ToolMessageData } from "../../transcript";
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
}: {
  readonly rows: readonly TranscriptRow[];
  readonly pinned?: boolean;
  readonly scrollToBottomRequest?: number;
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
        toConcurrentTool={(tool: ToolMessageData): ConcurrentTool => ({
          id: tool.id,
          name: tool.name,
          status: "done",
        })}
        onOpenPath={noop}
        onDoctorRefresh={noop}
        testInitialRect={{ width: 900, height: 600 }}
      />
    </div>
  );
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
});
