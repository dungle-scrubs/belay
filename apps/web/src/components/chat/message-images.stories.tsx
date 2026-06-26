import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ArtifactRef } from "@trevor/session";
import { MessageAttachments } from "./message-attachments";

/**
 * D-092 M4: the transcript image set + same-message attachments. Stories cover tiny / wide / tall /
 * large single images (natural size up to the responsive cap, contained), multiple images as one
 * set, a long prompt with [Image #N] tokens preserved in the text, an attachments-only prompt, a
 * broken image (degrades to a file row), and a document fallback. Fixtures are production
 * `ArtifactRef`s; previews come from an injected `srcOf`.
 */

const meta: Meta<typeof MessageAttachments> = {
  title: "Chat/MessageImages",
  component: MessageAttachments,
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj<typeof MessageAttachments>;

function imageRef(seed: string, name: string): ArtifactRef {
  return {
    kind: "image",
    mimeType: "image/png",
    size: 24_000,
    hash: seed.repeat(64).slice(0, 64),
    name,
  };
}

const TINY = imageRef("t", "tiny.png");
const WIDE = imageRef("w", "wide.png");
const TALL = imageRef("l", "tall.png");
const LARGE = imageRef("g", "large.png");
const BROKEN = imageRef("x", "broken.png");
const DOC: ArtifactRef = {
  kind: "document",
  mimeType: "application/pdf",
  size: 1000,
  hash: "d".repeat(64),
  name: "spec.pdf",
};

const DIMS: Record<string, [number, number, string]> = {
  [TINY.hash]: [48, 36, "#5e81ac"],
  [WIDE.hash]: [640, 160, "#a3be8c"],
  [TALL.hash]: [160, 520, "#b48ead"],
  [LARGE.hash]: [1200, 900, "#bf616a"],
};

function dataSrc(hash: string): string {
  const [w, h, fill] = DIMS[hash] ?? [320, 240, "#4c566a"];
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'><rect width='100%' height='100%' fill='${fill}'/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** A user-message bubble wrapper so the image set is shown in transcript context. */
function Bubble({ text, artifacts }: { text?: string; artifacts: readonly ArtifactRef[] }) {
  return (
    <div className="w-[44rem] max-w-full">
      <div className="flex flex-col gap-2 border-l-2 border-primary bg-card px-3 py-2">
        {text ? <p className="text-sm text-foreground">{text}</p> : null}
        <MessageAttachments artifacts={artifacts} srcOf={dataSrc} />
      </div>
    </div>
  );
}

export const TinyImage: Story = {
  render: () => <Bubble text="a tiny screenshot" artifacts={[TINY]} />,
};
export const WideImage: Story = {
  render: () => <Bubble text="a wide banner" artifacts={[WIDE]} />,
};
export const TallImage: Story = {
  render: () => <Bubble text="a tall screenshot" artifacts={[TALL]} />,
};
export const LargeImage: Story = {
  render: () => <Bubble text="a large render" artifacts={[LARGE]} />,
};

export const MultipleImages: Story = {
  render: () => <Bubble text="compare these" artifacts={[WIDE, TALL, TINY, LARGE]} />,
};

export const LongTextWithTokens: Story = {
  render: () => (
    <Bubble
      text="Here is the first screenshot [Image #1] and the second one [Image #2] - the tokens stay in the visible text while the images render below."
      artifacts={[WIDE, TALL]}
    />
  ),
};

export const AttachmentsOnly: Story = { render: () => <Bubble artifacts={[LARGE]} /> };

export const BrokenImage: Story = {
  // A real ref whose preview fails to load degrades to a file row (no broken-image icon).
  render: () => (
    <div className="w-[44rem] max-w-full">
      <div className="flex flex-col gap-2 border-l-2 border-primary bg-card px-3 py-2">
        <p className="text-sm text-foreground">this image is unavailable</p>
        <MessageAttachments artifacts={[BROKEN]} srcOf={() => "data:image/png;base64,not-real"} />
      </div>
    </div>
  ),
};

export const DocumentFallback: Story = {
  render: () => <Bubble text="see the doc" artifacts={[DOC, WIDE]} />,
};
