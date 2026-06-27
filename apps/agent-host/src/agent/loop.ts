import type {
  ProviderDiagnostic,
  ProviderIncidentReason,
  ProviderPartialCounts,
  TurnStop,
} from "@trevor/session";
import { Clock, Deferred, Duration, Effect, Option, Ref, Stream } from "effect";
import { debug } from "../log";
import type {
  ChatMessage,
  ModelEvent,
  Provider,
  ProviderError,
  ToolCall,
  ToolDef,
} from "../providers";
import { ProviderUnavailable } from "../providers/errors";
import { redactSecrets } from "../providers/failure-taxonomy";
import { recordObservation } from "../providers/observation-store";
import { classifyProviderProtocolAnomaly } from "../providers/protocol-anomaly";
import { providerFailureLogFields } from "../providers/provider-failure-log";
import { executeTool, READ_ONLY_TOOLS, TOOL_DEFS } from "../tools";
import { cheapestReasoning, reduceReasoning, trimLargestToolResult } from "./recovery";
import {
  initialRetrySafetyState,
  isSafeToRetry,
  noteProviderEvent,
  outputStarted,
} from "./retry-safety";
import { evaluateTurnTermination } from "./turn-policy";

/**
 * Emits the structured, redacted provider-failure log line (D-076 M6): the classification, retry
 * decision, attempt number, source/model, phase, and stable fingerprint - behind the verbose
 * `provider` debug scope, where the richer shape metadata (status/code/field names) is useful. Never
 * logs a raw payload; the detail is re-redacted by the field builder.
 */
function logProviderFailure(
  provider: Provider,
  error: ProviderError,
  attempt: number,
  outcome: "reconnect" | "terminal",
): void {
  const unavailable = error instanceof ProviderUnavailable ? error : undefined;
  debug(
    "provider",
    outcome === "reconnect" ? "reconnect" : "failure",
    providerFailureLogFields({
      provider: provider.id,
      model: provider.model,
      phase: "model-step",
      classification: unavailable?.classification,
      retryable: unavailable?.retryable ?? false,
      userAction: unavailable?.userAction,
      attempt,
      outcome,
      status: unavailable?.evidence?.status,
      code: unavailable?.evidence?.code,
      shapeFields: unavailable?.evidence?.shapeFields,
      detail: unavailable?.detail ?? error.message,
    }),
  );
}

/**
 * Best-effort: when a model step fails terminally with an UNKNOWN provider failure shape, record it
 * as a redacted, deduped observation under TREVOR_HOME (D-076 M5). Emits nothing and never fails -
 * the underlying store swallows any write error - so it can be `concat`-ed ahead of the real failure
 * without changing the turn's outcome. Only `unknown` is observed; well-classified terminal failures
 * (auth, quota, model/runtime unavailable, request rejected) already carry their own action.
 */
function observeUnknownFailure(
  provider: Provider,
  error: ProviderError,
  outputStarted: boolean,
): Stream.Stream<never, never> {
  if (error._tag !== "ProviderUnavailable" || error.classification !== "unknown") {
    return Stream.empty;
  }
  return Stream.fromEffect(
    Effect.promise(() =>
      recordObservation(
        {
          provider: error.provider,
          model: provider.model,
          phase: "model-step",
          classification: "unknown",
          retryable: error.retryable ?? false,
          status: error.evidence?.status,
          code: error.evidence?.code,
          message: error.detail,
          shapeFields: error.evidence?.shapeFields,
          outputStarted,
        },
        new Date().toISOString(),
      ),
    ),
  ).pipe(Stream.drain);
}

function incidentReasonOf(error: ProviderError): ProviderIncidentReason {
  if (error._tag === "ProviderAuthError") {
    return "auth";
  }
  if (error.classification === "transient_transport") {
    return "transport_loss";
  }
  if (error.classification === "context_overflow") {
    return "context_overflow";
  }
  return error.classification ?? "unknown";
}

