import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SourceSummary } from "@trevor/session";
import { SourceAuthPanel } from "./source-auth-panel";

/**
 * D-065 M5 / 53: the no-secret auth / setup panel. Covers OAuth sign-in + re-login, a device/provider-
 * code flow (link + non-key code) - including a very long verification URL that must WRAP, not overflow
 * (53 D-004) - the Claude subscription's `claude setup-token` guidance (53 D-003), the direct-API-key
 * host-store states (missing / rejected), and local runtime setup guidance. There is NEVER an API-key
 * paste form - keys live in the host auth store.
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

export const DeviceCodeFlowLongUrl: Story = {
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
          // A realistically long OAuth verification URL (client id + scopes + state token): it must
          // wrap inside the panel, not push past its right edge (53 D-004).
          verificationUrl: `https://auth.openai.com/oauth/device/authorize?client_id=trevor-desktop&scope=all&state=${"abc123def456".repeat(12)}`,
          userCode: "WDJB-MJHT",
          acceptsCode: true,
        }}
        onAction={noop}
        onSubmitCode={noop}
      />
    </Frame>
  ),
};

export const ClaudeSubscriptionSetup: Story = {
  render: () => (
    <Frame>
      <SourceAuthPanel
        source={source({
          // The merged Claude subscription (53 D-001): an oauth source that authorizes via
          // `claude setup-token`, so it offers `configure` and shows the token-setup guidance - not a
          // device-code sign-in (53 D-003).
          sourceId: "claude-code",
          label: "Claude Code subscription",
          type: "oauth",
          status: "needs-auth",
          auth: "none",
          actions: ["configure"],
        })}
        onAction={noop}
      />
    </Frame>
  ),
};

export const DirectApiKeyMissing: Story = {
  render: () => (
    <Frame>
      <SourceAuthPanel
        source={source({
          // The separate Anthropic Direct API (53 D-002): a plain static key in ~/.pi/auth.json, a peer
          // to DeepSeek / Z.ai / MiniMax - NOT the subscription OAuth.
          sourceId: "anthropic",
          label: "Anthropic Direct API",
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
