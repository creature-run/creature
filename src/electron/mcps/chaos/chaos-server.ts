#!/usr/bin/env node
/**
 * Chaos MCP Server
 *
 * Host compliance and failure mode testing for the MCP Apps protocol.
 * Provides tools that deliberately misbehave in specific ways to verify
 * that the host, proxy, control plane, and SDK handle failures gracefully.
 *
 * This MCP is designed to be called by the AI agent. Each tool exercises
 * a different failure mode, and the results dashboard shows what happened.
 */

import { createApp } from "open-mcp-app/server";
import { registerChaosTools } from "./tools/chaos.js";
import { MCP_NAME, CHAOS_UI_URI } from "./lib/types.js";
import { ICON_SVG, ICON_ALT } from "./icon.js";

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.MCP_PORT || process.env.PORT || "3010", 10);

// =============================================================================
// App Definition
// =============================================================================

const app = createApp({
  name: MCP_NAME,
  version: "0.1.0",
  port: PORT,
  instructions: `Chaos is a host compliance and failure mode testing tool for MCP Apps.

Available tools:
- chaos_run { test } - Run a specific chaos test by ID
- chaos_run_all - Run all server-side tests and return an aggregate summary
- chaos_results - Open the test results dashboard
- chaos_clear - Clear all test results

Available tests (pass as the "test" parameter to chaos_run):

Server-side tests (the tool handler misbehaves):
- "happy" — Normal correct result (control/baseline test)
- "throw" — Tool handler throws an uncaught Error
- "slow" — Tool takes 15 seconds to respond
- "huge" — Returns ~500KB of structured data
- "error_flag" — Returns a result with isError: true
- "no_data" — Returns text-only, no structured data

UI-side tests (the UI misbehaves after receiving the result):
- "ui_error" — UI throws a runtime error during render
- "ui_bad_state" — UI sends malformed widget state to the host
- "ui_rapid_state" — UI sends 50 rapid widget state updates

Recommended workflow:
1. Call chaos_run_all to run all server-side tests at once
2. Call chaos_results to view the dashboard
3. Run UI tests individually with chaos_run { test: "ui_error" } etc.
4. After each UI test, the pip may need to be refreshed to recover`,
});

// =============================================================================
// UI Resources
// =============================================================================

/**
 * Chaos dashboard UI resource.
 *
 * Single-instance pip that displays test results and status.
 * All tools route to the same dashboard view.
 */
app.resource({
  name: "Chaos Dashboard",
  uri: CHAOS_UI_URI,
  description: "Test results dashboard for host compliance testing",
  displayModes: ["pip"],
  html: "chaos/ui/index.html",
  icon: { svg: ICON_SVG, alt: ICON_ALT },
  views: {
    "/": ["chaos_run", "chaos_run_all", "chaos_results", "chaos_clear"],
  },
});

// =============================================================================
// Tools
// =============================================================================

registerChaosTools(app);

// =============================================================================
// Server Lifecycle
// =============================================================================

const main = async () => {
  console.log("[Chaos] Starting MCP server");
  await app.start();
  console.log("[Chaos] MCP server ready on port", PORT);
};

process.on("SIGTERM", () => {
  console.log("[Chaos] Received SIGTERM, shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[Chaos] Received SIGINT, shutting down...");
  process.exit(0);
});

main().catch((error) => {
  console.error("[Chaos] Failed to start server", error);
  process.exit(1);
});
