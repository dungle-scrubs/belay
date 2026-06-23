// A-004 spike: does interrupting an Effect fiber actually tear down the pi-ai /
// LM Studio stream, or does the model keep generating (a leak)?
//
// It builds the realistic slice-4 bridge - an Effect whose interruption aborts the
// AbortController that pi-ai streams under - forks it as a fiber, lets tokens flow,
// interrupts mid-stream, then checks whether tokens KEEP arriving afterward. If the
// abort propagates to the underlying request, the token count freezes; if it leaks,
// the count keeps climbing during the grace window.
//
// Requires LM Studio reachable with the qwen model loaded. Run:
//   pnpm exec tsx scripts/spike-a004-interrupt.ts
import { Effect, Fiber } from "effect";

// Pin the load target to whatever is already loaded so provider.stream's
// ensureMaxContext is a no-op (we are testing interrupt, not model loading).
process.env.LMSTUDIO_MAX_CONTEXT = process.env.LMSTUDIO_MAX_CONTEXT ?? "262144";
const { buildProviders } = await import("../src/providers");
const provider = buildProviders().qwen;
if (!provider) {
  console.error("SKIP: no qwen provider configured");
  process.exit(2);
}

const { ready, warm } = await provider.readiness();
if (!ready) {
  console.error("SKIP: LM Studio not reachable - cannot validate A-004");
  process.exit(2);
}
console.log(`provider ready (warm=${warm}); starting a long generation...`);

const messages = [
  {
    role: "user" as const,
    content:
      "Count slowly from 1 to 400. Put each number on its own line with a one-sentence reflection after it. Do not stop early.",
  },
];

let events = 0;
let loopExited = false;
let loopError: string | null = null;
const controller = new AbortController();

// The slice-4 cancellation bridge: Effect.async whose returned canceler aborts the
// controller when the fiber is interrupted. That controller's signal is what pi-ai
// (and thus the LM Studio HTTP request) streams under.
const streamProgram = Effect.async<void>((resume) => {
  void (async () => {
    try {
      for await (const _event of provider.stream(messages, [], "off", controller.signal)) {
        events += 1;
      }
      loopExited = true;
      resume(Effect.void);
    } catch (error) {
      loopExited = true;
      loopError = error instanceof Error ? error.message : String(error);
      resume(Effect.void);
    }
  })();
  return Effect.sync(() => controller.abort());
});

const fiber = Effect.runFork(streamProgram);

// Wait until streaming is clearly underway (or the stream finishes / times out first).
const waitStart = Date.now();
while (events < 20 && !loopExited && Date.now() - waitStart < 30_000) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

if (loopExited) {
  console.error(
    `INCONCLUSIVE: stream ended before interrupt (events=${events}, error=${loopError ?? "none"}). Retry with a longer prompt.`,
  );
  process.exit(2);
}

const eventsAtInterrupt = events;
console.log(`streaming underway: ${eventsAtInterrupt} events received; interrupting the fiber...`);
await Effect.runPromise(Fiber.interrupt(fiber));

// Grace window: if the abort propagated, the count is frozen; if it leaked, it climbs.
await new Promise((resolve) => setTimeout(resolve, 2500));
const eventsAfterGrace = events;
const deltaAfterInterrupt = eventsAfterGrace - eventsAtInterrupt;

console.log({
  signalAborted: controller.signal.aborted,
  loopExited,
  loopError,
  eventsAtInterrupt,
  eventsAfterGrace,
  deltaAfterInterrupt,
});

// Teardown holds if the signal aborted, the consume loop terminated, and essentially no
// tokens arrived after the interrupt (a couple in-flight before the abort landed is fine).
const torndown = controller.signal.aborted && loopExited && deltaAfterInterrupt <= 2;
if (torndown) {
  console.log("A-004 PASS: fiber interrupt tears down the pi-ai / LM Studio stream.");
  process.exit(0);
}
console.error(
  "A-004 FAIL: the stream kept producing after interrupt (leak); use race-and-abandon.",
);
process.exit(1);
