import {
  type CapabilityManifest,
  type DoctorSnapshot,
  decodeDoctorSnapshot,
  decodeTrevorEvent,
  events,
} from "@trevor/session";
import type { TrevorClient } from "./client";
import { SdkError, urlClass, withSdkError } from "./errors";

/**
 * The SDK capability/doctor reads (plan 28 M4). Trevor's capability manifest and `/doctor` snapshot are
 * host-built and reach a participant over the SESSION PROTOCOL, not the web UI: a client publishes a
 * `user.command` and reads the correlated `command.result` the live host emits. This module wraps that
 * request/response as typed reads - `runCommand` (raw), `exportCapabilities` (the `/trevor-export`
 * manifest as structured JSON), and `doctorSnapshot` (the decoded `/doctor` payload) - so a headless
 * consumer discovers capabilities from the host's structured export, never by scraping assistant prose
 * or the web DOM (M4 RED). Each read needs a LIVE host to answer; with none, it times out with a typed
 * error naming the command.
 */

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export interface CommandResult {
  readonly command: string;
  readonly text: string;
  readonly ok: boolean;
}

/**
 * Runs an immediate host command and returns its structured `command.result` (needs a live host). It
 * opens a tail stream, publishes the `user.command`, and resolves on the next matching `command.result`.
 * Results are correlated by command name (the protocol's existing correlation), so a caller should not
 * run two of the same command concurrently on one session.
 */
export function runCommand(
  client: TrevorClient,
  sessionId: string,
  command: string,
  args = "",
  options?: { readonly timeoutMs?: number },
): Promise<CommandResult> {
  return withSdkError(
    {
      operation: "runCommand",
      backend: "session",
      sessionId,
      backendUrlClass: urlClass(client.sessionUrl),
    },
    () =>
      new Promise<CommandResult>((resolve, reject) => {
        const timeoutMs = options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
        let settled = false;
        let replayed = false;
        const connection = client.transport.connectSession({
          sessionId,
          identity: client.identity,
          onEvent: (event) => {
            // Ignore results seen during replay: a stale prior `/command` result must not be mistaken
            // for the fresh one. Only the tail result (after replay + our publish) resolves.
            if (!replayed || settled) {
              return;
            }
            const decoded = decodeTrevorEvent(event);
            if (decoded?.type === "command.result" && decoded.command === command) {
              settled = true;
              clearTimeout(timer);
              connection.close();
              resolve({ command: decoded.command, text: decoded.text, ok: decoded.ok });
            }
          },
          onReplayComplete: () => {
            replayed = true;
            // Publish only after replay so the tail delivers the host's new result for this command.
            void client.transport
              .publishEvent(sessionId, {
                type: "user.command",
                producerId: client.producerId,
                payload: events.userCommand({ command, args }).payload,
              })
              .catch((error: unknown) => {
                if (!settled) {
                  settled = true;
                  clearTimeout(timer);
                  connection.close();
                  reject(error);
                }
              });
          },
        });
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            connection.close();
            reject(
              new SdkError({
                operation: "runCommand",
                backend: "session",
                sessionId,
                backendUrlClass: urlClass(client.sessionUrl),
                detail: `no command.result for ${command} within ${timeoutMs}ms (is a host running?)`,
              }),
            );
          }
        }, timeoutMs);
      }),
  );
}

/** A capability manifest export: the structured manifest for `json`, or the human/compact text block. */
export type ManifestExport =
  | { readonly format: "json"; readonly manifest: CapabilityManifest }
  | { readonly format: "text"; readonly text: string };

/**
 * Reads the host's capability manifest via the `/trevor-export` command. In `json` mode it parses the
 * host's structured manifest (the export the manifest plan serves) and returns it typed - capability
 * discovery from a structured source, never from prompt text or the web UI. In `text` mode it returns
 * the human-readable block verbatim. An optional `section` narrows the export.
 */
export function exportCapabilities(
  client: TrevorClient,
  sessionId: string,
  request?: {
    readonly format?: "json" | "text";
    readonly section?: string;
    readonly timeoutMs?: number;
  },
): Promise<ManifestExport> {
  const format = request?.format ?? "json";
  const args = [
    format === "json" ? "--json" : null,
    request?.section ? `--section ${request.section}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
  return withSdkError(
    {
      operation: "exportCapabilities",
      backend: "session",
      sessionId,
      backendUrlClass: urlClass(client.sessionUrl),
    },
    async () => {
      const result = await runCommand(client, sessionId, "/trevor-export", args, {
        timeoutMs: request?.timeoutMs,
      });
      if (format === "text") {
        return { format: "text", text: result.text };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.text);
      } catch {
        throw new SdkError({
          operation: "exportCapabilities",
          backend: "session",
          sessionId,
          backendUrlClass: urlClass(client.sessionUrl),
          detail:
            "trevor-export did not return JSON (is the host on a version that supports --json?)",
        });
      }
      return { format: "json", manifest: parsed as CapabilityManifest };
    },
  );
}

/**
 * Reads the host's `/doctor` health snapshot as a structured {@link DoctorSnapshot}, or null when the
 * host sent a legacy text dump / error line (the same tolerant decode the web uses).
 */
export function doctorSnapshot(
  client: TrevorClient,
  sessionId: string,
  options?: { readonly timeoutMs?: number },
): Promise<DoctorSnapshot | null> {
  return withSdkError(
    {
      operation: "doctor",
      backend: "session",
      sessionId,
      backendUrlClass: urlClass(client.sessionUrl),
    },
    async () => {
      const result = await runCommand(client, sessionId, "/doctor", "", options);
      return decodeDoctorSnapshot(result.text);
    },
  );
}
