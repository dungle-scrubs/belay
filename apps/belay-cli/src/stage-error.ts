import { errorMessage } from "@belay/session";

export class CliStageError extends Error {
  readonly stage: string;

  constructor(stage: string, message: string) {
    super(message);
    this.name = "CliStageError";
    this.stage = stage;
  }
}

export function isCliStageError(error: unknown): error is CliStageError {
  return error instanceof CliStageError;
}

export async function withCliStage<T>(stage: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw isCliStageError(error) ? error : new CliStageError(stage, errorMessage(error));
  }
}
