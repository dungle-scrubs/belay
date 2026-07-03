/**
 * A second Claude source that runs Claude through the TypeScript Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`) billed to the user's Max-plan subscription, alongside the
 * `anthropic` source (raw Messages API, billed to API credits). Each `stream()` call spawns ONE SDK
 * `query()` NAKED - a custom system prompt that fully replaces Claude Code's default, zero tools (so
 * the SDK's own agent loop terminates after one text-only turn), no filesystem settings, and a child
 * env that injects `CLAUDE_CODE_OAUTH_TOKEN` while DELETING `ANTHROPIC_API_KEY` so a stale key can't
 * silently bill API credits (D-002). Text-only in this cut: `capabilities().tools` is false and no
 * tool is ever exposed to the SDK (D-004).
 *
 * Responsible for: the Claude-Code Provider impl (describe/readiness/capabilities/warm/stream), the
 * naked `query()` spawn + env hygiene, and the SDK-event -> ProviderEvent mapping over an injected
 * `query` seam.
 * Not for: the `~/.pi/auth.json` anthropic OAuth source (anthropic.ts), or the source registry /
 * configured-signal wiring (catalog.ts / provider-auth.ts).
 */
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { activeStyleGuidance } from "@host/prefs/style-store";
import { Effect, Stream } from "effect";
import { ProviderAuthError } from "./errors";
import { normalizeProviderFailure } from "./failure-normalizer";
import { generationTimer } from "./generation-timer";
import { resolveContextWindow } from "./model-metadata-overrides";
import { deriveModelShape, lookupPiModel } from "./pi-model";
import { cliTokenPresent } from "./provider-auth";
import { defaultReasoningLevel } from "./reasoning-policy";
import { buildSystemPrompt } from "./system-prompt";
import {
  type ChatMessage,
  DescribableProvider,
  type ModelCapabilities,
  type ProviderError,
  type ProviderEvent,
  type Readiness,
  type ToolDef,
} from "./types";

/** The pi-ai registry provider id whose Claude model shapes (reasoning surface, vision, context
 *  window) enrich this source - the SAME models as the `anthropic` source, only billed differently. */
const ANTHROPIC = "anthropic";

/** The stable source/provider id: the catalog's SourceDef row, its dispatch, and this provider's
 *  typed failures all share it, so a rename is one edit. */
export const CLAUDE_CODE_SOURCE_ID = "claude-code";

/** The long-lived Max-plan token (from `claude setup-token`) that bills inference to the subscription.
 *  Injected into the child env so the SDK subprocess uses it. */
export const CLAUDE_CODE_OAUTH_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

/** The API-credit key. Precedence is `ANTHROPIC_API_KEY > CLAUDE_CODE_OAUTH_TOKEN`, so a stale key
 *  silently wins and bills credits - the child env deletes it entirely (D-002). */
const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

/** A cloud model with no confirmed context window falls back to this for the usage/ctx meter. */
const DEFAULT_CLAUDE_CONTEXT_WINDOW = 200_000;

/**
 * The Agent SDK `query` seam: params in, an async iterable of SDK messages out. The real SDK `query`
 * satisfies this ({@link Query} extends `AsyncGenerator<SDKMessage>`); tests inject a fake so the
 * spawn options + event mapping are exercised without a live subprocess.
 */
export type SdkQuery = (params: {
  readonly prompt: string | AsyncIterable<SDKUserMessage>;
  readonly options?: Options;
}) => AsyncIterable<SDKMessage>;

export interface ClaudeCodeConfig {
  /** A Claude model id from pi-ai's anthropic registry, e.g. claude-opus-4-0. */
  readonly model: string;
  /** Human-friendly name for the UI selector (distinct from the `anthropic` source's label). */
  readonly label: string;
  /** The Agent SDK query seam; defaults to the lazily-imported real SDK `query`. Injected in tests. */
  readonly query?: SdkQuery;
  /** The env the CLI token is read from and the child env is derived from; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * The default query seam: the real Agent SDK `query`, imported LAZILY so pulling this module in at
 * host boot (via catalog.ts) does not load the SDK until a claude-code turn actually streams.
 */
const defaultQuery: SdkQuery = (params) =>
  (async function* () {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    for await (const message of query(params)) {
      yield message;
    }
  })();

/** The CLI token from an env, or null when absent/empty. Presence is decided by the shared
 *  `cliTokenPresent` predicate (provider-auth.ts) - the same signal the catalog's configured
 *  projection reads - so "what counts as a present token" lives once (D-003). */
export function resolveClaudeCodeToken(env: NodeJS.ProcessEnv = process.env): string | null {
  return cliTokenPresent(env, CLAUDE_CODE_OAUTH_ENV) ? (env[CLAUDE_CODE_OAUTH_ENV] ?? null) : null;
}

/**
 * Builds the SDK subprocess env (D-002): the `env` option REPLACES the child env entirely, so the
 * parent env is copied for inherited vars (PATH/HOME/...), the API-credit key is DELETED (removed, not
 * emptied - an empty string is unreliable and the precedence lets a stale key win), and the Max OAuth
 * token is injected so inference bills the subscription.
 */
export function buildChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  token: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...parentEnv };
  delete env[ANTHROPIC_API_KEY_ENV];
  env[CLAUDE_CODE_OAUTH_ENV] = token;
  return env;
}

