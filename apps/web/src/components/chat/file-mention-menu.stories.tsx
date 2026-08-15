import type { FileMatch } from "@belay/session";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { FileMentionMenu } from "./file-mention-menu";
import { storyFrame } from "./story-frame";

const FILES: FileMatch[] = [
  { path: "apps/web/src/app.tsx" },
  { path: "apps/web/src/hooks/use-composer.ts" },
  { path: "apps/web/src/components/chat/prompt-input.tsx" },
  { path: "apps/agent-host/src/main.ts" },
  { path: "README.md" },
];

const meta: Meta<typeof FileMentionMenu> = {
  title: "Chat/FileMentionMenu",
  component: FileMentionMenu,
  args: { activeIndex: 0, query: "", onPick: () => {} },
  // The menu opens UPWARD over the composer in the app; the global decorator centers it so there is
  // room above and below. Width is set per story via storyFrame (do not add per-story centering).
  decorators: [(Story) => <Story />],
};

export default meta;

type Story = StoryObj<typeof FileMentionMenu>;

/** The standard picker: basename emphasized, directory muted, a result-count summary. */
export const Default: Story = {
  args: { matches: FILES, activeIndex: 1, query: "use" },
  decorators: [
    (Story) => {
      const Frame = storyFrame("w-[34rem]");
      return (
        <Frame>
          <Story />
        </Frame>
      );
    },
  ],
};

/** Deeply nested paths: the directory end-truncates so the row height never grows. */
export const LongPaths: Story = {
  args: {
    matches: [
      { path: "apps/web/src/components/chat/loop/really/deep/nesting/command-token-segments.ts" },
      { path: "packages/session/src/really/deep/nesting/capability-manifest-builder.ts" },
    ],
    activeIndex: 0,
    query: "segments",
  },
  decorators: [
    (Story) => {
      const Frame = storyFrame("w-[34rem]");
      return (
        <Frame>
          <Story />
        </Frame>
      );
    },
  ],
};

/** A capped result set: the summary says more exist and to narrow the query. */
export const Truncated: Story = {
  args: { matches: FILES, activeIndex: 0, query: "s", truncated: true },
  decorators: [
    (Story) => {
      const Frame = storyFrame("w-[34rem]");
      return (
        <Frame>
          <Story />
        </Frame>
      );
    },
  ],
};

/** No matches: an active `@` token that resolves to nothing still shows a recognizable empty state. */
export const Empty: Story = {
  args: { matches: [], query: "zzz-nothing" },
  decorators: [
    (Story) => {
      const Frame = storyFrame("w-[34rem]");
      return (
        <Frame>
          <Story />
        </Frame>
      );
    },
  ],
};

/** A narrow composer: the same rows, still single-line, with the directory truncating harder. */
export const Narrow: Story = {
  args: { matches: FILES, activeIndex: 2, query: "prompt" },
  decorators: [
    (Story) => {
      const Frame = storyFrame("w-[18rem]");
      return (
        <Frame>
          <Story />
        </Frame>
      );
    },
  ],
};

/** Loading: the host has not yet answered the index request, so the empty state reads "loading". */
export const Loading: Story = {
  args: { matches: [], query: "app", loading: true },
  decorators: [
    (Story) => {
      const Frame = storyFrame("w-[34rem]");
      return (
        <Frame>
          <Story />
        </Frame>
      );
    },
  ],
};

/**
 * Many matches: the row list is capped (`max-h-[60vh]`) and scrolls internally, so it never runs off
 * the top of the screen. The summary footer stays pinned below the scroll area. This story is the
 * primary verification surface for the height cap.
 */
export const Overflow: Story = {
  args: {
    matches: Array.from({ length: 40 }, (_, i) => ({
      path: `apps/web/src/deeply/nested/module-${String(i).padStart(2, "0")}.tsx`,
    })),
    activeIndex: 0,
    query: "module",
  },
  decorators: [
    (Story) => {
      const Frame = storyFrame("w-[34rem]");
      return (
        <Frame>
          <Story />
        </Frame>
      );
    },
  ],
};
