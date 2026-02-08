#!/usr/bin/env node
/**
 * Devkit MCP Server
 *
 * Developer toolkit providing logs, MCP App refresh, and SDK docs.
 *
 * All tools are Host-managed: this server declares them for the MCP protocol,
 * but the actual execution happens in the Electron main process (controlPlane.ts).
 * The tool handlers here return placeholder data that gets replaced by the
 * control plane's handleDevkitToolCall() before reaching the agent.
 */

import { createApp } from "open-mcp-app/server";
import { z } from "zod";
import { MCP_NAME, DEVKIT_UI_URI } from "./lib/types.js";
import { ICON_SVG, ICON_ALT } from "./icon.js";

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.MCP_PORT || process.env.PORT || "3008", 10);

// =============================================================================
// App Definition
// =============================================================================

const app = createApp({
  name: MCP_NAME,
  version: "0.1.0",
  port: PORT,
  instructions: `Developer toolkit for debugging and building software in Creature.

Tools:
- devkit_get_logs { filter?, mcpName? }: Fetch recent logs from Creature's aggregated log system. Filter by "all" (last 50), "current_mcp_app" (logs for a specific MCP App by name), or "errors" (error-level entries only).
- devkit_reload_mcp_app { mcpName }: Restart an MCP App server and reload all its pip instances. Use this when the user has made code changes to their MCP App.
- devkit_get_mcp_app_sdk_docs: Fetch the MCP App SDK reference documentation. Use this to learn how to build MCP Apps with the open-mcp-app SDK.
- devkit_get_conversation: (App-only) Fetch the current conversation history for inspection.
- devkit_get_system_prompt: (App-only) Fetch the current system prompt for inspection.

Response style: When showing logs, summarize key findings (errors, patterns) rather than listing every entry. The user can see the log viewer UI for full details.`,
});

// =============================================================================
// UI Resource
// =============================================================================

/**
 * Devkit UI resource.
 *
 * Single-instance tabbed interface for developer tools.
 * Tabs: Logs, Conversation History, System Prompt.
 * All tools route to the root view since this is a single-instance pip.
 */
app.resource({
  name: "Devkit",
  uri: DEVKIT_UI_URI,
  description: "Log viewer, conversation inspector, and developer tools",
  displayModes: ["pip"],
  html: "devkit/ui/index.html",
  icon: { svg: ICON_SVG, alt: ICON_ALT },
  views: {
    "/": [
      "devkit_get_logs",
      "devkit_reload_mcp_app",
      "devkit_get_mcp_app_sdk_docs",
      "devkit_get_conversation",
      "devkit_get_system_prompt",
    ],
  },
});

// =============================================================================
// Tools (Host-managed - handlers return placeholders)
// =============================================================================

/**
 * Fetch recent logs from Creature's aggregated log system.
 *
 * Host-managed: the control plane reads from LogAggregator directly.
 * This handler is a no-op placeholder.
 */
app.tool(
  "devkit_get_logs",
  {
    description: "Fetch recent logs from Creature's aggregated log system. Use filter 'all' for the last 50 logs, 'current_mcp_app' with mcpName to filter by a specific MCP App, or 'errors' for error-level entries only.",
    input: z.object({
      filter: z.enum(["all", "current_mcp_app", "errors"]).optional().default("all").describe("Log filter mode"),
      mcpName: z.string().optional().describe("MCP App server name to filter by (required when filter is 'current_mcp_app')"),
    }),
    ui: DEVKIT_UI_URI,
    visibility: ["model", "app"],
    experimental: {
      openInBackground: true,
    },
  },
  async () => ({
    data: { placeholder: true },
    text: "Logs fetched",
  })
);

/**
 * Restart an MCP App server and refresh all its pip instances.
 *
 * Host-managed: the control plane calls restartMcp() directly.
 * This handler is a no-op placeholder.
 */
app.tool(
  "devkit_reload_mcp_app",
  {
    description: "Restart an MCP App server and reload all its pip instances. Use this after code changes to see updates.",
    input: z.object({
      mcpName: z.string().describe("The MCP App server name to restart"),
    }),
    ui: DEVKIT_UI_URI,
    visibility: ["model", "app"],
    experimental: {
      openInBackground: true,
    },
  },
  async () => ({
    data: { placeholder: true },
    text: "MCP App refreshed",
  })
);

/**
 * Fetch the MCP App SDK reference documentation.
 *
 * Host-managed: the control plane reads the file from disk.
 * This handler is a no-op placeholder.
 */
app.tool(
  "devkit_get_mcp_app_sdk_docs",
  {
    description: "Fetch the MCP App SDK reference documentation (open-mcp-app). Use this to learn how to build MCP Apps.",
    input: z.object({}),
    visibility: ["model"],
  },
  async () => ({
    data: { placeholder: true },
    text: "SDK docs fetched",
  })
);

/**
 * Fetch the current conversation history for inspection.
 *
 * Host-managed: the control plane reads from the conversation store.
 * App-only visibility: not shown to the model, only callable from the UI.
 */
app.tool(
  "devkit_get_conversation",
  {
    description: "Fetch the current conversation history for developer inspection.",
    input: z.object({}),
    ui: DEVKIT_UI_URI,
    visibility: ["app"],
    experimental: {
      openInBackground: true,
    },
  },
  async () => ({
    data: { placeholder: true },
    text: "Conversation fetched",
  })
);

/**
 * Fetch the current system prompt for inspection.
 *
 * Host-managed: the control plane reads from the agent module.
 * App-only visibility: not shown to the model, only callable from the UI.
 */
app.tool(
  "devkit_get_system_prompt",
  {
    description: "Fetch the current system prompt for developer inspection.",
    input: z.object({}),
    ui: DEVKIT_UI_URI,
    visibility: ["app"],
    experimental: {
      openInBackground: true,
    },
  },
  async () => ({
    data: { placeholder: true },
    text: "System prompt fetched",
  })
);

// =============================================================================
// Server Lifecycle
// =============================================================================

const main = async () => {
  console.log("[Devkit] Starting MCP server");
  await app.start();
  console.log("[Devkit] MCP server ready on port", PORT);
};

process.on("SIGTERM", () => {
  console.log("[Devkit] Received SIGTERM, shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[Devkit] Received SIGINT, shutting down...");
  process.exit(0);
});

main().catch((error) => {
  console.error("[Devkit] Failed to start server", error);
  process.exit(1);
});
