/**
 * The currently active agent run cell: one place owns the live run id and the optional mid-turn
 * model-switch cell. It keeps turn start, run lifecycle, and switch handling from sharing mutable
 * variables in main.ts.
 *
 * Responsible for: storing and querying the active run id plus its switch cell.
 * Not for: scheduling runs, publishing lifecycle events, or applying model-switch decisions.
 */

import type { SwitchCell } from "./switch-cell";

type CurrentRun = {
  readonly runId: string;
  readonly switchCell?: SwitchCell;
};

export class ActiveRun {
  #current: CurrentRun | null = null;

  open(runId: string, switchCell?: SwitchCell): void {
    this.#current = { runId, ...(switchCell ? { switchCell } : {}) };
  }

  clear(runId: string): void {
    if (this.#current?.runId === runId) {
      this.#current = null;
    }
  }

  runId(): string | null {
    return this.#current?.runId ?? null;
  }

  switchCellFor(runId: string): SwitchCell | null {
    if (!this.#current) {
      return null;
    }
    if (runId !== "" && this.#current.runId !== runId) {
      return null;
    }
    return this.#current.switchCell ?? null;
  }
}
