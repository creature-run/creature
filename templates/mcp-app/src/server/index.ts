/**
 * MCP App Server
 *
 * Minimal server setup. Add tools in src/server/tools/ and register them here.
 */

import { createApp } from "open-mcp-app/server";
import { z } from "zod";

/**
 * Server port configuration.
 */
const PORT = parseInt(process.env.MCP_PORT || process.env.PORT || "3000");

/**
 * Phosphor "Sparkle" icon SVG. Uses currentColor for host theming.
 */
const APP_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M197.58,129.06,146,110l-19-51.62a15.92,15.92,0,0,0-29.88,0L78,110l-51.62,19a15.92,15.92,0,0,0,0,29.88L78,178l19,51.62a15.92,15.92,0,0,0,29.88,0L146,178l51.62-19a15.92,15.92,0,0,0,0-29.88ZM137,164.22a8,8,0,0,0-4.74,4.74L112,223.85,91.78,169A8,8,0,0,0,87,164.22L32.15,144,87,123.78A8,8,0,0,0,91.78,119L112,64.15,132.22,119a8,8,0,0,0,4.74,4.74L191.85,144ZM144,40a8,8,0,0,1,8-8h16V16a8,8,0,0,1,16,0V32h16a8,8,0,0,1,0,16H184V64a8,8,0,0,1-16,0V48H152A8,8,0,0,1,144,40ZM248,88a8,8,0,0,1-8,8h-8v8a8,8,0,0,1-16,0V96h-8a8,8,0,0,1,0-16h8V72a8,8,0,0,1,16,0v8h8A8,8,0,0,1,248,88Z"/></svg>`;

/**
 * Create the MCP App.
 */
const app = createApp({
  name: "__APP_NAME__",
  version: "0.1.0",
  port: PORT,
  instructions: `Describe your MCP App and its tools here.
Keep instructions concise — the UI communicates visually.`,
  logToolCalls: true,
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
  icon: { svg: APP_ICON, alt: "__APP_NAME__" },
  views: {
    "/": [],
  },
});

/**
 * Start the server.
 */
const main = async () => {
  await app.start();
  console.log(`MCP App running on port ${PORT}`);
};

main().catch((err) => {
  console.error("[__APP_NAME__] Failed to start:", err);
  process.exit(1);
});
