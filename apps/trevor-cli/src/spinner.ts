/**
 * A tiny, dependency-free terminal spinner for the launcher's live progress (D-085). It animates a
 * single line through the launch phases (resolving project → readying services → waiting for host →
 * …) so `trevor` gives immediate feedback during the several seconds of startup instead of sitting
 * silent. Uses the same braille frames `ora` does; on a non-TTY (piped/CI) it degrades to one printed
 * line per step so logs stay readable. Writes to stderr, leaving stdout for the final status block.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CLEAR_LINE = "\r\x1b[2K";
const FRAME_MS = 80;

export interface Spinner {
  /** Set the current phase label (starts the animation on the first call). */
  step(text: string): void;
  /** Stop with a green check + final line. */
  succeed(text: string): void;
  /** Stop with a red cross + final line. */
  fail(text: string): void;
  /** Stop and clear the line without a terminal mark. */
  stop(): void;
}

export function createSpinner(stream: NodeJS.WriteStream = process.stderr): Spinner {
  const tty = Boolean(stream.isTTY);
  let text = "";
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const paint = (): void => {
    stream.write(`${CLEAR_LINE}${CYAN}${FRAMES[frame]}${RESET} ${text}`);
    frame = (frame + 1) % FRAMES.length;
  };
  const ensureRunning = (): void => {
    if (timer || !tty) {
      return;
    }
    timer = setInterval(paint, FRAME_MS);
    // Never keep the process alive just for the spinner.
    timer.unref?.();
  };
  const halt = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return {
    step(next) {
      text = next;
      if (!tty) {
        stream.write(`${DIM}•${RESET} ${next}\n`);
        return;
      }
      ensureRunning();
      paint();
    },
    succeed(done) {
      halt();
      stream.write(`${tty ? CLEAR_LINE : ""}${GREEN}✔${RESET} ${done}\n`);
    },
    fail(done) {
      halt();
      stream.write(`${tty ? CLEAR_LINE : ""}${RED}✖${RESET} ${done}\n`);
    },
    stop() {
      halt();
      if (tty) {
        stream.write(CLEAR_LINE);
      }
    },
  };
}
