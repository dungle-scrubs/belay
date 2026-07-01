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

/**
 * Network/runtime primitives blunted on the child's `globalThis` (defense in depth): even code that reaches
 * the real global object - e.g. `Function("return fetch")()`, which the runner's lexical shadowing cannot
 * cover - then finds no egress primitive. Node internals never read these off `globalThis`, so nulling them
 * does not disturb the runner's own IO. This is NOT the safety boundary (the OS sandbox in M4 is); dynamic
 * `import()` and `process` stay the sandbox's job, covered by the deferred deep-isolation review.
 */
const NEUTRALIZED_GLOBALS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Bun", "Deno"];

function neutralizeNetworkGlobals(): void {
  for (const name of NEUTRALIZED_GLOBALS) {
    // Reflect returns false (never throws) if a global is non-configurable; the OS sandbox is the backstop.
    Reflect.defineProperty(globalThis, name, {
      value: undefined,
      configurable: true,
      writable: true,
    });
  }
}

function main(): void {
  // Capture the stdio handles the runner needs BEFORE neutralizing globals, so scrubbing does not affect
  // the runner's own IO (the neutralization targets only what a later-running user script could reach).
  const stdin = process.stdin;
  const stdout = process.stdout;
  const exit = process.exit.bind(process);

  const core = createRunnerCore((message) => stdout.write(encodeMessage(message)));
  const reader = createLineReader({ maxLineBytes: MAX_LINE_BYTES });

  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => {
    for (const line of reader.push(chunk)) {
      const message = decodeHostToRunner(line);
      if (message) {
        core.handle(message);
      }
    }
  });
  // When the host closes the pipe, the run is over - exit cleanly.
  stdin.on("end", () => exit(0));

  stdout.write(encodeMessage({ type: "start", protocol: RUNNER_PROTOCOL_VERSION }));

  neutralizeNetworkGlobals();
}

main();
