import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CommandMenuPayload } from "@trevor/session";
import { CommandMenu } from "./command-menu";

/**
 * Storybook states for the generic nested command menu (plan 03, M2): root, child (deep-linked via
 * `defaultOpenId`), search, disabled rows, empty, long labels, and a narrow viewport. Every state is
 * driven purely by the host-owned payload - no story reaches into the component's internals.
 */

const STYLE_MENU: CommandMenuPayload = {
  family: "style",
  title: "Output style",
  searchable: true,
  rows: [
    { id: "concise", label: "Concise", description: "Short, direct answers", selected: true },
    { id: "diagnostic", label: "Diagnostic", description: "Surface reasoning and checks" },
    { id: "explanatory", label: "Explanatory", description: "Teach as you go" },
    {
      id: "reset",
      label: "Reset to default",
      description: "Use the built-in style",
      badge: "default",
    },
    {
      id: "advanced",
      label: "Advanced styles",
      description: "Specialized response shapes",
      children: [
        { id: "reviewer", label: "Reviewer", description: "Terse, finding-oriented" },
        { id: "explanatory-pro", label: "Explanatory (pro)", disabledReason: "coming soon" },
      ],
    },
  ],
};

const LONG_MENU: CommandMenuPayload = {
  family: "fixture",
  title: "A command family with a very long title that should truncate gracefully",
  searchable: true,
  rows: [
    {
      id: "long-1",
      label: "An exceptionally long row label that does not fit on a single line and must truncate",
      description: "A correspondingly long description that also needs to be clamped to one line",
    },
    { id: "long-2", label: "Short", badge: "a rather long badge text" },
  ],
};

const meta: Meta<typeof CommandMenu> = {
  title: "CommandMenu/CommandMenu",
  component: CommandMenu,
  parameters: { layout: "fullscreen" },
  // The menu fills its container's height (its row list is `flex-1`), so - like the other
  // transcript-takeover stories - frame it in a fixed-size panel and stretch it with `h-full`. Without a
  // definite parent height the `flex-1` list collapses to 0 and only the header/search would show.
  args: { onAction: () => {}, onClose: () => {}, className: "h-full" },
  decorators: [
    (Story) => (
      <div className="h-[560px] w-[440px] overflow-hidden rounded-lg border border-border">
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof CommandMenu>;

export const Root: Story = { args: { payload: STYLE_MENU } };

export const ChildMenu: Story = {
  args: { payload: STYLE_MENU, defaultOpenId: "advanced" },
};

export const DisabledRows: Story = {
  args: { payload: STYLE_MENU, defaultOpenId: "advanced" },
};

export const NotSearchable: Story = {
  args: { payload: { ...STYLE_MENU, searchable: false } },
};

export const Empty: Story = {
  args: {
    payload: {
      family: "style",
      title: "Output style",
      searchable: true,
      emptyText: "No styles are configured yet.",
      rows: [],
    },
  },
};

export const LongLabels: Story = { args: { payload: LONG_MENU } };

export const NarrowViewport: Story = {
  args: { payload: STYLE_MENU },
  render: (args) => (
    <div className="mx-auto h-[520px] w-[320px] overflow-hidden rounded-lg border border-border">
      <CommandMenu {...args} />
    </div>
  ),
};
