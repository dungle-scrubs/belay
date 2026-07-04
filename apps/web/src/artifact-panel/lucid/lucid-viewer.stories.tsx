import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ArtifactRef } from "@trevor/session";
import { LucidArtifactViewer } from "./lucid-viewer";

/**
 * The full Lucid VIEWER (plan 27): the sandboxed addressable surface plus the native review chrome,
 * as it renders inside the artifact panel. In Storybook the HTML is supplied via `loadHtml` and the
 * overlay runs live in the sandboxed iframe, so hover/click targeting is exercisable by hand.
 */
const meta = {
  title: "ArtifactPanel/LucidViewer",
  component: LucidArtifactViewer,
  tags: ["artifact-panel", "lucid"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[720px] w-[560px] flex-col border-border border-l bg-card">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LucidArtifactViewer>;

export default meta;
type Story = StoryObj<typeof LucidArtifactViewer>;

const SAMPLE_HTML = `<!doctype html><html><head><style>
  body{font:16px/1.5 system-ui;margin:0;padding:28px;color:#1f2933;background:#fff}
  h1{margin:0 0 12px;font-size:24px}
  li{margin:6px 0}
</style></head><body>
  <h1 data-lucid-id="title">Launch roadmap</h1>
  <p data-lucid-id="intro">A three-step plan the reviewer can mark up at the element and phrase level.</p>
  <ol>
    <li data-lucid-id="s1">Cut the release branch and freeze scope.</li>
    <li data-lucid-id="s2">Ship the beta to the ring-0 cohort on Friday.</li>
    <li data-lucid-id="s3">Collect located feedback and iterate.</li>
  </ol>
</body></html>`;

function lucidRef(version = 1): ArtifactRef {
  return {
    kind: "document",
    mimeType: "text/html",
    hash: "a".repeat(64),
    size: SAMPLE_HTML.length,
    name: "Launch roadmap",
    lucid: {
      lucidId: "roadmap",
      version,
      provenance: "agent",
      reviewStatus: "open",
      title: "Launch roadmap",
    },
  };
}

export const OpenForReview: Story = {
  args: {
    artifact: lucidRef(),
    lucid: {
      delivered: null,
      onDeliver: () => {},
      onReviewChange: () => {},
      loadHtml: async () => SAMPLE_HTML,
    },
  },
};

export const WithDeliveredFeedback: Story = {
  args: {
    artifact: lucidRef(2),
    lucid: {
      delivered: {
        lucidId: "roadmap",
        version: 2,
        htmlHash: "a".repeat(64),
        provenance: "agent",
        reviewStatus: "open",
        annotations: [
          {
            annotationId: "d1",
            anchor: { type: "element", lucidId: "s2" },
            snippet: "Ship the beta",
            note: "Friday is too soon",
          },
        ],
        lastCursor: 1,
      },
      onDeliver: () => {},
      onReviewChange: () => {},
      loadHtml: async () => SAMPLE_HTML,
    },
  },
};