function providerDiagnostic(
  provider: Provider,
  error: ProviderError,
  attempt: number,
  safeToRetry: boolean,
  partials: ProviderPartialCounts,
): ProviderDiagnostic {
  const unavailable = error instanceof ProviderUnavailable ? error : undefined;
  const detail = redactSecrets(unavailable?.detail ?? error.message);
  return {
    provider: provider.id,
    model: provider.model,
    phase: "model-step",
    reason: incidentReasonOf(error),
    retryable: unavailable?.retryable === true,
    safeToRetry,
    attempt,
    detail,
    partials,
    ...(unavailable?.evidence?.status !== undefined ? { status: unavailable.evidence.status } : {}),
    ...(unavailable?.evidence?.code ? { code: unavailable.evidence.code } : {}),
    ...(unavailable?.evidence?.requestId ? { requestId: unavailable.evidence.requestId } : {}),
  };
}

function withDiagnostic(error: ProviderError, diagnostic: ProviderDiagnostic): ProviderError {
  if (error instanceof ProviderUnavailable) {
    return new ProviderUnavailable({
      provider: error.provider,
      detail: error.detail,
      cause: error.cause,
      retryable: error.retryable,
      classification: error.classification,
      userAction: error.userAction,
      retryAfterMs: error.retryAfterMs,
      evidence: error.evidence,
      diagnostic,
    });
  }
  return error;
}

/**
 * Provider-stream idle watchdog (ms): if a model stream produces no event for this long, treat it as
 * a stalled (half-open) connection and fail it, so the loop retries or goes terminal instead of
 * hanging forever - the fix for the 18-minute "Working" stall where a half-open Codex stream sent no
 * tokens, close, or error. Env-overridable; set to 0 to disable. Default 90s (xhigh reasoning can
 * pause for a while, so the gap is generous - it only catches a genuinely dead stream).
 */
const STREAM_STALL_MS = (() => {
  const raw = process.env.TREVOR_STREAM_STALL_MS;
  return raw !== undefined && Number.isFinite(Number(raw)) ? Number(raw) : 90_000;
})();

/**
 * Wraps a provider stream with the idle watchdog: a scoped fiber polls the time since the last event
 * and, past STREAM_STALL_MS, fails the stream with a RETRYABLE ProviderUnavailable. The loop's
 * existing reconnect `catchAll` then retries (when nothing has streamed yet) or, once tokens have
 * flowed, surfaces it as a clear terminal error. A normal end, the stall failure, or an interrupt
 * (ESC/cancel) all close the stream scope and tear the watchdog down.
 */
function withStallTimeout<A>(
  source: Stream.Stream<A, ProviderError>,
  providerName: string,
): Stream.Stream<A, ProviderError> {
  if (STREAM_STALL_MS <= 0) {
    return source;
  }
  return Stream.unwrapScoped(
    Effect.gen(function* () {
      const lastSeen = yield* Ref.make(yield* Clock.currentTimeMillis);
      const stalled = yield* Deferred.make<never, ProviderError>();
      const bump = Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.set(lastSeen, now)));
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          for (;;) {
            yield* Effect.sleep(Duration.millis(Math.min(STREAM_STALL_MS, 5_000)));
            const idle = (yield* Clock.currentTimeMillis) - (yield* Ref.get(lastSeen));
            if (idle >= STREAM_STALL_MS) {
              yield* Deferred.fail(
                stalled,
                new ProviderUnavailable({
                  provider: providerName,
                  detail: `model stream stalled (no output for ${Math.round(STREAM_STALL_MS / 1000)}s)`,
                  retryable: true,
                }),
              );
              return;
            }
          }
        }),
      );
      const guarded = source.pipe(Stream.tap(() => bump));
      const failOnStall: Stream.Stream<never, ProviderError> = Stream.fromEffect(
        Deferred.await(stalled),
      );
      // haltStrategy "left": the merged stream ends when the SOURCE ends (we don't wait on the
      // never-resolving watchdog); a stall failure still propagates immediately from either side.
      return Stream.merge(guarded, failOnStall, { haltStrategy: "left" });
    }),
  );
}

