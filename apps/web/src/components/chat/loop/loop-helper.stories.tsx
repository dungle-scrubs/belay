import type { CommandSpec } from "@belay/session";
import {
  LOOP_FAMILY,
  type LoopInventoryRow,
  loopPresentation,
  parseLoopCommand,
} from "@belay/session";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { CommandMenu } from "../command-menu";
import { CommandInput } from "./command-input";
import { LoopHelper } from "./loop-helper";
import { LoopInventory } from "./loop-inventory";

const meta: Meta<typeof LoopHelper> = {
  title: "Chat/Loop/Helper",
  component: LoopHelper,
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj;

/** The panel for a complete command: builder reads READY, keyword strip beneath. */
export const Ready: Story = {
  render: () => (
    <div className="mx-auto w-[30rem] max-w-full">
      <LoopHelper view={loopPresentation('/loop every 5m until "tests pass" do "run the suite"')} />
    </div>
  ),
};

/** Right after `/loop` is typed: builder flags the gaps, keyword strip all dim. */
export const Incomplete: Story = {
  render: () => (
    <div className="mx-auto w-[30rem] max-w-full">
      <LoopHelper view={loopPresentation("/loop ")} />
    </div>
  ),
};

// --- Interactive composer: command menu -> helper / inventory --------------

const COMMANDS: CommandSpec[] = [
  { name: "/loop", summary: "repeat an action until a bound", usage: "/loop <spec>" },
  { name: "/loops", summary: "view and manage loops" },
  { name: "/shell", summary: "Run a shell command on the host", usage: "/shell <command>" },
  { name: "/search", summary: "Web search", usage: "/search <query>" },
  { name: "/clear", summary: "Clear the conversation" },
];

const INVENTORY: LoopInventoryRow[] = [
  {
    agentBacked: true,
    controls: ["pause", "stop"],
    durability: "session",
    loopId: "loop_1",
    progress: { completed: 3, max: 10 },
    runner: "current_session_prompt",
    status: "running",
    summary: "run the test suite",
  },
  {
    agentBacked: false,
    controls: ["resume", "stop", "run-now", "delete"],
    durability: "durable",
    loopId: "loop_2",
    nextRun: 1_800_000_030_000,
    progress: { completed: 42 },
    runner: "process",
    status: "paused",
    summary: "curl -sf localhost:8080/health",
  },
];

/**
 * The point: the command menu is richer than plain slash insertion. Type `/` to
 * open the menu; pick `/loop` and the menu swaps in the live helper (builder +
 * keyword strip) that re-parses as you type - Enter creates the loop. Pick
 * `/loops` and it swaps in the inventory. Plain commands just insert text.
 *
 * The composer is pinned to the bottom so the helper floats up fully in view.
 */
function ComposerHarness() {
  const [draft, setDraft] = useState("");
  const [active, setActive] = useState(0);

  const firstToken = draft.split(/\s+/)[0] ?? "";
  const menuQuery = draft.startsWith("/") && !draft.includes(" ") ? draft : "";
  const matches = menuQuery ? COMMANDS.filter((command) => command.name.startsWith(menuQuery)) : [];
  const menuOpen = matches.length > 0;
  const activeIndex = Math.min(active, matches.length - 1);

  // The family (its command names), not the menu, decides a command opens a helper at all.
  const parse = LOOP_FAMILY.names.includes(firstToken) ? parseLoopCommand(draft) : undefined;
  const showInventory = firstToken === "/loops";
  const showHelper = parse !== undefined && !showInventory && draft.includes(" ");

  const pick = (name: string) => {
    setDraft(name === "/loops" ? "/loops" : `${name} `);
    setActive(0);
  };

  return (
    // Inline padding-top pushes the composer to the lower-middle of the canvas so
    // the popup (which floats above the input) always has room above it and stays
    // in view. Inline style, not a Tailwind class, so nothing has to be generated.
    <div style={{ minHeight: "100vh", paddingTop: "60vh" }} className="w-full px-6">
      <div className="mx-auto w-[30rem] max-w-full">
        <div className="mb-2 text-ui text-muted-foreground">
          …earlier conversation… (the menu and helper float over this; the transcript never shifts)
        </div>

        <div className="relative">
          {showInventory ? (
            <div className="absolute inset-x-0 bottom-full z-20 mb-2 border border-border bg-popover p-2 shadow-lg">
              <LoopInventory rows={INVENTORY} />
            </div>
          ) : showHelper && parse ? (
            <LoopHelper
              className="absolute inset-x-0 bottom-full z-20 mb-2"
              view={loopPresentation(draft)}
            />
          ) : menuOpen ? (
            <CommandMenu
              className="absolute inset-x-0 bottom-full z-20 mb-2"
              matches={matches}
              activeIndex={activeIndex}
              query={menuQuery}
              onPick={pick}
            />
          ) : null}

          <CommandInput
            autoFocus
            value={draft}
            tokens={parse?.tokens ?? []}
            placeholder="type / to see commands"
            onChange={(value) => {
              setDraft(value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (menuOpen) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActive((index) => (index + 1) % matches.length);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive((index) => (index - 1 + matches.length) % matches.length);
                } else if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  const picked = matches[activeIndex];
                  if (picked) {
                    pick(picked.name);
                  }
                }
                return;
              }
              // No menu open: Enter on a /loop line submits it (creates the loop).
              if (showHelper && event.key === "Enter") {
                event.preventDefault();
                setDraft("");
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}

export const MenuToHelper: Story = {
  name: "Menu → helper (interactive)",
  parameters: { layout: "fullscreen" },
  render: () => <ComposerHarness />,
};
