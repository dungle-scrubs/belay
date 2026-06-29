import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { HandoffApprovalSurface } from "./HandoffApprovalSurface";

/**
 * The generated-handoff approval surface replaces the composer while a `/handoff` draft is pending.
 * `Generating` is the spinner shown while the model drafts; `Generated` is the draft with Approve /
 * Edit / Reject. In the live app Edit opens the full prompt editor seeded with the draft; here it just
 * logs so the buttons are reviewable in isolation.
 */
const meta: Meta<typeof HandoffApprovalSurface> = {
  title: "Handoff/HandoffApprovalSurface",
  component: HandoffApprovalSurface,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof HandoffApprovalSurface>;

const DRAFT = `Continue the transcript-selection work in apps/web. The cross-item persistence (02.11) is merged; next, wire the generated-handoff approval surface into PanelHost.

Key files: apps/web/src/components/handoff/HandoffApprovalSurface.tsx, apps/web/src/App.tsx (usePromptEditor + pendingHandoff), apps/agent-host/src/main.ts (runGeneratedHandoff/approveHandoff). Run the web + unit test projects before committing.`;

export const Generating: Story = {
  render: () => (
    <div className="max-w-2xl">
      <HandoffApprovalSurface
        handoff={{ status: "generating", handoffId: "h1" }}
        onApprove={() => {}}
        onEdit={() => {}}
        onReject={() => {}}
      />
    </div>
  ),
};

export const Generated: Story = {
  render: () => {
    const [log, setLog] = useState<string>("");
    return (
      <div className="flex max-w-2xl flex-col gap-3">
        <HandoffApprovalSurface
          handoff={{ status: "generated", handoffId: "h1", prompt: DRAFT }}
          onApprove={() => setLog("approved → publishes handoff.approved, host switches")}
          onEdit={(prompt) =>
            setLog(`edit → opens the prompt editor seeded with ${prompt.length} chars`)
          }
          onReject={() => setLog("rejected → publishes handoff.rejected, stays in this session")}
        />
        {log ? <p className="text-xs text-muted-foreground">{log}</p> : null}
      </div>
    );
  },
};
