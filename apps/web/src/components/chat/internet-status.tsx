import { type InternetSnapshot, isSnapshotStale, relativeTime } from "@trevor/session";
import { Loader2, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The internet-connectivity advisory (D-060 M3): a compact line placed near the model/source
 * selector that surfaces the HOST's public-internet reachability. It is advisory only - it never
 * disables submit or changes model selection - and is visually distinct from host presence and the
 * session-store/WebSocket connection. When a cloud model is selected and the host is offline it
 * warns; when a local model is selected it stays neutral (local turns are unaffected). `navigator.
 * onLine` is only a debug comparison hint, never the host status.
 */

const STALE_MS = 30_000;

export interface InternetStatusProps {
  readonly snapshot: InternetSnapshot;
  /** The selected model's locality - drives whether offline is a warning (cloud) or neutral (local). */
  readonly modelKind: "local" | "cloud";
  /** Whether a host is connected; with no host we don't know connectivity (neutral). */
  readonly hostPresent: boolean;
  readonly onRefresh?: () => void;
  /** Browser `navigator.onLine`, shown only as a debug mismatch hint when it disagrees with the host. */
  readonly browserOnline?: boolean;
  readonly nowMs?: number;
  readonly className?: string;
}

interface View {
  readonly icon: typeof Wifi;
  readonly tone: string;
  readonly label: string;
}

/** The advisory's icon/tone/label, derived from host presence, the snapshot, and the model kind. */
function view(props: InternetStatusProps): View {
  if (!props.hostPresent) {
    return { icon: WifiOff, tone: "text-muted-foreground/70", label: "host disconnected" };
  }
  if (props.snapshot.checking && props.snapshot.status === "unknown") {
    return { icon: Loader2, tone: "text-muted-foreground", label: "checking internet…" };
  }
  if (props.snapshot.status === "online") {
    return { icon: Wifi, tone: "text-muted-foreground/70", label: "internet online" };
  }
  if (props.snapshot.status === "unknown") {
    return { icon: Wifi, tone: "text-muted-foreground/70", label: "internet status unknown" };
  }
  // offline: a warning only when a cloud model is selected (cloud turns need the internet); a local
  // model is unaffected, so the advisory stays neutral.
  return props.modelKind === "cloud"
    ? { icon: WifiOff, tone: "text-smui-yellow", label: "offline - cloud turns may fail" }
    : { icon: WifiOff, tone: "text-muted-foreground", label: "offline - local model unaffected" };
}

export function InternetStatus(props: InternetStatusProps) {
  const { snapshot, hostPresent, onRefresh, browserOnline, nowMs = Date.now(), className } = props;
  const v = view(props);
  const Icon = v.icon;
  const stale = hostPresent && isSnapshotStale(snapshot, nowMs, STALE_MS);
  const checking = snapshot.checking;

  // navigator.onLine disagreeing with the host probe is a debug hint only - never the source of truth.
  const browserMismatch =
    hostPresent && browserOnline === false && snapshot.status === "online" && !checking;

  return (
    <output
      className={cn(
        "inline-flex items-center gap-1.5 text-label tracking-wider",
        v.tone,
        className,
      )}
      aria-label="internet status"
    >
      <Icon className={cn("size-3.5 shrink-0", checking ? "animate-spin" : "")} aria-hidden />
      <span>{v.label}</span>

      {stale && snapshot.checkedAt ? (
        <span className="text-muted-foreground/50">
          · {relativeTime(snapshot.checkedAt, nowMs)}
        </span>
      ) : null}

      {browserMismatch ? (
        <span
          className="text-muted-foreground/50"
          title="browser navigator.onLine disagrees with the host probe"
        >
          · browser offline
        </span>
      ) : null}

      {onRefresh && hostPresent ? (
        <button
          type="button"
          onClick={onRefresh}
          disabled={checking}
          aria-label="refresh internet status"
          className="ml-0.5 text-muted-foreground/60 hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={cn("size-3", checking ? "animate-spin" : "")} />
        </button>
      ) : null}
    </output>
  );
}
