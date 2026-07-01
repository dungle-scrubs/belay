import "@fontsource-variable/jetbrains-mono/index.css";
import "./index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { TelemetryErrorBoundary } from "./components/error-boundary";
import { TooltipProvider } from "./components/ui/tooltip";
import { bootstrapTelemetry } from "./telemetry";

// Resolve the browser telemetry config once at startup (plan 13): disabled/local by default, so this
// installs a NOOP sink and emits nothing without explicit opt-in.
bootstrapTelemetry();

// SMUI is a dark-first terminal theme; activate dark mode app-wide.
document.documentElement.classList.add("dark");

const queryClient = new QueryClient();

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root element");
}

createRoot(root).render(
  <StrictMode>
    <TelemetryErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </QueryClientProvider>
    </TelemetryErrorBoundary>
  </StrictMode>,
);
