import type { InternetSnapshot } from "@belay/session";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { InternetStatus } from "./internet-status";

/**
 * D-060 M3: the internet-connectivity advisory, Storybook-first. Covers online / offline / unknown /
 * checking / stale / refresh-failure, plus host disconnected, browser-offline-while-host-online, and
 * the cloud-vs-local selected-model difference (offline warns for cloud, stays neutral for local).
 */

const meta: Meta<typeof InternetStatus> = {
  title: "Chat/InternetStatus",
  component: InternetStatus,
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj<typeof InternetStatus>;

const NOW = Date.parse("2026-06-26T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function snap(over: Partial<InternetSnapshot>): InternetSnapshot {
  return {
    status: "online",
    checking: false,
    checkedAt: ago(5_000),
    error: null,
    targetClass: "dns+https",
    ...over,
  };
}

const noop = () => {};

export const Online: Story = {
  render: () => (
    <InternetStatus
      snapshot={snap({ status: "online" })}
      modelKind="cloud"
      hostPresent
      nowMs={NOW}
      onRefresh={noop}
    />
  ),
};

export const OfflineCloudModel: Story = {
  render: () => (
    <InternetStatus
      snapshot={snap({ status: "offline", error: "HTTPS probe failed" })}
      modelKind="cloud"
      hostPresent
      nowMs={NOW}
      onRefresh={noop}
    />
  ),
};

export const OfflineLocalModel: Story = {
  render: () => (
    <InternetStatus
      snapshot={snap({ status: "offline", error: "DNS lookup failed" })}
      modelKind="local"
      hostPresent
      nowMs={NOW}
      onRefresh={noop}
    />
  ),
};

export const Unknown: Story = {
  render: () => (
    <InternetStatus
      snapshot={snap({ status: "unknown", checkedAt: null })}
      modelKind="cloud"
      hostPresent
      nowMs={NOW}
      onRefresh={noop}
    />
  ),
};

export const Checking: Story = {
  render: () => (
    <InternetStatus
      snapshot={snap({ status: "unknown", checking: true, checkedAt: null })}
      modelKind="cloud"
      hostPresent
      nowMs={NOW}
      onRefresh={noop}
    />
  ),
};

export const Stale: Story = {
  render: () => (
    <InternetStatus
      snapshot={snap({ status: "online", checkedAt: ago(120_000) })}
      modelKind="cloud"
      hostPresent
      nowMs={NOW}
      onRefresh={noop}
    />
  ),
};

export const RefreshFailure: Story = {
  render: () => (
    <InternetStatus
      snapshot={snap({ status: "offline", error: "HTTPS probe failed", checkedAt: ago(2_000) })}
      modelKind="cloud"
      hostPresent
      nowMs={NOW}
      onRefresh={noop}
    />
  ),
};

export const HostDisconnected: Story = {
  render: () => (
    <InternetStatus
      snapshot={snap({ status: "unknown" })}
      modelKind="cloud"
      hostPresent={false}
      nowMs={NOW}
    />
  ),
};

export const BrowserOfflineHostOnline: Story = {
  render: () => (
    <InternetStatus
      snapshot={snap({ status: "online" })}
      modelKind="cloud"
      hostPresent
      browserOnline={false}
      nowMs={NOW}
      onRefresh={noop}
    />
  ),
};
