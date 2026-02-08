/**
 * MCP App UI
 *
 * Skeleton UI with host-themed styling.
 * Replace this with your app's components.
 */

import { HostProvider } from "open-mcp-app/react";
import "open-mcp-app/styles/tailwind.css";
import "./styles.css";

export default function App() {
  return (
    <HostProvider name="__APP_NAME__" version="0.1.0">
      <div className="flex items-center justify-center h-full bg-bg-primary">
        <p className="text-sm text-txt-tertiary">MCP App Template</p>
      </div>
    </HostProvider>
  );
}
