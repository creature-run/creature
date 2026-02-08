/**
 * MCP App Server
 *
 * Minimal server setup. Add tools in src/server/tools/ and register them here.
 */

import { createApp } from "open-mcp-app/server";

/**
 * Server port configuration.
 */
const PORT = parseInt(process.env.MCP_PORT || process.env.PORT || "3000");

/**
 * Create the MCP App.
 */
const app = createApp({
  name: "__APP_NAME__",
  version: "0.1.0",
  port: PORT,
  instructions: `Describe your MCP App and its tools here.
Keep instructions concise — the UI communicates visually.`,
});

/**
 * Register the UI resource.
 *
 * One resource handles all views. Add view routing as you add tools.
 */
app.resource({
  name: "__APP_NAME__",
  uri: "ui://__APP_NAME__/main",
  description: "Main UI",
  displayModes: ["pip"],
  html: "ui/index.html",
  views: {
    "/": [],
  },
});

/**
 * Start the server.
 */
app.start();

console.log(`MCP App running on port ${PORT}`);
