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
  build: {
    rolldownOptions: {
      output: {
        // Vendor split (Tier 5): stable, independently-cached chunks for the heavy dependency
        // groups, instead of one monolithic index chunk that re-downloads on every app change.
        // Which chunks load EAGERLY is decided by the import graph, not by this list - a group only
        // pins matching modules into one predictably-named chunk. Two families are deliberately
        // ABSENT and left to automatic chunking: mermaid (its engine already splits itself through
        // the dynamic import in mermaid-block) and the assistant-ui remark stack (markdown-text-lazy
        // self-chunks it; a group would also capture its recursive deps - @assistant-ui/react,
        // zustand - which the entry uses, welding the whole lazy stack into the initial preload set).
        codeSplitting: {
          groups: [
            // Higher priority so react always lands here, even when another group captures it
            // transitively through includeDependenciesRecursively.
            {
              name: "vendor-react",
              test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
              priority: 10,
            },
            // The primary (eager) markdown stack: marked + DOMPurify.
            { name: "vendor-markdown", test: /node_modules[\\/](?:marked|dompurify)[\\/]/ },
            // Lazy: hljs core + grammars, reached only through the code-highlight facade's dynamic
            // import.
            { name: "vendor-highlight", test: /node_modules[\\/]highlight\.js[\\/]/ },
            // parse-diff is NOT grouped in with `diff`: diff is eager (diff-utils prepares patches
            // at transcript-render time) while parse-diff is only needed by the lazy DiffViewer -
            // one shared group would drag parse-diff into the eager preload set.
            { name: "vendor-diff", test: /node_modules[\\/]diff[\\/]/ },
          ],
        },
      },
    },
  },
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
