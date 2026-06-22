import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Port 17420 is reserved for the Trevor web UI in ~/.agents/PORTS.md.
// /sessions is proxied to the local Richter (REST + WebSocket) so the browser
// talks same-origin and avoids cross-origin (CORS) failures against Richter.
export default defineConfig({
  plugins: [react()],
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
