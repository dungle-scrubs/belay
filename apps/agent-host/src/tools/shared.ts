/** Largest tool output returned to the model; anything longer is truncated. */
export const MAX_OUTPUT = 8000;

/** Directories never descended into by glob/grep. */
export const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|\.next)\//u;

/** Caps tool output at MAX_OUTPUT characters, with a truncation marker. */
export function cap(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated]` : text;
}

/** Normalizes an unknown thrown value to its message string. */
export function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Tool-argument coercers shared by the tool executors (args arrive as `unknown`).
/** A present value as a string, or undefined when the field was omitted. */
export const optStr = (value: unknown): string | undefined =>
  value === undefined ? undefined : String(value);

/** A finite number, or 0 (used for cursors/counts). */
export const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** A string array when given one, else undefined (omitted ≠ empty). */
export const strArr = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
