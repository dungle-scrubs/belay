import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SourceSummary } from "@trevor/session";
import { SourceAuthPanel } from "./source-auth-panel";

/**
 * D-065 M5: the no-secret auth / setup panel. Covers OAuth sign-in + re-login, a device/provider-code
 * flow (link + non-key code), the direct-API-key host-store states (missing / rejected), and local
 * runtime setup guidance. There is NEVER an API-key paste form - keys live in the host auth store.
 */

const meta: Meta<typeof SourceAuthPanel> = {
  title: "Chooser/SourceAuthPanel",
  component: SourceAuthPanel,
};

export default meta;
type Story = StoryObj<typeof SourceAuthPanel>;

function source(over: Partial<SourceSummary> & { sourceId: string }): SourceSummary {
  return {
    type: "api-key",
    label: `Source ${over.sourceId}`,
    status: "ready",
    modelCount: 0,
    auth: "none",
    freshness: { refreshedAt: null, stale: false },
    actions: [],
    ...over,
  };
}

const noop = () => {};

function Frame({ children }: { children: React.ReactNode }) {
  return <div style={{ width: 460 }}>{children}</div>;
}

export const OAuthSignIn: Story = {
  render: () => (
    <Frame>
      <SourceAuthPanel
        source={source({
          sourceId: "codex",
          label: "OpenAI (Codex subscription)",
          type: "oauth",
          status: "needs-auth",
          auth: "none",
          actions: ["authenticate"],
        })}
        onAction={noop}
      />
    </Frame>
  ),
};

export const OAuthExpired: Story = {
  render: () => (
    <Frame>
      <SourceAuthPanel
        source={source({
          sourceId: "claude",
          label: "Anthropic (Claude subscription)",
          type: "oauth",
          status: "needs-auth",
          auth: "expired",
          actions: ["reauthenticate"],
        })}
        onAction={noop}
      />
    </Frame>
  ),
};

export const DeviceCodeFlow: Story = {
  render: () => (
    <Frame>
      <SourceAuthPanel
        source={source({
          sourceId: "codex",
          label: "OpenAI (Codex subscription)",
          type: "oauth",
          status: "needs-auth",
          auth: "none",
          actions: ["authenticate"],
        })}
        deviceCode={{
          verificationUrl: "https://auth.openai.com/device",
          userCode: "WDJB-MJHT",
          acceptsCode: true,
        }}
        onAction={noop}
        onSubmitCode={noop}
      />
    </Frame>
  ),
};

export const DirectApiKeyMissing: Story = {
  render: () => (
    <Frame>
      <SourceAuthPanel
        source={source({
          sourceId: "anthropic",
          label: "Anthropic API key",
          type: "api-key",
          status: "ready",
          auth: "none",
          actions: ["configure"],
        })}
        onAction={noop}
      />
    </Frame>
  ),
};

export const DirectApiKeyRejected: Story = {
  render: () => (
    <Frame>
      <SourceAuthPanel
        source={source({
          sourceId: "openai",
          label: "OpenAI API key",
          type: "api-key",
          status: "error",
          auth: "authenticated",
          actions: ["configure"],
        })}
        onAction={noop}
      />
    </Frame>
  ),
};

export const LocalRuntimeSetup: Story = {
  render: () => (
    <Frame>
      <SourceAuthPanel
        source={source({
          sourceId: "lmstudio",
          label: "LM Studio",
          type: "local",
          status: "unavailable",
          auth: "none",
          actions: ["configure"],
        })}
        onAction={noop}
      />
    </Frame>
  ),
};