/**
 * Renders the host conversation into the SDK's single string prompt. This source is text-only (no
 * tool turns to round-trip), and each stream() is a fresh naked query() with no persisted session, so
 * the whole history rides in the prompt with role labels; the trailing user turn is the one the model
 * answers.
 */
function toPrompt(messages: readonly ChatMessage[]): string {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n\n");
}

/** A terminal SDK `result` message with an error subtype, thrown so it rides the stream's error path. */
class ClaudeCodeResultError extends Error {
  constructor(subtype: string, errors: readonly string[]) {
    super(`claude code SDK error (${subtype}): ${errors.join("; ") || "no detail"}`);
    this.name = "ClaudeCodeResultError";
  }
}

/**
 * Streams one naked `query()` and maps its SDK messages onto host ProviderEvents: a `text_delta`
 * partial -> `text`, a `thinking_delta` partial -> `thinking`, the success `result` -> `usage`, and an
 * error-subtype `result` throws (mapped to a typed ProviderError downstream). Generation timing runs
 * from the first streamed token so tokens/sec covers the produced span.
 */
async function* claudeCodeEvents(
  query: SdkQuery,
  params: {
    readonly prompt: string;
    readonly options: Options;
    readonly contextWindow: number;
  },
): AsyncIterable<ProviderEvent> {
  const timer = generationTimer();
  for await (const message of query({ prompt: params.prompt, options: params.options })) {
    if (message.type === "stream_event") {
      const event = message.event;
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          timer.mark();
          yield { type: "text", text: event.delta.text };
        } else if (event.delta.type === "thinking_delta") {
          timer.mark();
          yield { type: "thinking", text: event.delta.thinking };
        }
      }
    } else if (message.type === "result") {
      if (message.subtype === "success") {
        yield {
          type: "usage",
          usage: {
            input: message.usage.input_tokens ?? 0,
            output: message.usage.output_tokens ?? 0,
            contextWindow: params.contextWindow,
            genMs: timer.genMs(),
          },
        };
      } else {
        throw new ClaudeCodeResultError(message.subtype, message.errors ?? []);
      }
    }
  }
}

export interface ClaudeCodeStreamOptions {
  /** The Agent SDK query seam (injected in tests). */
  readonly query: SdkQuery;
  /** The system prompt that FULLY REPLACES Claude Code's default (built by the caller). */
  readonly systemPrompt: string;
  readonly messages: readonly ChatMessage[];
  /** The resolved CLI token, or null to fail closed (never spawn, never bill API credits). */
  readonly token: string | null;
  /** The env the child env is derived from; defaults to `process.env`. */
  readonly parentEnv?: NodeJS.ProcessEnv;
  /** The context window carried on the usage event; defaults to the Claude default. */
  readonly contextWindow?: number;
  /** The provider id on typed failures; defaults to {@link CLAUDE_CODE_SOURCE_ID}. */
  readonly provider?: string;
}

/**
 * One model step as an Effect Stream of ProviderEvents, over the injected `query` seam. It fails
 * CLOSED when no CLI token is present (a typed ProviderAuthError, never a spawn), otherwise it runs
 * one naked `query()` under an AbortController registered as a scoped finalizer - so interrupting the
 * consuming fiber tears the subprocess down (matching stream()'s no-signal contract). A thrown or
 * error-subtype terminal failure rides the typed ProviderError channel.
 */
