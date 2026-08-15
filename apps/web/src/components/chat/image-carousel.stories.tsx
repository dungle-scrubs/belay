import type { ArtifactRef } from "@belay/session";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { ImageCarousel } from "./image-carousel";

/**
 * D-092 M5: the same-message image carousel. Stories cover one image, many images, a wide image, a
 * tall image, a broken image (file-row fallback), and a narrow viewport. Each opens the dialog so
 * prev/next, the index/count, and keyboard navigation can be exercised in the browser.
 */

const meta: Meta<typeof ImageCarousel> = {
  title: "Chat/ImageCarousel",
  component: ImageCarousel,
  parameters: { layout: "centered" },
};

export default meta;

type Story = StoryObj<typeof ImageCarousel>;

function imageRef(seed: string, name: string): ArtifactRef {
  return {
    kind: "image",
    mimeType: "image/png",
    size: 24_000,
    hash: seed.repeat(64).slice(0, 64),
    name,
  };
}

const WIDE = imageRef("w", "wide.png");
const TALL = imageRef("l", "tall.png");
const SQUARE = imageRef("s", "square.png");
const LONG_NAME = imageRef("z", "annotated-flow-diagram-final-v3-reviewed-2026-07-04-export.png");

const DIMS: Record<string, [number, number, string]> = {
  [WIDE.hash]: [900, 300, "#a3be8c"],
  [TALL.hash]: [320, 760, "#b48ead"],
  [SQUARE.hash]: [600, 600, "#5e81ac"],
  [LONG_NAME.hash]: [720, 480, "#88c0d0"],
};

function dataSrc(hash: string): string {
  const [w, h, fill] = DIMS[hash] ?? [600, 400, "#4c566a"];
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'><rect width='100%' height='100%' fill='${fill}'/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** Opens the carousel with a button so the dialog interaction is exercised in Storybook. */
function Demo({
  images,
  srcOf = dataSrc,
}: {
  images: readonly ArtifactRef[];
  srcOf?: (h: string) => string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        type="button"
        className="border border-border px-3 py-1.5 text-sm"
        onClick={() => setOpen(true)}
      >
        open carousel
      </button>
      <ImageCarousel
        images={images}
        open={open}
        initialIndex={0}
        onOpenChange={setOpen}
        srcOf={srcOf}
      />
    </div>
  );
}

export const OneImage: Story = { render: () => <Demo images={[SQUARE]} /> };
export const ManyImages: Story = { render: () => <Demo images={[WIDE, TALL, SQUARE]} /> };
export const WideImage: Story = { render: () => <Demo images={[WIDE]} /> };
export const TallImage: Story = { render: () => <Demo images={[TALL]} /> };
/** A long filename truncates in the title beside the counter instead of widening the modal. */
export const LongFilename: Story = { render: () => <Demo images={[LONG_NAME]} /> };
export const BrokenImage: Story = {
  render: () => <Demo images={[SQUARE]} srcOf={() => "data:image/png;base64,not-real"} />,
};
export const NarrowViewport: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  render: () => <Demo images={[WIDE, TALL]} />,
};
