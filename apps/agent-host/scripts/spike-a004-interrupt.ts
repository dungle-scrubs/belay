// A-004 regression check: interrupting a fiber that consumes the real provider Stream
// tears the pi-ai / LM Studio request down, rather than letting the model keep generating.
//
// It runs provider.stream (the production Stream, whose scope aborts the underlying
// request on interruption) inside a forked fiber, lets tokens flow, interrupts the fiber
// mid-generation, then checks whether tokens KEEP arriving. If the abort propagates the
// count freezes; if it leaks the count keeps climbing during the grace window.
//
// Requires LM Studio reachable with the qwen model loaded. Run:
//   pnpm exec tsx scripts/spike-a004-interrupt.ts
import { Cause, Effect, Exit, Fiber, Stream } from "effect";

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
let done = false;
// The production Stream: its scope finalizer aborts the controller pi-ai streams under,
// so interrupting the consuming fiber tears the request down.
const fiber = Effect.runFork(
  Stream.runForEach(provider.stream(messages, [], "off"), () =>
    Effect.sync(() => {
      events += 1;
    }),
  ),
);
fiber.addObserver(() => {
  done = true;
});

// Wait until streaming is clearly underway (or the stream finishes / times out first).
const waitStart = Date.now();
while (events < 20 && !done && Date.now() - waitStart < 30_000) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

if (done) {
  console.error(`INCONCLUSIVE: stream ended before interrupt (events=${events}). Retry.`);
  process.exit(2);
}

const eventsAtInterrupt = events;
console.log(`streaming underway: ${eventsAtInterrupt} events received; interrupting the fiber...`);
const exit = await Effect.runPromise(Fiber.interrupt(fiber));

// Grace window: if the abort propagated, the count is frozen; if it leaked, it climbs.
await new Promise((resolve) => setTimeout(resolve, 2500));
const eventsAfterGrace = events;
const deltaAfterInterrupt = eventsAfterGrace - eventsAtInterrupt;
const interrupted = Exit.isFailure(exit) && Cause.isInterrupted(exit.cause);

console.log({ interrupted, eventsAtInterrupt, eventsAfterGrace, deltaAfterInterrupt });

// Teardown holds if the fiber ended interrupted and essentially no tokens arrived after
// the interrupt (a couple in-flight before the abort landed is fine).
if (interrupted && deltaAfterInterrupt <= 2) {
  console.log("A-004 PASS: fiber interrupt tears down the pi-ai / LM Studio stream.");
  process.exit(0);
}
console.error(
  "A-004 FAIL: the stream kept producing after interrupt (leak); use race-and-abandon.",
);
process.exit(1);
