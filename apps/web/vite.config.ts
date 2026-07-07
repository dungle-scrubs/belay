import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { RESERVED_PORTS, serviceUrl } from "@trevor/session/ports";
import { SESSIONS_PATH } from "@trevor/session/session-routes";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// RESERVED_PORTS.web is reserved for the Trevor web UI in ~/.trevor/PORTS.md.
// /sessions is proxied to the local session-store (REST + WebSocket, RESERVED_PORTS.store) so the
// browser talks same-origin and avoids cross-origin (CORS) failures. Override VITE_SESSION_PROXY to point
// at another backend; opt into Tether directly with VITE_TETHER_URL (see src/session/use-session.ts).
// The Tailwind plugin only processes CSS that imports "tailwindcss", so the
// live app (which does not yet import src/index.css) builds byte-identically;
// Storybook opts in via .storybook/preview.ts. Shared by both since Storybook's
// @storybook/react-vite framework reuses this config.
//
// The proxy is shared by `vite dev` AND `vite preview`, so the built+previewed app (the 09.2 Lane B
// browser e2e) reaches an ephemeral store via VITE_SESSION_PROXY exactly as dev does, with no rebuild.
const sessionsProxy = {
  [SESSIONS_PATH]: {
    target: process.env.VITE_SESSION_PROXY ?? serviceUrl("store"),
    changeOrigin: true,
    ws: true,
  },
};

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [react(), tailwindcss()],
  server: {
    // Bind IPv4 loopback explicitly. Vite's default host ("localhost") resolves to ::1 (IPv6) only on
    // macOS, so a client hitting 127.0.0.1 (the reserved-port convention in ~/.trevor/PORTS.md, what
    // the `trevor` launcher opens, and what the proxy target uses) gets ECONNREFUSED even though Vite
    // is "up". Pinning 127.0.0.1 makes the bind address match every consumer.
    host: "127.0.0.1",
    port: RESERVED_PORTS.web,
    strictPort: true,
    proxy: sessionsProxy,
  },
  preview: {
    host: "127.0.0.1",
    port: RESERVED_PORTS.web,
    strictPort: true,
    proxy: sessionsProxy,
  },
});
