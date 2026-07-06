import { msg } from "@host/transport/messages";
import type { EmitEvent } from "@host/transport/services";
import { events } from "@trevor/session";

/**
 * The programmatic command-reply seam (deepen C-20). The immediate command lane shapes its reply
 * centrally through {@link CommandRunResult} and never hand-emits; the programmatic lane (the host
 * handlers the web sends `/worktree-*`, `/handoff`, `/clear`, `/cd`, `/serial-*`, ... to) used to
 * hand-spell `emit(events.commandResult({ command, text, ok }))` at every reply, re-typing the command
 * name at each site and re-inlining the "Failed to <verb>: <error>" phrasing.
 *
 * A {@link CommandReplier} binds `emit` + ONE command name once, so the name, the `command.result`
 * shape, and the failure phrasing each get a single owner. It does not replace `emit`: a handler that
 * also publishes other events (a handoff's lifecycle events, a session switch) keeps emitting those
 * directly and uses the replier only for its `command.result`.
 *
 * Responsible for: shaping + emitting a programmatic command's `command.result` (ok/fail/failed).
 * Not for: the immediate command lane (commands.ts shapes that via CommandRunResult) or any other event.
 */
export interface CommandReplier {
  /** Emit a success `command.result`. */
  ok(text: string): Promise<void>;
  /** Emit a failure `command.result`. */
  fail(text: string): Promise<void>;
  /** Emit a `command.result` whose ok is computed (e.g. a sub-operation's `result.ok`). */
  result(text: string, ok: boolean): Promise<void>;
  /** Emit the standard "Failed to <verb>: <error>" failure result (the one owner of that phrasing). */
  failed(error: unknown, verb: string): Promise<void>;
}

/** Binds a command name to an emit sink, producing that command's {@link CommandReplier}. */
export type ReplyFor = (command: string) => CommandReplier;

/** Builds a {@link ReplyFor} over an emit sink; a command factory wires it once from its injected emit. */
export function commandReplier(emit: EmitEvent): ReplyFor {
  return (command) => ({
    ok: (text) => emit(events.commandResult({ command, text, ok: true })),
    fail: (text) => emit(events.commandResult({ command, text, ok: false })),
    result: (text, ok) => emit(events.commandResult({ command, text, ok })),
    failed: (error, verb) =>
      emit(events.commandResult({ command, text: `Failed to ${verb}: ${msg(error)}`, ok: false })),
  });
}
