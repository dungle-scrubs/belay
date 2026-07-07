/**
 * Responsible for: the model-facing `process` tool and the host-wide supervisor singleton.
 * Not for: job spawn/track/output mechanics - process-registry.ts.
 */
import { type ProcessError, type ToolExecutionError, ToolInputError } from "@host/tools/errors";
import { cap } from "@host/tools/shared";
import type { Tool } from "@host/tools/types";
import { Effect, Schema } from "effect";
import { ProcessRegistry } from "./process-registry";

export type {
  JobInfo,
  JobOrigin,
  JobSnapshot,
  JobSource,
  ProcessStatus,
} from "./process-registry";

const ProcessParams = Schema.Struct({
  action: Schema.Literal("start", "poll", "kill", "list", "dismiss", "clear_completed"),
  command: Schema.optional(Schema.String).annotations({
    description: "Shell command to start (action=start)",
  }),
  id: Schema.optional(Schema.String).annotations({
    description: "Process id (action=poll or kill)",
  }),
  stdoutCursor: Schema.optionalWith(Schema.Number, { default: () => 0 }).annotations({
    description: "Last stdout cursor from poll",
  }),
  stderrCursor: Schema.optionalWith(Schema.Number, { default: () => 0 }).annotations({
    description: "Last stderr cursor from poll",
  }),
});

export class ProcessSupervisor extends ProcessRegistry {
  buildTool(): Tool<typeof ProcessParams.Type> {
    return {
      name: "process",
      description:
        "Run and manage long-lived background processes (dev servers, watchers, builds). The bash tool blocks until a command finishes; use this for anything meant to keep running. Actions: start {command} -> begins it, returns an id; poll {id, stdoutCursor?, stderrCursor?} -> new output since the cursor plus an updated cursor; kill {id} -> SIGTERM for a running job; dismiss {id} -> remove a completed job from tracking without killing anything; clear_completed -> remove all completed jobs, keeping running jobs; list -> all jobs.",
      params: ProcessParams,
      execute: (args) =>
        Effect.try({
          try: () => {
            switch (args.action) {
              case "start": {
                const command = (args.command ?? "").trim();
                if (!command) {
                  throw new ToolInputError({
                    tool: "process",
                    detail: "command required for start",
                  });
                }
                return JSON.stringify(this.start(command, process.cwd()));
              }
              case "poll":
                return cap(
                  JSON.stringify(this.poll(args.id ?? "", args.stdoutCursor, args.stderrCursor)),
                );
              case "kill":
                return JSON.stringify(this.kill(args.id ?? ""));
              case "dismiss":
                return JSON.stringify(this.dismiss(args.id ?? ""));
              case "clear_completed":
                return JSON.stringify(this.clearCompleted());
              case "list":
                return JSON.stringify(this.list());
            }
          },
          catch: (error) => error as ProcessError | ToolInputError | ToolExecutionError,
        }),
    };
  }
}

/** Host-wide supervisor: one registry shared by the process tool and /jobs. */
export const supervisor = new ProcessSupervisor();