/**
 * Bounded auto-reconnect for a transient provider outage (D-076…D-079): backoff (ms) BEFORE each
 * retry. Two entries = three total attempts (the initial plus two retries). A small jitter is added
 * so simultaneous turns don't reconnect in lockstep. The budget is per-step and independent of
 * MAX_STEPS and the overflow-recovery budget, so reconnection can never spin.
 */
const RECONNECT_BACKOFFS_MS = [300, 900] as const;
const MAX_RECONNECT_ATTEMPTS = RECONNECT_BACKOFFS_MS.length + 1;

/** Runaway backstop, NOT the everyday governor: it only bounds a pathological tool loop
 *  that never converges. The real budget is context pressure (CONTEXT_BUDGET_FRACTION below),
 *  so a turn normally stops because it's out of ROOM, never at an arbitrary step count (D-053). */
const MAX_STEPS = 32;
/** Max read-only tool calls a single step runs concurrently (D-050). Mutating calls are never
 *  part of a concurrent run - each is a serial barrier - so this only bounds in-flight reads. */
const TOOL_CONCURRENCY = 8;
/** Stop opening new tool rounds once the latest prompt reaches this fraction of the model's
 *  context window, and force a final answer instead. Falls back to MAX_STEPS-only when the
 *  window is unknown (0). This is the governor; MAX_STEPS is the backstop (D-053). */
const CONTEXT_BUDGET_FRACTION = 0.8;
/** Per-turn cap on in-loop overflow-recovery adjustments, independent of MAX_STEPS so
 *  recovery can never spin (D-037). */
const MAX_RECOVERY = 2;

/**
 * Heuristic: did the model END a turn by ANNOUNCING an imminent action without calling a tool?
 * A weaker model sometimes trails off ("Let me continue reading the remaining files:") and stops
 * instead of emitting the next tool batch, which the loop would otherwise accept as a final answer.
 * Deliberately conservative - it only fires on a clear trailing announcement (a dangling colon, or a
 * closing "let me read…/I'll continue…" clause), so a genuine final answer is never mistaken for one.
 * Worst case on a false positive is one wasted nudge step, bounded to once per turn.
 */
export function looksUnfinished(text: string): boolean {
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(":")) {
    return true; // "...let me read these files:" - about to list/act, then stopped
  }
  const tail = trimmed.slice(-160).toLowerCase();
  return /\b(let me|i'?ll|i will|now i|next,? i)\b.{0,90}\b(continue|read|look|check|explore|examine|review|proceed|start|dive|go through)\b[^.!?]*$/.test(
    tail,
  );
}

/** One ordered segment of a step's tool batch: a maximal run of consecutive read-only calls
 *  (run concurrently) OR a single mutating call (a serial barrier). Each entry keeps the call's
 *  original index so its result commits to the right `conversation` slot in CALL order. */
type ToolSegment = ReadonlyArray<{ readonly call: ToolCall; readonly index: number }>;

/**
 * Partitions a step's tool batch into ordered segments for concurrent dispatch (D-050).
 * Consecutive read-only calls (per `READ_ONLY_TOOLS`) coalesce into one maximal run; every
 * mutating call breaks the run and forms its own singleton barrier. Segment order preserves
 * emission order, so a mutating call still executes in place relative to the reads around it.
 */
export function partitionToolCalls(calls: readonly ToolCall[]): readonly ToolSegment[] {
  const segments: { call: ToolCall; index: number }[][] = [];
  let run: { call: ToolCall; index: number }[] | null = null;
  calls.forEach((call, index) => {
    if (READ_ONLY_TOOLS.has(call.name)) {
      if (!run) {
        run = [];
        segments.push(run);
      }
      run.push({ call, index });
    } else {
      // A mutating call is its own barrier and ends any open read run.
      segments.push([{ call, index }]);
      run = null;
    }
  });
  return segments;
}

