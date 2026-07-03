import assert from "node:assert/strict";
import { test } from "vitest";
import { guardChildPipes, reapAfterGrace } from "./child-spawn";

test("guardChildPipes absorbs stdio stream errors", () => {
  const child = {
    stdin: new FakeStream(),
    stdout: new FakeStream(),
    stderr: new FakeStream(),
  };
  let stdinErrors = 0;

  guardChildPipes(child as never, () => {
    stdinErrors += 1;
  });

  child.stdin.emitError();
  child.stdout.emitError();
  child.stderr.emitError();

  assert.equal(stdinErrors, 1);
});

test("reapAfterGrace escalates to SIGKILL when a child does not exit", async () => {
  const child = new FakeChild();

  reapAfterGrace(child as never, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(child.signals, ["SIGKILL"]);
});

class FakeStream {
  private readonly handlers: (() => void)[] = [];

  on(event: "error", handler: () => void): void {
    if (event === "error") {
      this.handlers.push(handler);
    }
  }

  emitError(): void {
    for (const handler of this.handlers) {
      handler();
    }
  }
}

class FakeChild {
  readonly exitCode = null;
  readonly signalCode = null;
  readonly signals: string[] = [];
  private readonly exitHandlers = new Set<() => void>();

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }

  once(event: "exit", handler: () => void): void {
    if (event === "exit") {
      this.exitHandlers.add(handler);
    }
  }

  off(event: "exit", handler: () => void): void {
    if (event === "exit") {
      this.exitHandlers.delete(handler);
    }
  }
}
