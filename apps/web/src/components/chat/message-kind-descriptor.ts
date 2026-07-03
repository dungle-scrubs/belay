import { ArrowLeftRight, CornerDownRight, ShieldAlert, Webhook } from "lucide-react";
import type { ElementType } from "react";
import { formatSwitchEndpoint, hookDecisionActionLabel, type Message } from "../../transcript";
import type { CompactStatus } from "./compact-display";

type DescribedMessage = Extract<
  Message,
  { kind: "continued" | "guardrail" | "hookDecision" | "modelSwitch" }
>;

export interface MessageKindDescriptor {
  readonly kind: DescribedMessage["kind"];
  readonly status: CompactStatus;
  readonly icon: ElementType;
  readonly isQuietMarker: true;
  readonly primary: string;
  readonly secondary: string | null;
}

export function messageKindDescriptor(message: DescribedMessage): MessageKindDescriptor {
  switch (message.kind) {
    case "continued":
      return {
        kind: "continued",
        status: "info",
        icon: CornerDownRight,
        isQuietMarker: true,
        primary: `continued at step ${message.steps}`,
        secondary: `${(message.pressure * 100).toFixed(1)}% context, room left`,
      };
    case "guardrail": {
      const reason = message.reason === "repeated_failure" ? "repeated failure" : "no progress";
      const blocked = message.action === "block" || message.action === "halt";
      return {
        kind: "guardrail",
        status: "info",
        icon: ShieldAlert,
        isQuietMarker: true,
        primary: `Guardrail: ${message.tool}`,
        secondary: `${reason} ×${message.count}${blocked ? " · blocked" : ""}`,
      };
    }
    case "hookDecision": {
      const action = hookDecisionActionLabel(message.decision, message.toolName);
      return {
        kind: "hookDecision",
        status: "info",
        icon: Webhook,
        isQuietMarker: true,
        primary: `Hook: ${message.hookId}`,
        secondary: `${action}${message.reason ? ` · ${message.reason}` : ""}`,
      };
    }
    case "modelSwitch":
      return {
        kind: "modelSwitch",
        status: "info",
        icon: ArrowLeftRight,
        isQuietMarker: true,
        primary: "Model",
        secondary:
          message.outcome === "blocked"
            ? `switch to ${formatSwitchEndpoint(message.to)} blocked${message.reason ? ` · ${message.reason}` : ""}`
            : `${formatSwitchEndpoint(message.from)} -> ${formatSwitchEndpoint(message.to)}`,
      };
  }
}

export function quietMarkerText(descriptor: MessageKindDescriptor): string {
  return descriptor.secondary
    ? `${descriptor.primary} · ${descriptor.secondary}`
    : descriptor.primary;
}
