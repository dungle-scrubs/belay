import type { PromptInput, TrevorClient } from "@trevor/sdk";
import { type ArtifactRef, formatDoctorReport } from "@trevor/session";

/**
 * The headless `trevor` commands (plan 28 M8): scriptable, host-agnostic verbs built ENTIRELY on the
 * `@trevor/sdk` workflows - prompt/stream/cancel a turn, read a transcript, run capabilities/doctor, and
 * put/get artifacts. Every command supports a machine `--json` mode (pure JSON to stdout, no spinners or
 * human noise) and a human mode. They are pure over an injected `TrevorClient`, so they unit-test against
 * a recording transport without a running store; `main.ts` supplies the real SDK client + service URLs.
 *
 * These are deliberately NOT in the SDK: command names, argument parsing, output formatting, and exit
 * behavior are terminal-product concerns (D-003). The SDK returns data and operations; the CLI presents.
 */

export interface HeadlessResult {
  /** The text to write to stdout. */
  readonly stdout: string;
}

/** Renders a JSON payload for `--json` mode: stable 2-space pretty JSON, one trailing entity. */
function jsonOut(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export interface PromptCommandOptions {
  readonly sessionId: string;
  readonly text: string;
  readonly provider: string;
  readonly model?: PromptInput["model"];
  readonly json: boolean;
  readonly timeoutMs?: number;
  /** A live sink for assistant deltas (human mode streaming); omitted in JSON/quiet mode. */
  readonly onDelta?: (text: string) => void;
}

/**
 * `trevor prompt <session> <text>`: submits a prompt into the session and streams the correlated turn to
 * completion. Human mode returns the assistant's final answer (streaming deltas to `onDelta` as they
 * arrive); JSON mode returns the structured turn record `{ runId, text, cancelled, timedOut }`.
 */
export async function runPrompt(
  client: TrevorClient,
  options: PromptCommandOptions,
): Promise<HeadlessResult> {
  await client.ensureSession(options.sessionId);
  // Scope the turn stream to events AFTER the current head, so a prior turn's completion is not mistaken
  // for this one; then open the stream BEFORE publishing so the fresh turn's events are never missed.
  const head = await client.readLog(options.sessionId, { timeoutMs: 10_000 });
  const afterSeq = head.length > 0 ? (head[head.length - 1]?.seq ?? 0) : 0;
  const turn = client.streamTurn(options.sessionId, {
    afterSeq,
    timeoutMs: options.timeoutMs,
    onEvent: (event) => {
      if (event.type === "assistant.delta" && options.onDelta) {
        options.onDelta(String(event.payload.text ?? ""));
      }
    },
  });
  await client.prompt(options.sessionId, {
    text: options.text,
    provider: options.provider,
    ...(options.model ? { model: options.model } : {}),
  });
  const result = await turn;
  if (options.json) {
    return {
      stdout: jsonOut({
        runId: result.runId,
        text: result.text,
        cancelled: result.cancelled,
        timedOut: result.timedOut,
      }),
    };
  }
  if (result.timedOut) {
    return {
      stdout: `(no completion within the timeout; run \`trevor transcript ${options.sessionId}\`)`,
    };
  }
  const suffix = result.cancelled ? "\n(cancelled)" : "";
  return { stdout: `${result.text}${suffix}` };
}

/** `trevor cancel <session> <runId>`: publishes the D-094 `user.cancel` control event (not a signal). */
export async function runCancel(
  client: TrevorClient,
  sessionId: string,
  runId: string,
): Promise<HeadlessResult> {
  if (!runId) {
    return { stdout: "usage: trevor cancel <session> <runId>" };
  }
  await client.cancel(sessionId, runId);
  return { stdout: `Requested cancel of run ${runId} in ${sessionId}.` };
}

/** `trevor transcript <session>`: prints the projected transcript, JSON or one line per entry. */
export async function runTranscript(
  client: TrevorClient,
  sessionId: string,
  json: boolean,
): Promise<HeadlessResult> {
  const transcript = await client.readTranscript(sessionId, { timeoutMs: 10_000 });
  if (json) {
    return { stdout: jsonOut(transcript.entries) };
  }
  if (transcript.entries.length === 0) {
    return { stdout: "(empty transcript)" };
  }
  const lines = transcript.entries.map((entry) => {
    const label = entry.tool ? `${entry.role}(${entry.tool})` : entry.role;
    return `[${label}] ${entry.text}`;
  });
  return { stdout: lines.join("\n") };
}

/** `trevor doctor <session>`: prints the host's `/doctor` snapshot as JSON or the human report. */
export async function runDoctor(
  client: TrevorClient,
  sessionId: string,
  json: boolean,
  timeoutMs?: number,
): Promise<HeadlessResult> {
  const snapshot = await client.doctor(sessionId, timeoutMs ? { timeoutMs } : undefined);
  if (!snapshot) {
    return { stdout: "(the host returned a non-structured doctor result)" };
  }
  return { stdout: json ? jsonOut(snapshot) : formatDoctorReport(snapshot) };
}

/** `trevor capabilities <session>`: prints the host's capability manifest export (JSON or text). */
export async function runCapabilities(
  client: TrevorClient,
  sessionId: string,
  options: { readonly json: boolean; readonly section?: string; readonly timeoutMs?: number },
): Promise<HeadlessResult> {
  const result = await client.exportCapabilities(sessionId, {
    format: options.json ? "json" : "text",
    ...(options.section ? { section: options.section } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  return { stdout: result.format === "json" ? jsonOut(result.manifest) : result.text };
}

/** `trevor artifact put <file>`: uploads bytes and prints the content-addressed ref. */
export async function runArtifactPut(
  client: TrevorClient,
  bytes: Uint8Array,
  mimeType: string,
  options: { readonly name?: string; readonly json: boolean },
): Promise<HeadlessResult> {
  const ref: ArtifactRef = await client.uploadArtifact(bytes, mimeType, {
    ...(options.name ? { name: options.name } : {}),
  });
  if (options.json) {
    return { stdout: jsonOut(ref) };
  }
  return { stdout: `${ref.hash}  ${ref.size} bytes  ${ref.mimeType}` };
}

/** `trevor artifact get <hash>`: downloads the raw bytes (returned to the caller to write out). */
export async function runArtifactGet(client: TrevorClient, hash: string): Promise<Uint8Array> {
  return client.downloadArtifact(hash);
}