/** One event from the agent loop: the shared model-step events (`ModelEvent`: text,
 *  thinking, usage, overflow) forwarded unchanged from the provider, plus the loop-only
 *  cases - tool start/end (the loop turns a provider tool_call into these as it executes),
 *  a recovery adjustment (an in-turn overflow rung - distinct from compaction, the durable
 *  history summarization deferred to D-036), a `reconnecting` status (a transient provider outage
 *  is being auto-retried before any token streamed - D-076…D-079), a `step_limit` (the turn hit its
 *  budget and is forcing a final answer - D-051), or an empty answer. */
export type AgentEvent =
  | ModelEvent
  | { readonly type: "tool_start"; readonly call: ToolCall }
  | { readonly type: "tool_end"; readonly call: ToolCall; readonly result: string }
  | {
      readonly type: "recovered";
      readonly action: "trim" | "reduce-thinking";
      readonly detail: string;
      readonly reclaimed: number;
    }
  | { readonly type: "stop"; readonly stop: TurnStop }
  | { readonly type: "step_limit"; readonly steps: number }
  | {
      readonly type: "reconnecting";
      readonly attempt: number;
      readonly detail: string;
      readonly diagnostic?: ProviderDiagnostic;
    }
  | { readonly type: "empty" };

/**
 * The model<->tools loop as a Stream of AgentEvents: stream a model step; if it
 * requested tools, execute them (emitting start/end) and recurse; otherwise the model
 * answered and the stream ends. Bounded by MAX_STEPS to prevent runaway tool loops.
 *
 * Cancellation is fiber interruption: interrupting the consumer halts the recursion and
 * the in-flight provider stream tears its request down (A-004) - no manual abort checks.
 * `conversation`, and each step's `toolCalls`/`assistantText`, are mutable closures read
 * by the deferred (post-model-step) Stream stages after the model step has drained.
 */
/**
 * The delegation capability injected into a PARENT turn (D-048): the delegation tool defs to offer
 * (delegate_inline / delegate_background) and the runner that executes one. The loop intercepts a
 * call to a delegation tool and routes it here (the runner has the provider + transport + parent
 * context the generic tool executor lacks) instead of `executeTool`. A CHILD turn is given no
 * capability, which is how depth-1 is enforced structurally: a child can neither see nor invoke
 * delegation (D-048).
 */
export interface DelegateCapability {
  readonly defs: readonly ToolDef[];
  readonly names: ReadonlySet<string>;
  /** Runs one delegation tool-call, resolving to the model-facing tool result. */
  readonly run: (name: string, args: string) => Promise<string>;
}

/** Options for a turn: a subagent's tool allow-list, and (for a parent) the delegation capability. */
export interface RunAgentOptions {
  readonly toolNames?: ReadonlySet<string>;
  readonly delegate?: DelegateCapability;
}

