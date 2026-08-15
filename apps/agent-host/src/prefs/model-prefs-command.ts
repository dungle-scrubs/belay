import {
  decodeModelRef,
  events,
  type ModelRef,
  modelRefKey,
  pinModel,
  sameModel,
  setDefaultModel,
  type TrevorEventInput,
  unpinModel,
} from "@belay/session";
import type { ModelPrefsFile } from "./model-prefs-store";
import { toModelPreferences } from "./model-prefs-store";

/**
 * The host command that mutates the model preference (plan 51). Setting the default and toggling a
 * favorite are host round-trips (the /vim / /style re-announce pattern), not local writes: the browser
 * publishes one of these commands with a JSON {@link ModelRef} arg, the host applies the PURE
 * @belay/session transition to the persisted `{ default, pinned }` subset, saves it, and re-announces
 * `host.online` so every open client re-renders from the fresh preference.
 *
 * Responsible for: the command names, the pure apply (reusing setDefaultModel / pinModel / unpinModel),
 * and the injectable runner (decode -> apply -> persist -> re-announce, or an error result on a bad ref).
 * Not for: persistence/cache (model-prefs-store.ts) or the pure transitions themselves (@belay/session).
 */

/** Sets the durable default model (the one a fresh session starts on). */
export const MODEL_DEFAULT_COMMAND = "/model-default";
/** Toggles a model in the favorites (pinned) list - the host decides add-vs-remove from its own state,
 *  so the browser never has to compute membership or race the announcement. */
export const MODEL_FAVORITE_COMMAND = "/model-favorite";

/** The model-preference command names, so main.ts registers exactly this set. */
export const MODEL_PREFS_COMMANDS = [MODEL_DEFAULT_COMMAND, MODEL_FAVORITE_COMMAND] as const;

/** Whether a command name is a model-preference mutation. */
export function isModelPrefsCommand(name: string): boolean {
  return (MODEL_PREFS_COMMANDS as readonly string[]).includes(name);
}

/** Decodes a model-preference command's JSON {@link ModelRef} arg, or null when it is unusable (not
 *  JSON, or a ref with no source/model id) so the command is rejected without corrupting the store. */
export function decodeModelPrefsArg(args: string): ModelRef | null {
  try {
    return decodeModelRef(JSON.parse(args));
  } catch {
    return null;
  }
}

/**
 * Pure: applies a set-default or toggle-favorite to the persisted `{ default, pinned }` subset, reusing
 * the @belay/session transitions (never re-implementing default/pin logic). A favorite toggle removes
 * the ref when already pinned, else adds it. Returns the next subset; the caller persists it.
 */
export function applyModelPrefsCommand(
  file: ModelPrefsFile,
  command: string,
  ref: ModelRef,
): ModelPrefsFile {
  const current = toModelPreferences(file);
  const next =
    command === MODEL_DEFAULT_COMMAND
      ? setDefaultModel(current, ref)
      : file.pinned.some((r) => sameModel(r, ref))
        ? unpinModel(current, ref)
        : pinModel(current, ref);
  return { default: next.default, pinned: next.pinned };
}

/** The seams the runner needs: the store's load/save, the event sink, and the re-announce. Injected so
 *  the runner is unit-tested without disk or a live transport. */
export interface ModelPrefsCommandDeps {
  readonly load: () => ModelPrefsFile;
  readonly save: (next: ModelPrefsFile) => void;
  readonly emit: (event: TrevorEventInput) => Promise<void> | void;
  readonly announce: () => void;
}

/** A one-line result summary for the command.result the browser shows in the command lane. */
function resultText(command: string, ref: ModelRef, before: ModelPrefsFile): string {
  const key = modelRefKey(ref);
  if (command === MODEL_DEFAULT_COMMAND) {
    return `Default model set to ${key}.`;
  }
  const removed = before.pinned.some((r) => sameModel(r, ref));
  return removed ? `Removed ${key} from favorites.` : `Added ${key} to favorites.`;
}

/**
 * Runs a model-preference command: decode the ref, apply the pure transition, persist it, publish an ok
 * result, and re-announce host.online (so every open client updates without a restart). A malformed ref
 * is rejected with an ok:false result and NO write or announce - the store is never corrupted. Returns
 * whether it mutated (for the caller/tests).
 */
export async function runModelPrefsCommand(
  deps: ModelPrefsCommandDeps,
  command: string,
  args: string,
): Promise<boolean> {
  const ref = decodeModelPrefsArg(args);
  if (!ref) {
    await deps.emit(
      events.commandResult({
        command,
        text: "Ignored a malformed model reference.",
        ok: false,
      }),
    );
    return false;
  }
  const before = deps.load();
  const next = applyModelPrefsCommand(before, command, ref);
  deps.save(next);
  await deps.emit(
    events.commandResult({ command, text: resultText(command, ref, before), ok: true }),
  );
  deps.announce();
  return true;
}
