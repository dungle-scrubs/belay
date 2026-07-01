import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ArtifactRef } from "@trevor/session";
import { ArtifactPanel } from "./artifact-panel";
import type { ArtifactPanelLayout } from "./artifact-panel-state";

const meta = {
  title: "ArtifactPanel/Workspace",
  component: ArtifactPanel,
  tags: ["artifact-panel"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[720px] bg-smui-surface-sunken">
        <main className="flex min-w-0 flex-1 flex-col px-4">
          <header className="flex h-8 shrink-0 items-center justify-center text-label tracking-wider text-muted-foreground">
            active-session
          </header>
          <div className="min-h-0 flex-1 overflow-hidden py-4">
            <div className="mx-auto flex h-full max-w-3xl flex-col justify-end gap-5 text-sm">
              <div className="border-l-2 border-primary bg-card px-3 py-2">
                Render the latest report and open it beside the transcript.
              </div>
              <div className="pl-3.5 text-muted-foreground">
                Working through the artifact panel layout while the composer remains visible.
              </div>
            </div>
          </div>
          <div className="shrink-0 pb-4">
            <div className="rounded-md border border-border bg-background px-3 py-3 text-sm text-muted-foreground">
              composer remains usable
            </div>
          </div>
        </main>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ArtifactPanel>;

export default meta;
type Story = StoryObj<typeof ArtifactPanel>;

const image: ArtifactRef = {
  kind: "image",
  hash: "a".repeat(64),
  mimeType: "image/png",
  name: "comparison.png",
  size: 24_000,
};

const html: ArtifactRef = {
  kind: "document",
  hash: "b".repeat(64),
  mimeType: "text/html",
  name: "lucid-review.html",
  size: 14_000,
};

const diagnostic: ArtifactRef = {
  kind: "file",
  hash: "c".repeat(64),
  mimeType: "application/json",
  name: "doctor-report.json",
  size: 4_200,
};

function srcOf(hash: string): string {
  if (hash === image.hash) {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='900' height='520'><rect width='100%' height='100%' fill='#d8dee9'/><rect x='64' y='64' width='772' height='392' fill='#2e3440'/><text x='96' y='124' fill='#eceff4' font-family='sans-serif' font-size='32'>artifact preview</text></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }
  if (hash === html.hash) {
    const page = `<main style="font:16px system-ui;padding:32px"><h1>Lucid review</h1><p>Addressable HTML artifact in a sandboxed viewer.</p></main>`;
    return `data:text/html,${encodeURIComponent(page)}`;
  }
  return `data:application/json,${encodeURIComponent(JSON.stringify({ status: "ok" }, null, 2))}`;
}

function args(artifact: ArtifactRef, layout: ArtifactPanelLayout, width = 520): Story["args"] {
  return {
    artifact,
    layout,
    width,
    onClose: () => {},
    onResetWidth: () => {},
    onWidthChange: () => {},
    srcOf,
  };
}

export const Closed: Story = {
  args: {
    artifact: null,
    layout: "push",
    width: 520,
    onClose: () => {},
  },
};

export const PushNarrowTranscript: Story = { args: args(image, "push") };
export const ReplaceCurrentPanel: Story = { args: args(html, "replace") };
export const PartialOverlap: Story = { args: args(diagnostic, "overlap", 560) };
export const ResizableState: Story = { args: args(image, "push", 680) };
export const Loading: Story = { args: { ...args(image, "push"), loadStatus: "loading" } };
export const FailedLoad: Story = { args: { ...args(image, "push"), loadStatus: "error" } };
