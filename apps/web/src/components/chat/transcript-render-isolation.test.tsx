import assert from "node:assert/strict";
import { render, waitFor } from "@testing-library/react";
import { events, PRODUCER_IDS, type SessionEvent, type TrevorEventInput } from "@trevor/session";
import { storedEvent } from "@trevor/test-kit";
import { type RefObject, useRef } from "react";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { VirtualTranscript } from "@/components/chat/virtual-transcript";
import { createScrollFollowController } from "@/scroll-follow";
import { readOnlyToolBatches, TranscriptProjector } from "../../transcript";
import { buildTranscriptRows, type TranscriptRow } from "../../transcript-rows";

// Render-count probe (Tier 1): swap MarkdownBody for an UNMEMOIZED component that logs each render's
// text. The probe carries no memo of its own, so it re-renders exactly when its owning
// TranscriptRowView renders - the per-row signal the row-level memo must cut off for untouched rows.
const { renderedTexts } = vi.hoisted(() => ({ renderedTexts: [] as string[] }));
vi.mock("@/components/chat/markdown-body", () => ({
  MarkdownBody: ({ text }: { readonly text: string }) => {
    renderedTexts.push(text);
    return <div data-markdown-probe>{text}</div>;
  },
}));

const HOST = PRODUCER_IDS.host;
const hostEvent = (seq: number, input: TrevorEventInput): SessionEvent =>
  storedEvent(input, { seq, producerId: HOST, createdAt: "2026-07-10T00:00:00.000Z" });
const webEvent = (seq: number, input: TrevorEventInput): SessionEvent =>
  storedEvent(input, { seq, producerId: "web-1", createdAt: "2026-07-10T00:00:00.000Z" });

/** A completed earlier turn plus a second turn that is still streaming (r2 has an open segment). */
function baseLog(): SessionEvent[] {
  return [
    webEvent(1, events.userMessage({ text: "question", provider: "qwen" })),
    hostEvent(
      2,
      events.assistantStarted({ runId: "r1", model: "m", provider: "qwen", warm: true }),
    ),
    hostEvent(3, events.assistantDelta({ runId: "r1", text: "earlier answer" })),
    hostEvent(4, events.assistantCompleted({ runId: "r1", text: "earlier answer" })),
    webEvent(5, events.userMessage({ text: "follow-up", provider: "qwen" })),
    hostEvent(
      6,
      events.assistantStarted({ runId: "r2", model: "m", provider: "qwen", warm: true }),
    ),
    hostEvent(7, events.assistantDelta({ runId: "r2", text: "streaming " })),
  ];
}

/** The production fold shape: the incremental projector (structural sharing keeps untouched Message
 *  identity) feeding buildTranscriptRows, which mints FRESH row wrapper objects every call - the
 *  identity noise TranscriptRowView's comparator must see through. */
function rowsFrom(projector: TranscriptProjector, log: readonly SessionEvent[]): TranscriptRow[] {
  projector.applyAll(log);
  const transcript = projector.project().transcript;
  return buildTranscriptRows({ toolBatches: readOnlyToolBatches(transcript), transcript });
}

const noop = () => {};
// One module-level config, like App's Tier 1 useMemo'd rowConfig: identity-stable across rerenders.
const rowConfig = { showThinking: true, onOpenPath: noop, onDoctorRefresh: noop };

function Harness({ rows }: { readonly rows: readonly TranscriptRow[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef(createScrollFollowController());
  return (
    <div ref={scrollRef} style={{ height: 600, overflowY: "auto", width: 900 }}>
      <VirtualTranscript
        rows={rows}
        scrollRef={scrollRef as RefObject<HTMLDivElement | null>}
        controller={controllerRef.current}
        scrollToBottomRequest={0}
        rowConfig={rowConfig}
        testInitialRect={{ width: 900, height: 600 }}
      />
    </div>
  );
}

describe("transcript render isolation (Tier 1)", () => {
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  );
  const originalScrollTo = HTMLElement.prototype.scrollTo;

  beforeEach(() => {
    renderedTexts.length = 0;
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
    if (originalOffsetHeight) {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
    }
    HTMLElement.prototype.scrollTo = originalScrollTo;
  });

  test("a streaming delta re-renders the live row but not untouched earlier rows", async () => {
    const projector = new TranscriptProjector({ selfProducerId: HOST });
    const log = baseLog();
    const { container, rerender } = render(<Harness rows={rowsFrom(projector, log)} />);
    await waitFor(() => {
      assert.ok(container.querySelectorAll("[data-transcript-virtual-row]").length > 0);
    });
    assert.ok(
      renderedTexts.includes("earlier answer"),
      "sanity: the earlier row's body rendered on mount",
    );
    renderedTexts.length = 0;

    // Append one streaming token and re-fold, exactly like App does per assistant.delta.
    const next = [...log, hostEvent(8, events.assistantDelta({ runId: "r2", text: "more" }))];
    rerender(<Harness rows={rowsFrom(projector, next)} />);

    assert.ok(
      renderedTexts.includes("streaming more"),
      `the streaming row must re-render with the appended text (saw: ${JSON.stringify(renderedTexts)})`,
    );
    assert.ok(
      !renderedTexts.includes("earlier answer"),
      "an untouched earlier row must NOT re-render on a streaming delta",
    );
  });
});
