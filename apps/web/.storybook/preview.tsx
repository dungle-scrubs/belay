import "@fontsource-variable/jetbrains-mono/index.css";
import "../src/index.css";
import type { Preview } from "@storybook/react-vite";
import { TooltipProvider } from "../src/components/ui/tooltip";

// SMUI ships light (:root) and dark (.dark) modes. The docs drive this with
// next-themes; this is a Vite app, so a toolbar toggle flips the `.dark` class
// on the iframe root instead. Default to dark to match the docs' defaultTheme.
const preview: Preview = {
  initialGlobals: { theme: "dark" },
  globalTypes: {
    theme: {
      description: "SMUI light / dark mode",
      toolbar: {
        title: "Theme",
        icon: "contrast",
        items: [
          { value: "dark", title: "Dark", icon: "moon" },
          { value: "light", title: "Light", icon: "sun" },
        ],
        dynamicTitle: true,
      },
    },
  },
  parameters: {
    layout: "centered",
    // Drop the Actions addon panel; this is a component library, not event wiring.
    actions: { disable: true },
    controls: {
      matchers: { color: /(background|color)$/i, date: /Date$/i },
    },
  },
  decorators: [
    (Story, context) => {
      const theme = context.globals.theme === "light" ? "light" : "dark";
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.documentElement.style.colorScheme = theme;
      return (
        <TooltipProvider>
          {/* Center every story vertically + horizontally in the canvas, so short components (and
            overlays like the composer's slash menu, which opens upward) have room above and below
            instead of being pinned to the top edge and clipped. */}
          <div className="flex min-h-svh w-full items-center justify-center bg-background p-8 text-foreground">
            <Story />
          </div>
        </TooltipProvider>
      );
    },
  ],
};

export default preview;
