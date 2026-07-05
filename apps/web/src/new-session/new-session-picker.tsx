import { relativeTime, type SupervisorProject } from "@trevor/session";
import { Folder, FolderSearch, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { workspaceBasename } from "@/derive";
import { cn } from "@/lib/utils";
import type { PathValidation } from "./path-validation";
import type { LaunchPhase } from "./use-launch";

/**
 * The New-session picker (plan 44.2): the browser affordance to start a folder-bound session, driven
 * entirely over the 44.1 supervisor contract. This is the PRESENTATIONAL component (Storybook-first),
 * pure over injected props + callbacks; the live wiring (recents fetch, native folder pick, path
 * validation, launch -> navigate) lives in `use-supervisor.ts` + `app.tsx`.
 *
 * Layout is fixed so a launch in flight never resizes the modal: the title bar, path field row, the
 * fixed-height validation-hint line, the fixed-height recents list, and the footer all keep their
 * height across every state (recents / validating / "starting host…"). The states swap IN PLACE - when
 * a launch starts, the controls lock and the footer swaps Create for "Starting host…" without any
 * reflow. Interactive elements inherit the pointer cursor from the `index.css` base layer, so this adds
 * none.
 */

export interface NewSessionPickerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Recent project roots (from `projects.list`), already recency-sorted by the supervisor. */
  readonly recents: readonly SupervisorProject[];
  /** The path field value, controlled by the parent (so it owns validation + the folder-pick fill). */
  readonly path: string;
  /** The parent's validation verdict for `path`; only `"valid"` enables Create. */
  readonly validation: PathValidation;
  /** Whether the native folder icon is offered - true only when a local supervisor is present; a
   *  remote/headless backend hides it and degrades to recents + paste-a-path. */
  readonly localPickerAvailable: boolean;
  /** Idle, a launch in flight ("starting host…", controls locked), or `failed` (error + Retry). */
  readonly launchState: LaunchPhase;
  /** The launch error text, shown inline; on `failed` it sits beside an explicit Retry. */
  readonly error?: string | null;
  /** Launch a recent root directly (a recent is a known-valid project root, so it needs no Create). */
  readonly onPickRecent: (root: string) => void;
  /** Pop the native OS folder picker (gated on `localPickerAvailable`); the result fills the path. */
  readonly onPickFolder: () => void;
  readonly onPathChange: (path: string) => void;
  /** Launch the typed/pasted (valid) path. */
  readonly onCreate: (root: string) => void;
  /** Re-launch the last attempted root after a `failed` launch (returns to "starting host…"). */
  readonly onRetry?: () => void;
  readonly nowMs?: number;
}

/** A recent-project row: the folder name, its full root, and when the launcher last touched it. The
 *  whole row is one launch button (a recent is already a valid root), locked while a launch is in flight. */
function RecentRow({
  project,
  disabled,
  onPick,
  nowMs,
}: {
  project: SupervisorProject;
  disabled: boolean;
  onPick: (root: string) => void;
  nowMs: number;
}) {
  const name = workspaceBasename(project.root) ?? project.root;
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onPick(project.root)}
        className="flex w-full items-center gap-3 px-2 py-2 text-left text-muted-foreground hover:bg-card hover:text-foreground disabled:opacity-60 disabled:hover:bg-transparent"
      >
        <Folder className="size-4 shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-foreground">{name}</span>
          <span className="truncate text-xs text-muted-foreground">{project.root}</span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {relativeTime(project.updatedAt, nowMs)}
        </span>
      </button>
    </li>
  );
}

/** The in-place "Starting host…" indicator that replaces Create in the footer while a launch is in
 *  flight. Same footer slot + height, so swapping it in never reflows the modal. */
function StartingHost() {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      Starting host…
    </span>
  );
}

export function NewSessionPicker({
  open,
  onOpenChange,
  recents,
  path,
  validation,
  localPickerAvailable,
  launchState,
  error,
  onPickRecent,
  onPickFolder,
  onPathChange,
  onCreate,
  onRetry,
  nowMs = Date.now(),
}: NewSessionPickerProps) {
  const starting = launchState === "starting";
  const failed = launchState === "failed";
  // Both `starting` and `failed` lock the folder controls: a launch is either in flight or awaiting an
  // explicit Retry (a fresh Create would fire a second, competing launch).
  const locked = starting || failed;
  const canCreate = validation === "valid" && !locked;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="overflow-hidden p-0 sm:max-w-xl">
        <DialogDescription className="sr-only">
          Start a session in a folder: pick a recent project, browse for a folder, or type an
          absolute path, then create the session.
        </DialogDescription>

        <div className="flex flex-col">
          <div className="flex items-center border-b border-border px-4 py-3">
            <DialogTitle className="font-semibold text-sm">New session</DialogTitle>
          </div>

          {/* Path field: the typed/pasted folder + (when a local supervisor is present) the native
            folder icon. The hint line below keeps a fixed height so validation never reflows the row. */}
          <div className="px-4 pt-4">
            <label
              htmlFor="new-session-path"
              className="text-label tracking-wider text-muted-foreground"
            >
              Folder
            </label>
            <div className="mt-1 flex items-center gap-2">
              <Input
                id="new-session-path"
                value={path}
                disabled={locked}
                onChange={(e) => onPathChange(e.target.value)}
                aria-invalid={validation === "invalid"}
                aria-describedby={validation === "invalid" ? "new-session-path-hint" : undefined}
                placeholder="/absolute/path or ~/path"
                autoComplete="off"
                spellCheck={false}
              />
              {localPickerAvailable ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  disabled={locked}
                  onClick={onPickFolder}
                  aria-label="Browse for a folder"
                  title="Browse for a folder"
                >
                  <FolderSearch />
                </Button>
              ) : null}
            </div>
            <p
              id="new-session-path-hint"
              className={cn(
                "mt-1 h-4 text-xs",
                validation === "invalid" ? "text-smui-red" : "text-transparent",
              )}
            >
              Enter an absolute path (starting with / or ~).
            </p>
          </div>

          {/* Recents: a fixed-height, scrollable list so a long or empty list keeps the modal size. */}
          <div className="px-4">
            <div className="px-2 text-label tracking-wider text-muted-foreground/70">
              Recent projects
            </div>
            <ul
              className={cn(
                "mt-1 h-56 overflow-y-auto",
                locked ? "pointer-events-none opacity-60" : "",
              )}
            >
              {recents.length === 0 ? (
                <li className="px-2 py-3 text-muted-foreground/60 text-sm">
                  No recent projects yet.
                </li>
              ) : (
                recents.map((project) => (
                  <RecentRow
                    key={project.root}
                    project={project}
                    disabled={locked}
                    onPick={onPickRecent}
                    nowMs={nowMs}
                  />
                ))
              )}
            </ul>
          </div>

          {/* Footer: a fixed-height row whose action slot swaps Create <-> "Starting host…" <-> Retry
            in place (all three occupy the same slot + height, so no state reflows the modal). A failed
            launch shows the named error beside an explicit Retry - the one deterministic way out. */}
          <div className="flex h-14 items-center justify-between gap-3 border-t border-border px-4">
            <span className="min-w-0 flex-1 truncate text-smui-red text-xs" role="alert">
              {error ?? ""}
            </span>
            {starting ? (
              <StartingHost />
            ) : failed ? (
              <Button type="button" variant="outline" onClick={() => onRetry?.()}>
                Retry
              </Button>
            ) : (
              <Button type="button" disabled={!canCreate} onClick={() => onCreate(path)}>
                Create
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
