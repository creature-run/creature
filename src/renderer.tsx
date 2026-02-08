/**
 * TEMPORARY WORKAROUND: Suppress noisy console.error from @modelcontextprotocol/ext-apps
 * 
 * The PostMessageTransport in the published npm package logs "Ignoring message from unknown source"
 * for every postMessage event that doesn't come from the expected iframe source. In Electron,
 * this fires constantly due to dev reloads, DevTools messages, etc.
 * 
 * Our local spec (spec/src/message-transport.ts) already silently drops these messages, but the
 * published @modelcontextprotocol/ext-apps package still has the console.error call.
 * 
 * TODO: Remove this workaround once the spec is republished with the silent drop behavior.
 */
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  if (args[0] === "Ignoring message from unknown source") return;
  originalConsoleError.apply(console, args);
};

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./globals.css";
import App from "./App";
import { ThemeProvider } from "./contexts/ThemeContext";
import { AppProvider } from "./contexts/AppContext";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <AppProvider>
        <App />
      </AppProvider>
    </ThemeProvider>
  </StrictMode>
);
