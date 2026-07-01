/**
 * The "branch from here" affordance (plan 15, M3): a per-message action on the transcript that starts a
 * FRESH session forked from the parent's conversation up to this point. It only signals intent - it emits
 * the fork point (`forkSeq`, the message's session seq) to `onBranch`; the host performs the actual fork
 * over the normal append API. Presentational + Storybook-driven; the transcript supplies `forkSeq`.
 *
 * `forkSeq` MUST be the source event's session `seq` (the stable fork-point coordinate), NOT the transcript
 * message id / store-minted `eventId` - the fork API keys on seq, and eventId is reassigned on a copy.
 */

export interface BranchButtonProps {
  /** The parent session seq to branch at (the fork point). */
  readonly forkSeq: number;
  readonly onBranch: (forkSeq: number) => void;
  /** Compact icon-only form for an inline hover action (defaults to the labeled form). */
  readonly compact?: boolean;
}

export function BranchButton({ forkSeq, onBranch, compact = false }: BranchButtonProps) {
  return (
    <button
      type="button"
      onClick={() => onBranch(forkSeq)}
      title="Branch a new session from here"
      aria-label="Branch a new session from here"
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
    >
      <span aria-hidden="true">⑂</span>
      {compact ? null : <span>Branch from here</span>}
    </button>
  );
}
