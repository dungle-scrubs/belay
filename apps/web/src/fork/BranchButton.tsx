/**
 * The "branch from here" affordance (plan 15, M3): a per-message action on the transcript that starts a
 * FRESH session forked from the parent's conversation up to this point. It only signals intent - it emits
 * the fork point (`forkSeq`, the message's session seq) to `onBranch`; the host performs the actual fork
 * over the normal append API. Presentational + Storybook-driven; the transcript supplies `forkSeq`.
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
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-neutral-400 text-xs hover:bg-neutral-800 hover:text-neutral-200"
    >
      <span aria-hidden="true">⑂</span>
      {compact ? null : <span>Branch from here</span>}
    </button>
  );
}
