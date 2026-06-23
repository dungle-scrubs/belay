import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Port 17420 is reserved for the Trevor web UI in ~/.agents/PORTS.md.
// /sessions is proxied to the local Richter (REST + WebSocket) so the browser
// talks same-origin and avoids cross-origin (CORS) failures against Richter.
// The Tailwind plugin only processes CSS that imports "tailwindcss", so the
// live app (which does not yet import src/index.css) builds byte-identically;
// Storybook opts in via .storybook/preview.ts. Shared by both since Storybook's
// @storybook/react-vite framework reuses this config.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [react(), tailwindcss()],
  server: {
    port: 17420,
    strictPort: true,
    proxy: {
      "/sessions": {
        target: "http://localhost:3025",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
