import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  fakeProvider,
  providerQuestionRuntime,
  publishTurnVia,
  transportEmit,
} from "@trevor/agent-host/testing";
import type { RunningServer } from "@trevor/server-kit";
import {
  decodeTrevorEvent,
  type ProviderQuestionAnswer,
  type SessionEvent,
  events as sessionEvents,
  streamTransport,
} from "@trevor/session";
import { subscribe, waitFor } from "@trevor/test-kit";
import { bootStore } from "@trevor/test-kit/boot";
import { Stream } from "effect";
import { afterAll, afterEach, beforeAll, test } from "vitest";

/**
 * S-E2E CLAUDE.md migration (hermetic, plan 26 M8): the full detect -> required-response -> convert
 * loop over a REAL session-store, minus the model. A fake provider calls `migrate_claude_md`; the host
 * turn pipeline blocks the tool on a `provider.question.requested` (rides the ask_user path), a
 * subscriber (the browser) publishes `provider.question.answer` choosing an action per file, and the
 * tool applies the writes ONLY after that answer. Proves create + merge + pointer rewrite land, and that
 * a second run finds nothing to do (pointer idempotence). The workspace is a throwaway temp tree the
 * process cds into so discovery is hermetic.
 */

let store: RunningServer;
const prevCwd = process.cwd();

beforeAll(async () => {
  store = await bootStore();
});

afterAll(async () => {
  process.chdir(prevCwd);
  await store.close();
});

afterEach(() => {
  process.chdir(prevCwd);
  providerQuestionRuntime.reset();
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/** A workspace with a root CLAUDE.md (no sibling -> create) and a nested one with a sibling (-> merge). */
function migrationWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "trevor-migrate-"));
  write(join(root, "CLAUDE.md"), "# Root rules\n\nAlways run the linter before committing.");
  write(join(root, "apps", "CLAUDE.md"), "Nested app rules: prefer pnpm.");
  write(join(root, "apps", "AGENTS.md"), "# Existing app guide\n\nKeep this content.");
  return root;
}

/** Publish the migrate_claude_md tool_call on step 1, then a plain reply on step 2. */
function migrateTurn(
  transport: ReturnType<typeof streamTransport>,
  session: string,
  runId: string,
) {
  const usage = { input: 10, output: 1, contextWindow: 200_000, genMs: 1 } as const;
  let calls = 0;
  return publishTurnVia(
    transportEmit(transport, session, "host"),
    fakeProvider({
      stream: () => {
        calls += 1;
        if (calls === 1) {
          return Stream.fromIterable([
            {
              type: "tool_call" as const,
              call: { id: "call-1", name: "migrate_claude_md", arguments: "{}" },
            },
            { type: "usage" as const, usage },
          ]);
        }
        return Stream.fromIterable([
          { type: "text" as const, text: "Migration handled." },
          { type: "usage" as const, usage },
        ]);
      },
    }),
    [{ role: "user", content: "Migrate the CLAUDE.md files." }],
    { runId },
  );
}

/** Tails the store as the host's inbound lane: resolve any pending question from a browser answer. */
function hostConsumer(transport: ReturnType<typeof streamTransport>, session: string) {
  const host = subscribe(transport, session, "host-consumer");
  let consumed = 0;
  const drain = () => {
    for (let i = consumed; i < host.events.length; i += 1) {
      const decoded = decodeTrevorEvent(host.events[i] as SessionEvent);
      if (decoded?.type === "provider.question.answer") {
        providerQuestionRuntime.submitAnswer(decoded.questionId, decoded.answer);
      }
    }
    consumed = host.events.length;
  };
  return { host, drain };
}