export function streamClaudeCode(
  opts: ClaudeCodeStreamOptions,
): Stream.Stream<ProviderEvent, ProviderError> {
  const provider = opts.provider ?? CLAUDE_CODE_SOURCE_ID;
  if (opts.token === null) {
    return Stream.fail(
      new ProviderAuthError({
        provider,
        detail: `no ${CLAUDE_CODE_OAUTH_ENV}: run \`claude setup-token\``,
      }),
    );
  }
  const env = buildChildEnv(opts.parentEnv ?? process.env, opts.token);
  return Stream.unwrapScoped(
    Effect.gen(function* () {
      const controller = new AbortController();
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
      // The naked-per-turn spawn: a custom prompt that fully replaces the default, zero tools (so the
      // SDK's agent loop has nothing to call and stops after one text turn), no filesystem settings,
      // no permission prompts, partial messages for token streaming, and the billing-correct child env.
      const options: Options = {
        systemPrompt: opts.systemPrompt,
        tools: [],
        settingSources: [],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        env,
        abortController: controller,
      };
      return Stream.fromAsyncIterable(
        claudeCodeEvents(opts.query, {
          prompt: toPrompt(opts.messages),
          options,
          contextWindow: opts.contextWindow ?? DEFAULT_CLAUDE_CONTEXT_WINDOW,
        }),
        // The shared boundary normalizer: classifies the failure (a Max-plan overload / rate limit
        // becomes retryable with a class + user action) and redacts secrets from the detail (a
        // subprocess error can echo the injected token) - same path as every other provider.
        (cause) => normalizeProviderFailure({ provider, cause }),
      );
    }),
  );
}

/**
 * Claude via the Agent SDK on the Max subscription. Cloud (always warm); the reasoning surface + image
 * support + context window are derived from the pi-ai anthropic registry model (metadata only - this
 * source streams through the SDK, not pi-ai), with a safe fallback so a just-released model id still
 * starts the host. Tools are NEVER exposed (D-004), so `capabilities().tools` is false.
 */
export class ClaudeCodeProvider extends DescribableProvider {
  readonly id = CLAUDE_CODE_SOURCE_ID;
  readonly kind = "cloud" as const;
  readonly label: string;
  readonly model: string;
  readonly reasoningLevels: readonly string[];
  readonly defaultReasoning: string;
  private readonly images: boolean;
  private readonly contextWindow: number;
  private readonly query: SdkQuery;
  private readonly env: NodeJS.ProcessEnv;

  constructor(config: ClaudeCodeConfig) {
    super();
    this.label = config.label;
    this.model = config.model;
    this.query = config.query ?? defaultQuery;
    this.env = config.env ?? process.env;
    // Derive the reasoning surface + vision from the registry model via the shared derivation
    // (pi-model.ts); a registry miss falls back to a reasoning-capable Claude shape.
    const shape = deriveModelShape(() => lookupPiModel(ANTHROPIC, config.model), {
      levels: ["off", "high"],
      images: true,
    });

    this.reasoningLevels = shape.levels;
    this.images = shape.images;
    this.defaultReasoning = defaultReasoningLevel(shape.levels);
    // The EFFECTIVE window, through the single resolver (03.2 D-004): a confirmed models.json
    // override or a learned window corrects a stale bundled value here, exactly like every other
    // cloud path (pi-ai-base), so the usage/ctx meter budgets against the real ceiling.
    this.contextWindow =
      resolveContextWindow(config.model, shape.contextWindow) ?? DEFAULT_CLAUDE_CONTEXT_WINDOW;
  }

  /** Vision follows the registry model; tools are always false (never exposed to the SDK, D-004);
   *  context 0 - cloud models carry ample context, so the turn's context guard skips it. */
  capabilities(): Effect.Effect<ModelCapabilities> {
    return Effect.succeed({ images: this.images, tools: false, contextLength: 0 });
  }

  /** Cloud, so always warm; ready when the CLI token is present (a DIFFERENT store than the anthropic
   *  source's ~/.pi/auth.json OAuth entry - D-003). */
  readiness(): Effect.Effect<Readiness> {
    return Effect.sync(() => ({ ready: resolveClaudeCodeToken(this.env) !== null, warm: true }));
  }

  warm(): Effect.Effect<void> {
    return Effect.void;
  }

  /**
   * One naked query() per step. The host-passed `tools` are IGNORED (this source never exposes tools),
   * and `reasoning` is model-driven (the SDK has no per-turn reasoning-effort option). The system
   * prompt is the tool-less answer-only prompt, which fully replaces Claude Code's default.
   */
  stream(
    messages: readonly ChatMessage[],
    _tools: readonly ToolDef[],
    _reasoning?: string,
  ): Stream.Stream<ProviderEvent, ProviderError> {
    const systemPrompt = buildSystemPrompt([], { styleGuidance: activeStyleGuidance() });
    return streamClaudeCode({
      query: this.query,
      systemPrompt,
      messages,
      token: resolveClaudeCodeToken(this.env),
      parentEnv: this.env,
      contextWindow: this.contextWindow,
      provider: this.id,
    });
  }
}

export function claudeCodeProvider(config: ClaudeCodeConfig): ClaudeCodeProvider {
  return new ClaudeCodeProvider(config);
}
