import {
  redactAttributeValue,
  SPAN_NAMES,
  safeEmitSpan,
  type TelemetrySink,
} from "@belay/session/telemetry";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { captureRenderCrash } from "../sentry";
import { telemetrySink } from "../telemetry";

/**
 * The React render-crash boundary (plan 13 M4). It catches a render/lifecycle exception anywhere below
 * it, records a redacted `belay.web.render` error span (the sink is NOOP until a browser exporter or
 * Sentry lands - M10), and shows a minimal fallback instead of an unmounted white screen. Only the
 * redacted error MESSAGE is captured - never prompts, transcript bodies, or component props.
 */

interface Props {
  readonly children: ReactNode;
  /** Rendered when a child has crashed; defaults to a terse inline notice. */
  readonly fallback?: ReactNode;
  /** The telemetry sink (defaults to the app sink); injectable for tests. */
  readonly sink?: TelemetrySink;
}

interface State {
  readonly crashed: boolean;
}

export class TelemetryErrorBoundary extends Component<Props, State> {
  override state: State = { crashed: false };

  static getDerivedStateFromError(): State {
    return { crashed: true };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    const sink = this.props.sink ?? telemetrySink();
    safeEmitSpan(sink, {
      name: SPAN_NAMES.webRender,
      attributes: {},
      status: "error",
      durationMs: 0,
      error: redactAttributeValue(error.message),
    });
    // Report the render crash to Sentry too (a no-op unless the browser sink is enabled). A React
    // render error never reaches window.onerror, so the boundary must forward it explicitly.
    try {
      captureRenderCrash(error);
    } catch {
      // telemetry is best-effort; a reporting failure must never mask the crash fallback
    }
  }

  override render(): ReactNode {
    if (this.state.crashed) {
      return (
        this.props.fallback ?? <div role="alert">Something went wrong. Reload to continue.</div>
      );
    }
    return this.props.children;
  }
}
