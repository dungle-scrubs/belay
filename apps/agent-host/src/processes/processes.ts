import { Effect, Schema } from "effect";
import { ProcessRegistry } from "./process-registry";
import { type ProcessError, type ToolExecutionError, ToolInputError } from "./tools/errors";
import { cap } from "./tools/shared";
import type { Tool } from "./tools/types";

export type {
  JobInfo,
  JobOrigin,
  JobSnapshot,
  JobSource,
  ProcessStatus,
} from "./process-registry";

const ProcessParams = Schema.Struct({
  action: Schema.Literal("start", "poll", "kill", "list"),
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
        "Run and manage long-lived background processes (dev servers, watchers, builds). The bash tool blocks until a command finishes; use this for anything meant to keep running. Actions: start {command} -> begins it, returns an id; poll {id, stdoutCursor?, stderrCursor?} -> new output since the cursor plus an updated cursor; kill {id} -> SIGTERM; list -> all jobs.",
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
