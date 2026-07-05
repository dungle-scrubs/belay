import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCommandFileDispatch } from "@host/commands/command-file-dispatch";
import { type CommandFileRoot, loadCommandFilesFrom } from "@host/commands/command-loader";
import { buildCommandRegistry } from "@host/commands/commands";
import { resolveInterpolationConfig } from "@host/commands/interpolation";
import { createProgrammaticCommandDispatcher } from "@host/commands/programmatic-command";
import type { RunningServer } from "@trevor/server-kit";
import { decodeTrevorEvent, events, streamTransport } from "@trevor/session";
import { subscribe, waitFor } from "@trevor/test-kit";
import { bootStore } from "@trevor/test-kit/boot";
import { afterAll, beforeAll, test } from "vitest";

/**
 * S-E2E for the file-loaded-command SUBMIT branch (plan 44.5, Gate 2->3). Assembles the EXACT wiring
 * main.ts uses - `buildCommandRegistry(files)` + `makeCommandFileDispatch` + the programmatic dispatcher
 * with main.ts's fallback - over a REAL session-store, then dispatches `/fix 123` for a `.trevor/commands/
 * fix.md` and asserts the expanded body lands on the durable log as a `user.message` prompt (not a
 * command.result). Deterministic: no model, no host process, just the dispatch + store round-trip.
 */

let store: RunningServer;
const temps: string[] = [];

beforeAll(async () => {
  store = await bootStore();
});

afterAll(async () => {
  await store.close();
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A temp `.trevor/commands` root holding one command file, loaded into the plan-40 CommandFile shape. */
function loadedRoot(id: string, body: string): CommandFileRoot {
  const base = mkdtempSync(join(tmpdir(), "trevor-cmd-e2e-"));
  temps.push(base);
  const dir = join(base, ".trevor", "commands");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), body);
  return { kind: "project", dir };
}

test("dispatching /fix 123 submits the expanded body as a user.message prompt", async () => {
  const session = "cmd-file-fix";
  const transport = streamTransport(store.url);
  await transport.ensureSession(session);

  const viewer = subscribe(transport, session, "viewer");
  await waitFor(viewer.isReplayed);

  // The exact objects main.ts wires: the registry over the loaded file, the SUBMIT-branch dispatch
  // publishing a control-shaped user.message, and the programmatic dispatcher with main.ts's fallback.
  const { files } = loadCommandFilesFrom([loadedRoot("fix", "Fix issue #$0 for $ARGUMENTS")]);
  const commands = buildCommandRegistry(files);
  const ranBuiltin: string[] = [];
  const commandFileDispatch = makeCommandFileDispatch({
    interpolationConfig: resolveInterpolationConfig(process.env),
    publish: async (text) => {
      await transport.publishEvent(session, {
        ...events.userMessage({ text, provider: "fake" }),
        producerId: "host:control",
      });
    },
    emitResult: async () => {},
  });
  const dispatcher = createProgrammaticCommandDispatcher({
    handlers: [],
    fallback: (command, args) => {
      const file = commands.commandFile(command);
      if (file) {
        return commandFileDispatch.submit(file, args);
      }
      ranBuiltin.push(command);
      return undefined;
    },
  });

  dispatcher.dispatch("/fix", "123 urgently");

  await waitFor(() => viewer.events.some((e) => e.type === "user.message"), {
    label: "user.message",
  });
  const message = viewer.events.find((e) => e.type === "user.message");
  const decoded = message ? decodeTrevorEvent(message) : null;
  assert.equal(decoded?.type, "user.message");
  if (decoded?.type !== "user.message") {
    return;
  }
  // $0 tokenizes to `123`; $ARGUMENTS is the raw args string verbatim.
  assert.equal(decoded.text, "Fix issue #123 for 123 urgently");
  assert.equal(
    ranBuiltin.length,
    0,
    "a file-loaded command never falls through to the built-in lane",
  );

  viewer.connection.close();
});

test("a non-file (built-in) command still falls through to the immediate-command lane unchanged", async () => {
  const { files } = loadCommandFilesFrom([loadedRoot("fix", "Fix #$0")]);
  const commands = buildCommandRegistry(files);
  const ran: { command: string; args: string }[] = [];
  const dispatcher = createProgrammaticCommandDispatcher({
    handlers: [],
    fallback: (command, args) => {
      const file = commands.commandFile(command);
      if (file) {
        return undefined;
      }
      ran.push({ command, args });
      return undefined;
    },
  });

  dispatcher.dispatch("/help", "raw args kept");
  await waitFor(() => ran.length > 0, { label: "built-in fallback" });
  assert.deepEqual(ran, [{ command: "/help", args: "raw args kept" }]);
});
