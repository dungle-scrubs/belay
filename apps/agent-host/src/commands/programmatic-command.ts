import { warn } from "@host/transport/log";
import { msg } from "@host/transport/messages";

/**
 * Dispatches host-owned programmatic commands behind one named handler table.
 *
 * Responsible for: command-name lookup, fallback dispatch, and uniform async error logging.
 * Not for: command specs, user-facing command result text, or deciding leader/live eligibility.
 */
export interface ProgrammaticCommandHandler {
  readonly name: string;
  readonly errorLabel?: string;
  run(args: string): Promise<void> | void;
}

export interface ProgrammaticCommandDispatcher {
  dispatch(command: string, args: string): void;
}

export function createProgrammaticCommandDispatcher(opts: {
  readonly handlers: readonly ProgrammaticCommandHandler[];
  readonly fallback: (command: string, args: string) => Promise<void> | void;
}): ProgrammaticCommandDispatcher {
  const handlers = new Map(opts.handlers.map((handler) => [handler.name, handler]));

  return {
    dispatch(command, args) {
      const handler = handlers.get(command);
      const label = handler?.errorLabel ?? (command.replace(/^\//, "") || "command");
      const run = handler ? () => handler.run(args) : () => opts.fallback(command, args);
      Promise.resolve(run()).catch((error) =>
        warn("host", `${label} failed`, { command, error: msg(error) }),
      );
    },
  };
}
