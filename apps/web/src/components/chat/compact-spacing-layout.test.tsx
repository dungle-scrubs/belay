import assert from "node:assert/strict";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { type RefObject, useRef } from "react";
import { afterEach, beforeEach, describe, test } from "vitest";
import { VirtualTranscript } from "@/components/chat/virtual-transcript";
import { createScrollFollowController } from "@/scroll-follow";
import type { Message, ToolMessage } from "../../transcript";
import type { TranscriptRow } from "../../transcript-rows";

/**
 * M3 (plan 58): the type-aware compact spacing wired into VirtualTranscript. Proves that in compact mode
 * a run of same-type rows sits flush (`pb-1`) while a type change opens exactly one blank line (`pb-6`) -
 * read-only tools (and a batch) group as one type, same-name tools group, other/MCP tools separate - and
 * that expanding a compact row does not change its siblings' spacing.
 */

const noop = () => {};

function messageRow(message: Message): TranscriptRow {
  return { kind: "message", id: `message:${message.id}`, message, compactAbove: false };
}

function toolRow(id: string, name: string, result?: string): TranscriptRow {
  const message: ToolMessage = {
    kind: "tool",
    id,
    name,
    args: "{}",
    done: result !== undefined,
    ...(result !== undefined ? { result } : {}),
  };
  return messageRow(message);
}

function resultRow(id: string, text: string): TranscriptRow {
  return messageRow({ kind: "result", id, command: "doctor", text, ok: true });
}

const userRow = messageRow({ kind: "user", id: "u1", text: "hi", artifacts: [], pastes: [] });

function Harness({ rows }: { rows: readonly TranscriptRow[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef(createScrollFollowController({ initialPinned: false }));
  return (
    <div ref={scrollRef} style={{ height: 600, overflowY: "auto", width: 900 }}>
      <VirtualTranscript
        rows={rows}
        scrollRef={scrollRef as RefObject<HTMLDivElement | null>}
        controller={controllerRef.current}
        scrollToBottomRequest={0}
        rowConfig={{ showThinking: true, compact: true, onOpenPath: noop, onDoctorRefresh: noop }}
        testInitialRect={{ width: 900, height: 600 }}
      />
    </div>
  );
}

function padOf(container: HTMLElement, index: number): "gap" | "flush" | "other" {
  const el = container.querySelector(`[data-index="${index}"]`);
  assert.ok(el, `row ${index} should be mounted`);
  if (el.classList.contains("pb-6")) {
    return "gap";
  }
  if (el.classList.contains("pb-1")) {
    return "flush";
  }
  return "other";
}

describe("compact type-aware spacing", () => {
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  );

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        return 28;
      },
    });
  });

  afterEach(() => {
    if (originalOffsetHeight) {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
    }
  });

  test("same type sits flush; a type change opens one blank line", async () => {
    const rows = [
      userRow, // user
      toolRow("t-read", "read", "ok"), // readonly
      toolRow("t-glob", "glob", "ok"), // readonly (flush after read)
      toolRow("t-edit1", "edit", "ok"), // tool:edit (gap after glob)
      toolRow("t-edit2", "edit", "ok"), // tool:edit (flush after edit1)
      toolRow("t-bash", "bash", "ok"), // tool:bash (gap after edit2)
    ];
    const { container } = render(<Harness rows={rows} />);
    await waitFor(() => {
      assert.ok(container.querySelector('[data-index="5"]'), "all rows mounted");
    });

    assert.equal(padOf(container, 0), "gap"); // user -> readonly
    assert.equal(padOf(container, 1), "flush"); // read -> glob (both readonly)
    assert.equal(padOf(container, 2), "gap"); // glob -> edit
    assert.equal(padOf(container, 3), "flush"); // edit -> edit
    assert.equal(padOf(container, 4), "gap"); // edit -> bash
    assert.equal(padOf(container, 5), "flush"); // last row, no trailing gap
  });

  test("a read-only batch and an adjacent lone read-only tool sit flush; a mutating tool opens a gap", async () => {
    const rows: TranscriptRow[] = [
      {
        kind: "tool_batch",
        id: "tool-batch:b1",
        compactAbove: false,
        tools: [
          { kind: "tool", id: "b-read", name: "read", args: "{}", done: true },
          { kind: "tool", id: "b-glob", name: "glob", args: "{}", done: true },
        ],
      },
      toolRow("t-read2", "read", "ok"), // lone read-only tool, same "readonly" type as the batch
      toolRow("t-edit", "edit", "ok"), // mutating -> opens a gap
    ];
    const { container } = render(<Harness rows={rows} />);
    await waitFor(() => {
      assert.ok(container.querySelector('[data-index="2"]'), "all rows mounted");
    });

    assert.equal(padOf(container, 0), "flush"); // batch -> lone read (both readonly)
    assert.equal(padOf(container, 1), "gap"); // read -> edit (readonly -> tool:edit)
    assert.equal(padOf(container, 2), "flush"); // last row
  });

  test("expanding a compact row does not change its siblings' spacing", async () => {
    const rows = [
      resultRow("x-result1", "all green\n3 checks passed"), // result (has inline detail)
      resultRow("x-result2", "all green\n3 checks passed"), // result (flush after result1)
      toolRow("x-bash", "bash", "ok"), // tool:bash (gap after result2)
    ];
    const { container } = render(<Harness rows={rows} />);
    await waitFor(() => {
      assert.ok(container.querySelector('[data-index="2"]'), "all rows mounted");
    });

    // Before expansion: result1 sits flush before result2; result2 opens a gap before bash.
    assert.equal(padOf(container, 0), "flush");
    assert.equal(padOf(container, 1), "gap");

    // Expand result1 (command results still inline-expand; tool rows drill into detail instead).
    const button = container.querySelector('[data-index="0"] button');
    assert.ok(button, "result1 should be an expandable compact row");
    fireEvent.click(button);

    // The type keys are unchanged, so the gaps are unchanged - expansion is internal to the row.
    await waitFor(() => {
      assert.ok(container.querySelector('[data-index="0"]'));
    });
    assert.equal(padOf(container, 0), "flush", "expanding result1 must not open a gap after it");
    assert.equal(padOf(container, 1), "gap", "result2 -> bash gap is unchanged");
  });
});