export function runAgent(
  provider: Provider,
  history: readonly ChatMessage[],
  reasoning?: string,
  runId?: string,
  useTools = true,
  opts: RunAgentOptions = {},
): Stream.Stream<AgentEvent, ProviderError> {
  const conversation: ChatMessage[] = [...history];
  // The model is OFFERED only the allow-listed tools; the executor enforces the same set below, so
  // a child can neither see nor run a tool outside its agent's allow-list. A parent additionally
  // gets the delegation tools (a child gets none - depth-1).
  const registryTools = useTools ? TOOL_DEFS : [];
  const allowed = opts.toolNames
    ? registryTools.filter((t) => opts.toolNames?.has(t.name))
    : registryTools;
  const delegate = opts.delegate;
  const tools = delegate ? [...allowed, ...delegate.defs] : allowed;
  const runTool = (name: string, args: string): Effect.Effect<string> => {
    // A delegation tool-call is routed to the injected runner (it has the provider + transport the
    // generic executor lacks); everything else goes to the executor, gated by the allow-list.
    if (delegate?.names.has(name)) {
      return Effect.promise(() => delegate.run(name, args));
    }
    return opts.toolNames && !opts.toolNames.has(name)
      ? Effect.succeed(`error: tool "${name}" is not available to this agent`)
      : executeTool(name, args, runId);
  };
  // One retry budget for an empty answer (the model ending a turn with no text and no
  // tool calls). A single nudge often gets it to synthesize; if it stays empty we
  // surface it rather than ending silently.
  let emptyRetried = false;
  // One retry budget for a turn that ends with text but NO tool call where the text trails off
  // mid-task ("let me continue reading…") instead of finishing - nudge it once to actually act.
  let continueRetried = false;

  // Graceful overflow recovery (D-034..D-038): in-loop, per-turn, cheap rungs only,
  // bounded so it can never spin. Recovery adjusts the reasoning level and the in-loop
  // tool results (everything appended after the prior history starts at baseIndex).
  const baseIndex = history.length;
  let recoveryBudget = MAX_RECOVERY;
  let currentReasoning = reasoning;
  let thinkingReduced = false;

  // The latest model step's prompt size + window, captured from its usage event (like
  // overflowReason). Drives the context-pressure budget (D-053): when the prompt that fed
  // the last step crosses CONTEXT_BUDGET_FRACTION of the window, the next round forces a
  // final answer instead of opening more tool calls. Both 0 until the first usage arrives.
  let lastInputTokens = 0;
  let lastContextWindow = 0;
  let repeatedToolName: string | undefined;
  let repeatedToolSignature: string | undefined;
  let repeatedToolRounds = 0;

  // One overflow adjustment: mutate the conversation/reasoning in place and return a
  // `recovered` event, or null when nothing cheap is left. Cheapest-first and
  // provider-aware - cut thinking (the output lever) when the model hit the wall
  // mid-response and thinking is on, else trim the largest tool result (the input
  // lever). The expensive rungs (summarize history, raise the loaded window) are
  // deferred to backlog (D-036).
  const tryRecover = (reason: string): AgentEvent | null => {
    if (recoveryBudget <= 0) {
      return null;
    }
    const reduced = thinkingReduced
      ? null
      : reduceReasoning(provider.reasoningLevels, currentReasoning);
    const reduceThinking = (): AgentEvent => {
      currentReasoning = reduced ?? currentReasoning;
      thinkingReduced = true;
      recoveryBudget -= 1;
      return {
        type: "recovered",
        action: "reduce-thinking",
        detail: `reduced thinking to ${reduced}`,
        reclaimed: 0,
      };
    };
    // Hit the wall mid-response (output overran): cut thinking (the output lever) first.
    if (reason.includes("mid-response") && reduced !== null) {
      return reduceThinking();
    }
    // Otherwise the prompt itself is too big: trim the largest tool result (input lever).
    // Reducing thinking can't shrink the input, so it's not a fallback here - if there's
    // nothing to trim, recovery is done and the terminal overflow surfaces.
    const trim = trimLargestToolResult(conversation, baseIndex);
    if (trim) {
      recoveryBudget -= 1;
      return {
        type: "recovered",
        action: "trim",
        detail: `trimmed ${trim.tool} output`,
        reclaimed: trim.reclaimed,
      };
    }
    return null;
  };

  // Budget reached (step backstop or context gate): force ONE final answer instead of ending
  // silently on a tool stub (D-051, D-052). Tools are removed so the model must answer from
  // what it already gathered; a transient nudge is pushed into the LOCAL `conversation` only -
  // never emitted, never persisted (durable history is rebuilt from emitted events, not this
  // array). Reasoning is forced to the cheapest level, and it runs exactly once (no recursion,
  // no tools to recurse on). An empty result falls through to the `empty` -> noReply path, so a
  // capped turn still never dead-ends in silence. `step_limit` is emitted first as the
  // observable termination signal, then the forced answer streams as ordinary text.
  const synthesize = (n: number, stop: TurnStop): Stream.Stream<AgentEvent, ProviderError> =>
    Stream.suspend(() => {
      conversation.push({
        role: "user",
        content:
          "You have reached your tool-call budget for this turn. Do not call any more tools. " +
          "Answer the original request now, as completely as you can from what you have already gathered.",
      });
      const synthReasoning = cheapestReasoning(provider.reasoningLevels);
      let answer = "";
      const model = withStallTimeout(
        provider.stream(conversation, [], synthReasoning),
        provider.model,
      ).pipe(
        Stream.filterMap((event) => {
          // Tools were removed; drop any stray tool_call/overflow and keep text/thinking/usage.
          if (event.type === "tool_call" || event.type === "overflow") {
            return Option.none<AgentEvent>();
          }
          if (event.type === "text") {
            answer += event.text;
          }
          return Option.some<AgentEvent>(event);
        }),
      );
      const afterSynthesis = Stream.unwrap(
        Effect.sync(() =>
          answer.trim() === "" ? Stream.succeed<AgentEvent>({ type: "empty" }) : Stream.empty,
        ),
      );
      return Stream.concat(
        Stream.succeed<AgentEvent>({ type: "stop", stop }),
        Stream.concat(
          Stream.succeed<AgentEvent>({ type: "step_limit", steps: n }),
          Stream.concat(model, afterSynthesis),
        ),
      );
    });

  // Stream.suspend keeps each step lazy: its provider.stream (which reads `conversation`)
  // is constructed only when the stream actually reaches this step - after the prior
  // step's tools have run and threaded their results - never eagerly while building it.
  const step = (n: number): Stream.Stream<AgentEvent, ProviderError> =>
    Stream.suspend(() => {
      // Budget gate before opening another tool round: the step backstop OR - the real
      // governor - the prior step's prompt crossing CONTEXT_BUDGET_FRACTION of the window.
      // Either way force a final answer rather than ending on a tool stub. At step 0 both are
      // clear (no prior usage), so the first round always runs.
      const decision = evaluateTurnTermination({
        steps: n,
        maxSteps: MAX_STEPS,
        inputTokens: lastInputTokens,
        contextWindow: lastContextWindow,
        contextBudgetFraction: CONTEXT_BUDGET_FRACTION,
        repeatedToolName,
        repeatedToolRounds,
      });
      if (decision.type === "synthesize") {
        return synthesize(n, decision.stop);
      }
      if (decision.type === "pause" || decision.type === "fail") {
        return Stream.concat(
          Stream.succeed<AgentEvent>({ type: "stop", stop: decision.stop }),
          Stream.succeed<AgentEvent>({ type: "step_limit", steps: n }),
        );
      }
      const toolCalls: ToolCall[] = [];
      let assistantText = "";
      let overflowReason: string | null = null;

      // The model step: forward the shared ModelEvent variants (text/thinking/usage)
      // straight through - they ARE AgentEvents - while siphoning off assistant text
      // (accumulated), tool calls (collected, into tool_start/tool_end below), and any
      // overflow (captured for recovery below - not surfaced here).
      //
      // Auto-reconnect (D-076…D-079): a transient provider outage that drops the stream BEFORE any
      // event arrives is retried with bounded backoff, emitting a `reconnecting` marker between
      // attempts. The `sawEvent` guard is load-bearing: a retry only happens when nothing streamed,
      // so the siphon closures (toolCalls/assistantText/overflowReason) are still clean and a retry
      // never double-counts. Once any event has streamed - or the error is non-retryable, or the
      // attempt budget is spent - the failure propagates and the turn goes terminal exactly as
      // before. Interrupts (ESC/cancel) ride the interrupt channel, not this typed `E` channel, so
      // catchAll never sees them: they are never retried and cancel stays instant during a backoff.
      const connectStep = (attempt: number): Stream.Stream<AgentEvent, ProviderError> => {
        let retrySafety = initialRetrySafetyState();
        const mapped = withStallTimeout(
          provider.stream(conversation, tools, currentReasoning),
          provider.model,
        ).pipe(
          Stream.filterMap((event) => {
            retrySafety = noteProviderEvent(retrySafety, event);
            if (event.type === "tool_call") {
              toolCalls.push(event.call);
              return Option.none<AgentEvent>();
            }
            if (event.type === "overflow") {
              // Capture; afterModel decides recover-and-retry vs terminal (D-035, D-038).
              overflowReason = event.reason;
              return Option.none<AgentEvent>();
            }
            if (event.type === "text") {
              assistantText += event.text;
            }
            if (event.type === "usage") {
              // Capture the prompt size + window for the next round's context-budget gate.
              lastInputTokens = event.usage.input;
              lastContextWindow = event.usage.contextWindow;
            }
            // text/thinking/usage flow through unchanged (shared ModelEvent shapes).
            return Option.some<AgentEvent>(event);
          }),
        );
        return mapped.pipe(
          Stream.catchAll((error) => {
            const retryable = error._tag === "ProviderUnavailable" && error.retryable === true;
            const safeToRetry = isSafeToRetry(retrySafety);
            if (safeToRetry && retryable && attempt < MAX_RECONNECT_ATTEMPTS) {
              const next = attempt + 1;
              const base = RECONNECT_BACKOFFS_MS[attempt - 1] ?? 0;
              const wait = base + Math.round(Math.random() * 150); // small jitter, no lockstep
              logProviderFailure(provider, error, next, "reconnect");
              const diagnostic = providerDiagnostic(
                provider,
                error,
                next,
                true,
                retrySafety.partials,
              );
              return Stream.concat(
                Stream.succeed<AgentEvent>({
                  type: "reconnecting",
                  attempt: next,
                  detail: error.detail,
                  diagnostic,
                }),
                Stream.unwrap(
                  Effect.sleep(Duration.millis(wait)).pipe(Effect.as(connectStep(next))),
                ),
              );
            }
            // Terminal: log the classified failure with its fingerprint (D-076 M6), then - for an
            // UNKNOWN shape only - record a redacted, deduped observation (D-076 M5) so the
            // classifier's rules can improve later. Best-effort and output-started-aware; never fails
            // the turn.
            logProviderFailure(provider, error, attempt, "terminal");
            const diagnostic = providerDiagnostic(
              provider,
              error,
              attempt,
              safeToRetry,
              retrySafety.partials,
            );
            const diagnosticError = withDiagnostic(error, diagnostic);
            return Stream.concat(
              observeUnknownFailure(provider, diagnosticError, outputStarted(retrySafety)),
              Stream.fail(diagnosticError),
            );
          }),
        );
      };
      const modelStep = connectStep(1);

      // Built lazily (Stream.unwrap defers the thunk until the model step has drained), so
      // it reads the now-populated toolCalls/assistantText: run each tool in order, then
      // recurse to the next step. No tool calls means the model answered - stop.
      const afterModel = Stream.unwrap(
        Effect.sync(() => {
          // Overflow recovery: try one cheap in-loop adjustment and re-run the SAME step
          // (n unchanged, so recovery is independent of MAX_STEPS). Only when the budget
          // is spent does the terminal overflow surface (D-038).
          if (overflowReason !== null) {
            const recovered = tryRecover(overflowReason);
            if (recovered) {
              return Stream.concat(Stream.succeed(recovered), step(n));
            }
            return Stream.succeed<AgentEvent>({ type: "overflow", reason: overflowReason });
          }
          if (toolCalls.length === 0) {
            // The model answered. An answer with no text is a stall (it emitted only a
            // stop token) - retry the step once, then surface an `empty` event so the
            // turn never ends silently (which is what poisons the next turn's history).
            if (assistantText.trim() === "") {
              if (!emptyRetried) {
                emptyRetried = true;
                // An empty answer is usually the accumulated prior history poisoning the
                // model into an immediate stop. Retry against only the current task -
                // drop everything before this turn's own user message, keeping the work
                // it just did - which reliably recovers a real answer.
                conversation.splice(0, Math.max(0, history.length - 1));
                return step(n);
              }
              return Stream.succeed<AgentEvent>({ type: "empty" });
            }
            const protocolDiagnostic = classifyProviderProtocolAnomaly({
              providerId: provider.id,
              text: assistantText,
              toolCalls,
            });
            if (protocolDiagnostic) {
              const decision = evaluateTurnTermination({
                steps: n,
                maxSteps: MAX_STEPS,
                inputTokens: lastInputTokens,
                contextWindow: lastContextWindow,
                contextBudgetFraction: CONTEXT_BUDGET_FRACTION,
                repeatedToolName,
                repeatedToolRounds,
                providerDiagnostic: protocolDiagnostic,
              });
              if (decision.type === "continue") {
                return Stream.empty;
              }
              return Stream.succeed<AgentEvent>({
                type: "stop",
                stop: decision.stop,
              });
            }
            // Non-empty text, no tool call. Normally this IS the final answer - but if the text
            // trails off announcing more work it never did, nudge it once to carry it out. If it
            // still answers without tools after the nudge, accept it (bounded, can't loop).
            if (!continueRetried && looksUnfinished(assistantText)) {
              continueRetried = true;
              conversation.push({ role: "assistant", content: assistantText });
              conversation.push({
                role: "user",
                content:
                  "You ended by describing work without doing it. Call the tools to carry out what you just described now, or give your final answer - do not announce actions you do not take.",
              });
              return step(n);
            }
            return Stream.empty;
          }
          conversation.push({
            role: "assistant",
            content: assistantText,
            toolCalls: [...toolCalls],
          });
          const toolCall = toolCalls.length === 1 ? toolCalls[0] : undefined;
          const toolName = toolCall?.name;
          const toolSignature = toolCall ? `${toolCall.name}:${toolCall.arguments}` : undefined;
          if (toolSignature && toolSignature === repeatedToolSignature) {
            repeatedToolRounds += 1;
          } else {
            repeatedToolName = toolName;
            repeatedToolSignature = toolSignature;
            repeatedToolRounds = toolName ? 1 : 0;
          }
          // Each call writes its result into an index-keyed slot instead of pushing to
          // `conversation` on completion: concurrent read children finish in any order, but
          // the slots commit to history deterministically in CALL order after the batch drains
          // (so recovery + the next step always see one canonical, call-ordered conversation).
          const slots: string[] = new Array(toolCalls.length);

          // One call's execution as a Stream: run the tool, store its result in the slot, emit
          // tool_end. tool_start is emitted separately (hoisted ahead of the merge, in call
          // order) so the transcript shows every read card in call order even though the
          // executes overlap; only the result-bearing tool_end rides out in completion order,
          // which the web tolerates by keying results on call.id (D-050 / M4).
          const execute = (
            call: ToolCall,
            index: number,
          ): Stream.Stream<AgentEvent, ProviderError> =>
            Stream.fromEffect(
              runTool(call.name, call.arguments).pipe(
                Effect.map((result): AgentEvent => {
                  slots[index] = result;
                  return { type: "tool_end", call, result };
                }),
              ),
            );

          // Partition into ordered segments (maximal read-only runs vs single mutating barriers)
          // and run them back-to-back. Within a read run the executes merge, bounded by
          // TOOL_CONCURRENCY; a barrier is a one-element merge, so it runs alone. Because the
          // segments are concatenated, a mutating call never overlaps the reads around it - two
          // edits to one path apply in call order with no lost update (D-050 / M3).
          const batch = partitionToolCalls(toolCalls).reduce(
            (acc, segment) => {
              const starts = Stream.fromIterable(
                segment.map(({ call }): AgentEvent => ({ type: "tool_start", call })),
              );
              const executes = Stream.mergeAll(
                segment.map(({ call, index }) => execute(call, index)),
                { concurrency: TOOL_CONCURRENCY },
              );
              return Stream.concat(acc, Stream.concat(starts, executes));
            },
            Stream.empty as Stream.Stream<AgentEvent, ProviderError>,
          );

          // Commit the slots to `conversation` in CALL order once the whole batch has drained,
          // then open the next step - so step(n+1) reads a fully-committed, deterministically
          // ordered conversation regardless of which reads finished first.
          const commit = Stream.unwrap(
            Effect.sync(() => {
              toolCalls.forEach((call, i) => {
                conversation.push({
                  role: "tool",
                  content: slots[i] ?? "",
                  toolCallId: call.id,
                  name: call.name,
                });
              });
              return step(n + 1);
            }),
          );
          return Stream.concat(batch, commit);
        }),
      );

      return Stream.concat(modelStep, afterModel);
    });

  return step(0);
}
