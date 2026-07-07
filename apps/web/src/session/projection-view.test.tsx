import assert from "node:assert/strict";
import { render, screen } from "@testing-library/react";
import { HOST_ROLE, type SessionEvent } from "@trevor/session";
import { storedEvent } from "@trevor/test-kit";
import { describe, it } from "vitest";
import { createSessionReadModel, type SessionReadModel } from "./projection";
import { selectHostStatus, selectSessionName } from "./selectors";

let seq = 0;

function event(type: string, payload: Record<string, unknown>, producerId = "host"): SessionEvent {
  seq += 1;
  return storedEvent(
    { type, payload },
    {
      createdAt: "2026-01-01T00:00:00.000Z",
      producerId,
      seq,
      sessionId: "s",
    },
  );
}

function SessionSummaryView(props: { readonly model: SessionReadModel }) {
  const { model } = props;
  const host = selectHostStatus(model, null, Date.parse("2026-01-01T00:00:01.000Z"));

  return (
    <section aria-label="session summary">
      <h1>{selectSessionName(model, "fallback")}</h1>
      <p>{host.present ? "host present" : "host missing"}</p>
      <p>{model.tasks.length} tasks</p>
    </section>
  );
}

describe("SessionReadModel component boundary", () => {
  it("renders from selectors without receiving the raw event array", () => {
    const model = createSessionReadModel(
      [
        event("host.online", {
          agents: [],
          commands: [],
          cwd: "/repo",
          default: "lmstudio",
          instanceId: "host-1",
          models: {},
          providers: ["lmstudio"],
          role: HOST_ROLE.leader,
          workspace: "/repo",
        }),
        event("user.message", { text: "Use selectors", provider: "lmstudio" }, "web"),
        event("tasks.current", {
          rev: 1,
          tasks: [
            {
              activeForm: "Using selectors",
              blockedBy: [],
              blocks: [],
              id: "t1",
              status: "pending",
              subject: "Use selectors",
            },
          ],
        }),
      ],
      { replayed: true },
    );

    render(<SessionSummaryView model={model} />);

    assert.ok(screen.getByRole("heading", { name: "Use selectors" }));
    assert.ok(screen.getByText("host present"));
    assert.ok(screen.getByText("1 tasks"));
  });
});
