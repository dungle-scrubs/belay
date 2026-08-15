import type { ArtifactRef } from "@belay/session";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { MessageAttachments } from "./message-attachments";
import { InlineImageLoading } from "./message-images";

/**
 * D-092 M4 + plan 34: the transcript image set + same-message attachments. Stories cover the tile's
 * loading / loaded / unavailable / transparent states, the single-image taller cap vs the
 * multi-image shorter cap (tiny / wide / tall / large / mixed), filename present / absent / long, a
 * long prompt with [Image #N] tokens preserved in the text, an attachments-only prompt, a document
 * fallback, and narrow transcript-width / mobile viewports. Fixtures are production `ArtifactRef`s;
 * previews come from an injected `srcOf`.
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
const TRANSPARENT = imageRef("p", "logo-transparent.png");
const NAMELESS: ArtifactRef = { ...imageRef("n", ""), name: undefined };
const LONG_NAME = imageRef("z", "annotated-flow-diagram-final-v3-reviewed-2026-07-04-export.png");
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
  [LONG_NAME.hash]: [480, 300, "#88c0d0"],
};

function dataSrc(hash: string): string {
  const [w, h, fill] = DIMS[hash] ?? [320, 240, "#4c566a"];
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'><rect width='100%' height='100%' fill='${fill}'/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** A transparent-background preview: only a circle is painted, so the tile's card color shows through
 *  the transparent areas (verifying transparent PNGs read cleanly, not on an assumed white). */
function transparentSrc(): string {
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='240' height='180'><circle cx='120' cy='90' r='70' fill='#ebcb8b'/></svg>";
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const srcOf = (hash: string) => (hash === TRANSPARENT.hash ? transparentSrc() : dataSrc(hash));

/** A user-message bubble wrapper so the image set is shown in transcript context. `width` narrows the
 *  transcript for the responsive stories. */
function Bubble({
  text,
  artifacts,
  width = "w-[44rem]",
  children,
}: {
  text?: string;
  artifacts?: readonly ArtifactRef[];
  width?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`${width} max-w-full`}>
      <div className="flex flex-col gap-2 border-l-2 border-primary bg-card px-3 py-2">
        {text ? <p className="text-sm text-foreground">{text}</p> : null}
        {artifacts ? <MessageAttachments artifacts={artifacts} srcOf={srcOf} /> : null}
        {children}
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

export const TransparentBackground: Story = {
  render: () => <Bubble text="a transparent logo" artifacts={[TRANSPARENT]} />,
};

/** The reserved-footprint shimmer shown until an image decodes (single + set), reviewable without a
 *  network race. */
export const Loading: Story = {
  render: () => (
    <Bubble text="images still decoding">
      <div className="flex flex-col gap-3">
        <InlineImageLoading single />
        <div className="flex flex-wrap gap-2">
          <InlineImageLoading />
          <InlineImageLoading />
          <InlineImageLoading />
        </div>
      </div>
    </Bubble>
  ),
};

export const MultipleImages: Story = {
  render: () => <Bubble text="compare these" artifacts={[WIDE, TALL, TINY, LARGE]} />,
};

export const FilenamePresent: Story = {
  render: () => <Bubble text="see the diagram" artifacts={[LONG_NAME]} />,
};
export const FilenameAbsent: Story = {
  render: () => <Bubble text="an unnamed paste" artifacts={[NAMELESS]} />,
};
export const LongFilename: Story = {
  render: () => <Bubble text="the export" artifacts={[LONG_NAME]} />,
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
    <Bubble text="this image is unavailable">
      <MessageAttachments artifacts={[BROKEN]} srcOf={() => "data:image/png;base64,not-real"} />
    </Bubble>
  ),
};

/** A set that mixes images and a document: the images tile up, the document stays a quiet file row. */
export const MixedImageAndDocument: Story = {
  render: () => <Bubble text="the mocks plus the spec" artifacts={[WIDE, TALL, DOC]} />,
};

export const DocumentFallback: Story = {
  render: () => <Bubble text="see the doc" artifacts={[DOC, WIDE]} />,
};

/** A narrow transcript column: the set falls back to the two-column grid and long names truncate
 *  rather than widening the transcript. */
export const NarrowTranscript: Story = {
  render: () => <Bubble width="w-[20rem]" text="on a narrow column" artifacts={[LONG_NAME]} />,
};

/** A mobile viewport (plan 34 M5): tiles fill their grid columns and metadata stays contained. */
export const NarrowViewport: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" }, layout: "fullscreen" },
  render: () => (
    <div className="p-3">
      <Bubble width="w-full" text="on a phone" artifacts={[WIDE, TALL, TINY, LONG_NAME]} />
    </div>
  ),
};
