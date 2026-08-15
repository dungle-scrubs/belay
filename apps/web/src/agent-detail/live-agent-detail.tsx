import { PRODUCER_IDS, type SessionTransport } from "@belay/session";
import { useMemo } from "react";
import { sessionTransport, useSessionWithTransport } from "@/session/use-session";
import { readOnlyToolBatches, toTranscript } from "@/transcript";
import { buildTranscriptRows } from "@/transcript-rows";
import { AgentDetailShell } from "./agent-detail-shell";

/**
 * The LIVE inline-agent detail takeover (plan 09.4 M6): binds a SECOND `useSession` to the delegated
 * CHILD session by `childSessionId` - a real session in the same store (`ensureSession` + its turn
 * lifecycle are published to it) - folds its own log into a transcript with the SAME `toTranscript` /
 * `buildTranscriptRows` pipeline the main view uses, and renders the presentational `AgentDetailShell`.
 * Because the row's projection already carries everything the collapsed row shows (model/tokens/status),
 * this child subscription is scoped to WHILE THE TAKEOVER IS OPEN only: mounting binds it, `onBack`
 * unmounts it and the `null`-teardown in `useSession` tears the stream down. Mirrors `LiveTangentShell`,
 * minus the composer/actions - the child runs on its own, so this is read-only.
 */
export function LiveAgentDetail({
  childSessionId,
  agent,
  onBack,
  onOpenPath,
  transport = sessionTransport,
}: {
  readonly childSessionId: string;
  /** The child agent's name (resolved from the parent transcript), for the header. */
  readonly agent?: string;
  readonly onBack: () => void;
  readonly onOpenPath: (path: string) => void;
  /** Injected transport for deterministic tests; defaults to the app's shared session transport. */
  readonly transport?: SessionTransport;
}) {
  const stream = useSessionWithTransport(transport, childSessionId);
  const transcript = useMemo(
    () => toTranscript(stream.events, { selfProducerId: PRODUCER_IDS.host }),
    [stream.events],
  );
  const toolBatches = useMemo(() => readOnlyToolBatches(transcript), [transcript]);
  const rows = useMemo(
    () => buildTranscriptRows({ toolBatches, transcript }),
    [toolBatches, transcript],
  );

  return (
    <AgentDetailShell
      {...(agent !== undefined ? { agent } : {})}
      rows={rows}
      onBack={onBack}
      onOpenPath={onOpenPath}
      replayed={stream.replayed}
      // The child's event count advances on every streamed delta (progress/text), so the shell
      // re-pins to the bottom as a long answer grows, not only when a whole new row appears.
      revision={stream.events.length}
      className="h-full"
    />
  );
}
