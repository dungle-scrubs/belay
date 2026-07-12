import assert from "node:assert/strict";
import { HOST_ROLE, type SessionEvent } from "@trevor/session";
import { storedEvent } from "@trevor/test-kit";
import { test } from "vitest";
import {
  catalogFrom,
  commandsFrom,
  hostAnnouncement,
  hostStatus,
  pendingQuestionFrom,
  providerModelsFrom,
  tasksFrom,
  tasksStale,
} from "../derive";
import { TranscriptProjector, toTranscript } from "../transcript";
import { createSessionReadModel } from "./projection";
import {
  selectActiveWorkingRow,
  selectHostStatus,
  selectSessionName,
  selectTabTitle,
  selectTurnStatusHeader,
} from "./selectors";

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

const hostOnline = event("host.online", {
  agents: [],
  commands: [{ name: "/doctor", summary: "Run doctor" }],
  cwd: "/repo",
  default: "lmstudio",
  git: {
    ahead: 0,
    behind: 0,
    branch: "main",
    detached: null,
    dirty: false,
    upstream: true,
    worktree: false,
  },
  instanceId: "host-1",
  models: {
    lmstudio: {
      defaultReasoning: "off",
      kind: "local",
      label: "LM Studio",
      model: "qwen",
      reasoningLevels: [],
    },
  },
  providers: ["lmstudio"],
  role: HOST_ROLE.leader,
  workspace: "/repo",
});

test("SessionReadModel reproduces the existing web folds from the event log", () => {
  const events = [
    hostOnline,
    event("user.message", { text: "Build it", provider: "lmstudio" }, "web"),
    event("tasks.current", {
      rev: 1,
      tasks: [
        {
          activeForm: "Building it",
          blockedBy: [],
          blocks: [],
          id: "t1",
          status: "in_progress",
          subject: "Build it",
        },
      ],
    }),
    event("provider.question.requested", {
      adapter: "ask_user",
      contract: {
        questions: [
          {
            allowDefer: false,
            answerShape: "single_choice",
            choices: [{ id: "a", label: "A" }],
            id: "q1",
            multiSelect: false,
            question: "Pick?",
            requiresReason: false,
          },
        ],
        schemaVersion: 1,
      },
      questionId: "q",
      runId: "r",
      toolCallId: "tool",
      toolName: "ask_user",
    }),
  ];

  const model = createSessionReadModel(events, { replayed: true });
  const announcement = hostAnnouncement(events);

  assert.deepEqual(model.transcript, toTranscript(events, { selfProducerId: "host" }));
  assert.deepEqual(model.announcement, announcement);
  assert.deepEqual(model.providerModels, providerModelsFrom(announcement));
  assert.deepEqual(model.catalog, catalogFrom(announcement));
  assert.deepEqual(model.commands, commandsFrom(announcement));
  assert.deepEqual(model.tasks, tasksFrom(events));
  assert.equal(model.staleTasks, tasksStale(events));
  assert.deepEqual(model.pendingQuestion, pendingQuestionFrom(events));
});

test("a session-bound read model ignores a foreign log during a session switch", () => {
  // The switch render: the app's sessionId flips A->B (a revisited session resolves synchronously
  // from the query cache) while the event state still holds A's log - useSession only clears it in
  // its effect, AFTER that render. The freshly-minted projector for B must not fold A's events:
  // seq is per-session, so A's seqs would advance the projector's cursor past B's, and B's entire
  // replay would then be skipped, leaving A's transcript rendered under B's id permanently.
  const eventIn = (sessionId: string, seq: number, text: string): SessionEvent =>
    storedEvent(
      { type: "user.message", payload: { text, provider: "lmstudio" } },
      { createdAt: "2026-01-01T00:00:00.000Z", producerId: "web", seq, sessionId },
    );
  const logA = [eventIn("a", 1, "from A"), eventIn("a", 2, "still A")];
  const projector = new TranscriptProjector({ selfProducerId: "host" });

  const contaminated = createSessionReadModel(logA, { replayed: true, projector, sessionId: "b" });
  assert.deepEqual(contaminated.transcript, []);
  assert.deepEqual(contaminated.events, []);

  // B's replay lands on the next render with seqs restarting at 1: it must fold normally.
  const logB = [eventIn("b", 1, "from B")];
  const model = createSessionReadModel(logB, { replayed: true, projector, sessionId: "b" });
  assert.deepEqual(model.transcript, toTranscript(logB, { selfProducerId: "host" }));
  assert.equal(model.transcript.length, 1);
});

test("selectors derive host, title, session name, and turn status from the read model", () => {
  const events = [
    hostOnline,
    event("user.message", { text: "  Build   the projection  ", provider: "lmstudio" }, "web"),
  ];
  const model = createSessionReadModel(events, { replayed: true });
  const host = selectHostStatus(model, null, Date.parse("2026-01-01T00:00:10.000Z"));

  assert.deepEqual(host, hostStatus(events, null, Date.parse("2026-01-01T00:00:10.000Z")));
  assert.equal(selectSessionName(model, "fallback"), "Build the projection");
  assert.equal(selectTabTitle(host, "trevor-local", "trevor-local"), "repo · Trevor");
  // A plain awaiting-gap turn (no task, no delegation) is not pinned - it shows the inline working row.
  assert.equal(selectTurnStatusHeader(model, { hostlessPending: false }), undefined);
  assert.ok(selectActiveWorkingRow(model, { hostlessPending: false }));
});