test("migrate_claude_md converts (create + merge) after the user's grouped answer, then rewrites pointers", async () => {
  const root = migrationWorkspace();
  process.chdir(root);
  const transport = streamTransport(store.url);
  const SESSION = "migrate-convert";
  await transport.ensureSession(SESSION);
  providerQuestionRuntime.configure((event) => {
    void transport.publishEvent(SESSION, { producerId: "host", ...event });
  });

  const viewer = subscribe(transport, SESSION, "viewer");
  await waitFor(viewer.isReplayed);
  const { host, drain } = hostConsumer(transport, SESSION);

  const turn = migrateTurn(transport, SESSION, "r-migrate");

  // 1) The tool blocks and the proposal reaches the store, tagged as a migration.
  await waitFor(() => viewer.events.some((e) => e.type === "provider.question.requested"), {
    label: "provider.question.requested",
  });
  const requested = viewer.events.find((e) => e.type === "provider.question.requested");
  assert.equal(
    requested?.payload.adapter,
    "claude_migration",
    "the request is a migration proposal",
  );
  const questionId = String(requested?.payload.questionId ?? "");
  assert.ok(questionId);

  // 2) The browser answers: create the root file, merge the nested one.
  const answer: ProviderQuestionAnswer = {
    action: "accept",
    answer: "",
    questions: [
      {
        id: "CLAUDE.md",
        answer: "create",
        selected: [{ id: "create", label: "Create AGENTS.md" }],
      },
      {
        id: "apps/CLAUDE.md",
        answer: "merge",
        selected: [{ id: "merge", label: "Merge into existing AGENTS.md" }],
      },
    ],
  };
  await transport.publishEvent(SESSION, {
    producerId: "web",
    ...sessionEvents.providerQuestionAnswer({ questionId, answer }),
  });
  await waitFor(() => host.events.some((e) => e.type === "provider.question.answer"));
  drain();

  await turn;
  await waitFor(() => viewer.events.some((e) => e.type === "assistant.completed"));

  // 3) The create landed: a root AGENTS.md with provenance, and CLAUDE.md is now a pointer.
  const rootAgents = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.match(rootAgents, /Migrated from CLAUDE\.md/i);
  assert.match(rootAgents, /Always run the linter/);
  assert.match(readFileSync(join(root, "CLAUDE.md"), "utf8"), /has moved/i);

  // 4) The merge landed: the existing content is kept, the migrated section is marked, pointer written.
  const appsAgents = readFileSync(join(root, "apps", "AGENTS.md"), "utf8");
  assert.match(appsAgents, /Keep this content\./);
  assert.match(appsAgents, /BEGIN migrated from CLAUDE\.md/);
  assert.match(appsAgents, /prefer pnpm/);
  assert.match(readFileSync(join(root, "apps", "CLAUDE.md"), "utf8"), /has moved/i);

  const toolDone = viewer.events.find(
    (e) => e.type === "tool.completed" && e.payload.name === "migrate_claude_md",
  );
  const result = String(toolDone?.payload.result ?? "");
  assert.match(result, /created/);
  assert.match(result, /merged/);

  viewer.connection.close();
  host.connection.close();
  rmSync(root, { recursive: true, force: true });
});

test("a second migrate_claude_md run finds only pointers and never raises a proposal (idempotent)", async () => {
  const root = mkdtempSync(join(tmpdir(), "trevor-migrate-done-"));
  // Both CLAUDE.md files are already converted pointers.
  write(join(root, "CLAUDE.md"), "This file has moved; see AGENTS.md as the source of truth.");
  write(join(root, "AGENTS.md"), "# Root guide");
  process.chdir(root);

  const transport = streamTransport(store.url);
  const SESSION = "migrate-idempotent";
  await transport.ensureSession(SESSION);
  providerQuestionRuntime.configure((event) => {
    void transport.publishEvent(SESSION, { producerId: "host", ...event });
  });
  const viewer = subscribe(transport, SESSION, "viewer");
  await waitFor(viewer.isReplayed);

  const turn = migrateTurn(transport, SESSION, "r-idempotent");
  await turn;
  await waitFor(() => viewer.events.some((e) => e.type === "assistant.completed"));

  assert.equal(
    viewer.events.filter((e) => e.type === "provider.question.requested").length,
    0,
    "a converted workspace raises no migration proposal",
  );
  const toolDone = viewer.events.find(
    (e) => e.type === "tool.completed" && e.payload.name === "migrate_claude_md",
  );
  assert.match(String(toolDone?.payload.result ?? ""), /No CLAUDE\.md files need migration/);
  // The pointer file is left untouched.
  assert.ok(existsSync(join(root, "CLAUDE.md")));

  viewer.connection.close();
  rmSync(root, { recursive: true, force: true });
});
