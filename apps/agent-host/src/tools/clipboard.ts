import { spawn } from "node:child_process";
import { platform } from "node:os";
import { msg } from "@host/transport/messages";
import { Schema } from "effect";
import { simpleTool, toolExecution } from "./shared";
import type { Tool } from "./types";

/**
 * The host's plain-text clipboard write boundary - the ONE place a string crosses from Trevor into
 * the system clipboard. Platform selection (pbcopy/clip/wl-copy) and the test-capture seam stay
 * behind this interface, so command code and the model never shell out to a clipboard command
 * themselves (D-008). `write` rejects when the platform write fails; it never reads the clipboard.
 */
export interface ClipboardWriter {
  write(text: string): Promise<void>;
}

/**
 * The per-platform clipboard command + args that read stdin. Kept pure (no spawn) so platform
 * selection is testable without touching the real clipboard, and so the abstraction - not the
 * command/model code - owns which binary runs. Throws on a platform with no known command.
 */
export function clipboardArgv(
  p: NodeJS.Platform = platform(),
): readonly [string, readonly string[]] {
  switch (p) {
    case "darwin":
      return ["pbcopy", []];
    case "win32":
      return ["clip", []];
    case "linux":
      return ["wl-copy", []];
    default:
      throw new Error(`no clipboard command for platform "${p}"`);
  }
}

/** The real writer: spawns the platform clipboard command and pipes the text to its stdin. */
class SpawnClipboardWriter implements ClipboardWriter {
  write(text: string): Promise<void> {
    const [command, args] = clipboardArgv();
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";

      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (error) =>
        reject(new Error(`clipboard command "${command}" is unavailable: ${error.message}`)),
      );
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
        reject(new Error(`clipboard command "${command}" exited with code ${code}${detail}`));
      });
      child.stdin?.end(text);
    });
  }
}

/**
 * A test-only clipboard that records writes in memory and NEVER touches the real system clipboard
 * (D-009). Construct with `failWith` to simulate an unavailable clipboard command/API so the tool's
 * structured-failure path can be exercised without spawning anything.
 */
export class CaptureClipboard implements ClipboardWriter {
  readonly writes: string[] = [];

  constructor(private readonly failWith?: string) {}

  write(text: string): Promise<void> {
    if (this.failWith) {
      return Promise.reject(new Error(this.failWith));
    }
    this.writes.push(text);
    return Promise.resolve();
  }

  get last(): string | undefined {
    return this.writes[this.writes.length - 1];
  }
}

const realClipboardWriter: ClipboardWriter = new SpawnClipboardWriter();
let activeWriter: ClipboardWriter = realClipboardWriter;

/** Swaps the active clipboard writer (tests inject a CaptureClipboard so no real write happens). */
export function setClipboardWriter(writer: ClipboardWriter): void {
  activeWriter = writer;
}

/** Restores the real spawn-backed writer (afterEach in tests). */
export function resetClipboardWriter(): void {
  activeWriter = realClipboardWriter;
}

/** The writer the clipboard surface currently writes through. */
export function getClipboardWriter(): ClipboardWriter {
  return activeWriter;
}

const Params = Schema.Struct({
  text: Schema.String.annotations({
    description: "The exact plain text to place on the system clipboard; copied verbatim.",
  }),
});

type ClipboardWriteParams = typeof Params.Type;

const DESCRIPTION =
  "Write exactly the given plain text to the user's system clipboard. This is the ONLY way to put " +
  "text on the clipboard - never suggest, describe, or run a shell clipboard command such as pbcopy, " +
  "clip, or wl-copy, and never try to read the clipboard. Pass the final text verbatim in `text`; it " +
  "is copied as-is. Returns JSON {copied: true, charCount} on success.";

/** clipboard_write: writes exactly the supplied plain text to the host system clipboard. */
export const clipboardWriteTool: Tool<ClipboardWriteParams> = simpleTool({
  name: "clipboard_write",
  description: DESCRIPTION,
  // Not readOnly: it mutates external clipboard state, so the loop runs it as a serial barrier.
  params: Params,
  execute: async ({ text }) => {
    try {
      await activeWriter.write(text);
    } catch (error) {
      toolExecution(`clipboard write failed: ${msg(error)}`);
    }
    return JSON.stringify({ copied: true, charCount: text.length });
  },
});
