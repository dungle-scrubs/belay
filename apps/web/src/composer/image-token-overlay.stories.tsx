import type { ArtifactRef } from "@belay/session";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { ImageTokenOverlay } from "./image-token-overlay";

/**
 * D-092 M1: image-token composer states, Storybook-first. The overlay highlights `[Image #N]`
 * tokens over a real textarea (caret + editing preserved). Stories cover token placement (start /
 * middle / end / multiple), long-prompt wrapping, narrow + desktop widths, upload in progress, and
 * a broken/pending preview - reviewed before the live composer wiring. Fixtures are production
 * `ArtifactRef`s; previews come from an injected `srcOf` (no running blob store in Storybook).
 */

const meta: Meta<typeof ImageTokenOverlay> = {
  title: "Composer/ImageTokenOverlay",
  component: ImageTokenOverlay,
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj<typeof ImageTokenOverlay>;

/** A production-shaped image ArtifactRef (64-hex content hash). */
function imageRef(seed: string, name: string): ArtifactRef {
  return {
    kind: "image",
    mimeType: "image/png",
    size: 24_000,
    hash: seed.repeat(64).slice(0, 64),
    name,
  };
}

const REF_A = imageRef("a", "diagram.png");
const REF_B = imageRef("b", "screenshot.png");
const REF_C = imageRef("c", "chart.png");

/** A small inline SVG data URL keyed by ref, so hover previews render with no blob store. */
const COLORS: Record<string, string> = {
  [REF_A.hash]: "#5e81ac",
  [REF_B.hash]: "#a3be8c",
  [REF_C.hash]: "#bf616a",
};
function dataSrc(hash: string): string {
  const fill = COLORS[hash] ?? "#4c566a";
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='160'><rect width='100%' height='100%' fill='${fill}'/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** A controlled wrapper at a fixed width so each story is an editable, hoverable composer. */
function Demo({
  initial,
  refs,
  width,
  uploading,
  srcOf = dataSrc,
}: {
  initial: string;
  refs: readonly ArtifactRef[];
  width: string;
  uploading?: number;
  srcOf?: (hash: string) => string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className={width}>
      <div className="border border-border bg-card">
        <ImageTokenOverlay
          value={value}
          refs={refs}
          onChange={setValue}
          uploading={uploading}
          srcOf={srcOf}
        />
      </div>
      <p className="mt-2 text-label tracking-wider text-muted-foreground">
        hover a token chip to preview · editable
      </p>
    </div>
  );
}

export const TokenBetweenWords: Story = {
  render: () => (
    <Demo initial="look at [Image #1] and tell me what changed" refs={[REF_A]} width="w-[40rem]" />
  ),
};

export const TokenAtStart: Story = {
  render: () => <Demo initial="[Image #1] what is this?" refs={[REF_A]} width="w-[40rem]" />,
};

export const TokenAtEnd: Story = {
  render: () => (
    <Demo initial="here is the screenshot [Image #1]" refs={[REF_A]} width="w-[40rem]" />
  ),
};

export const MultipleTokens: Story = {
  render: () => (
    <Demo
      initial="compare [Image #1] with [Image #2] and [Image #3]"
      refs={[REF_A, REF_B, REF_C]}
      width="w-[40rem]"
    />
  ),
};

export const LongPromptWrapping: Story = {
  render: () => (
    <Demo
      initial="Here is a much longer prompt that should wrap across several lines in the composer so we can verify the token highlight [Image #1] keeps tracking the text as it reflows, and that a second token [Image #2] near the end still lines up after wrapping."
      refs={[REF_A, REF_B]}
      width="w-[34rem]"
    />
  ),
};

export const NarrowMobileWidth: Story = {
  render: () => (
    <Demo
      initial="on a narrow composer [Image #1] the token still wraps cleanly"
      refs={[REF_A]}
      width="w-[20rem]"
    />
  ),
};

export const DesktopWidth: Story = {
  render: () => (
    <Demo
      initial="on a wide desktop composer [Image #1] there is room for [Image #2] inline"
      refs={[REF_A, REF_B]}
      width="w-[52rem]"
    />
  ),
};

export const UploadInProgress: Story = {
  render: () => <Demo initial="uploading an image now" refs={[]} width="w-[40rem]" uploading={1} />,
};

export const BrokenOrPendingPreview: Story = {
  render: () => (
    // One token has no ref yet (pending upload) and one ref whose preview fails to load.
    <Demo
      initial="pending [Image #1] and broken [Image #2]"
      refs={[REF_A]}
      width="w-[40rem]"
      srcOf={() => "data:image/png;base64,not-a-real-image"}
    />
  ),
};
