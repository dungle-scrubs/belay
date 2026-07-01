import {
  createLineReader,
  decodeHostToRunner,
  encodeMessage,
  RUNNER_PROTOCOL_VERSION,
} from "./protocol";
import { createRunnerCore } from "./runner-core";

/**
 * The `tool_script` child-runner ENTRY POINT (plan 16, M3): the spawnable process that runs user script
 * code. It is intentionally MINIMAL and imports only the protocol + the runner core (never the agent-host
 * tool registry), so the process carries no ambient Trevor authority. It wires the runner core to stdio -
 * host messages arrive on stdin (newline-delimited JSON, buffer-capped), the core's messages go out on
 * stdout - announces `start`, and exits when stdin closes.
 *
 * Powered by an OS sandbox (M4) when available; the process boundary alone is the deny-first floor.
 */

const MAX_LINE_BYTES = 1_000_000;

function main(): void {
  const core = createRunnerCore((message) => process.stdout.write(encodeMessage(message)));
  const reader = createLineReader({ maxLineBytes: MAX_LINE_BYTES });

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    for (const line of reader.push(chunk)) {
      const message = decodeHostToRunner(line);
      if (message) {
        core.handle(message);
      }
    }
  });
  // When the host closes the pipe, the run is over - exit cleanly.
  process.stdin.on("end", () => process.exit(0));

  process.stdout.write(encodeMessage({ type: "start", protocol: RUNNER_PROTOCOL_VERSION }));
}

main();
