import type { StorybookConfig } from "@storybook/react-vite";

// Storybook reuses apps/web's vite.config.ts (same @vitejs/plugin-react setup),
// so stories render through the exact bundler the app ships with.
const config: StorybookConfig = {
  stories: ["../src/**/*.mdx", "../src/**/*.stories.@(js|jsx|mjs|ts|tsx)"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  // No onboarding addon is installed; this silences the core first-run/What's New
  // and telemetry notifications that surface as onboarding nags.
  core: {
    disableTelemetry: true,
    disableWhatsNewNotifications: true,
  },
};

export default config;
