import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CommandSpec } from "@trevor/session";
import { useState } from "react";
import { CommandMenu } from "./command-menu";

const COMMANDS: CommandSpec[] = [
  { name: "/shell", summary: "Run a shell command on the host", usage: "/shell <command>" },
  { name: "/skills", summary: "List the host's available skills" },
  { name: "/status", summary: "Show host + lease status" },
  { name: "/search", summary: "Web search", usage: "/search <query>" },
  { name: "/clear", summary: "Clear the conversation" },
  { name: "/help", summary: "List available commands" },
];

/** A synthetic 40-command set to exercise the shared `AutocompleteMenu` height cap. */
const MANY_COMMANDS: CommandSpec[] = Array.from({ length: 40 }, (_, i) => ({
  name: `/cmd-${String(i).padStart(2, "0")}`,
  summary: `Synthetic command ${i} to exercise the shared height cap`,
}));

const meta: Meta = {
  title: "Chat/CommandMenu",
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj;

/**
 * The full composer experience: type a leading "/" to open the menu. It overlays
 * the placeholder transcript above (the transcript does NOT get pushed up), and
 * the characters you've typed are highlighted in each row. Arrow keys move the
 * selection; Enter/Tab or a click picks a command.
 */
function CommandMenuDemo() {
  const [draft, setDraft] = useState("/s");
  const [active, setActive] = useState(0);

  const query = draft.startsWith("/") && !draft.includes(" ") ? draft : "";
  const matches = query ? COMMANDS.filter((c) => c.name.startsWith(query)) : [];
  const open = matches.length > 0;
  const idx = Math.min(active, matches.length - 1);

  const pick = (name: string) => {
    setDraft(`${name} `);
    setActive(0);
  };

  return (
    <div className="mx-auto w-[34rem] max-w-full">
      {/* Placeholder transcript: the menu overlays this, it never pushes it up. */}
      <div className="mb-2 flex h-44 flex-col justify-end gap-2 overflow-hidden border border-dashed border-border p-3 text-sm text-muted-foreground">
        <p>…earlier conversation…</p>
        <p>The menu floats over this area instead of shoving it upward.</p>
      </div>

      <div className="relative">
        {open ? (
          <CommandMenu
            className="absolute inset-x-0 bottom-full z-20 mb-2"
            matches={matches}
            activeIndex={idx}
            query={query}
            onPick={pick}
          />
        ) : null}
        <input
          // biome-ignore lint/a11y/noAutofocus: storybook demo - focus the input so typing works immediately.
          autoFocus
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (!open) {
              return;
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((i) => (i + 1) % matches.length);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((i) => (i - 1 + matches.length) % matches.length);
            } else if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              const picked = matches[idx];
              if (picked) {
                pick(picked.name);
              }
            }
          }}
          placeholder="type / to see commands"
          className="w-full border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-ring"
        />
      </div>
    </div>
  );
}

export const Interactive: Story = {
  render: () => <CommandMenuDemo />,
};

/** A static frame of the menu, to inspect the row layout and the "/s" prefix highlight. */
export const Highlighted: Story = {
  render: () => (
    <div className="mx-auto w-[34rem] max-w-full">
      <CommandMenu
        matches={COMMANDS.filter((c) => c.name.startsWith("/s"))}
        activeIndex={0}
        query="/s"
        onPick={() => {}}
      />
    </div>
  ),
};

/**
 * Many matches: the row list is capped (`max-h-[60vh]`) and scrolls internally, so it never runs off
 * the top of the screen. The slash command set is small in practice, but the menu shares the
 * `AutocompleteMenu` chrome with the `@`-file-mention menu, so this story proves the shared cap
 * holds for both.
 */
export const Overflow: Story = {
  render: () => (
    <div className="mx-auto w-[34rem] max-w-full">
      <CommandMenu matches={MANY_COMMANDS} activeIndex={0} query="" onPick={() => {}} />
    </div>
  ),
};
