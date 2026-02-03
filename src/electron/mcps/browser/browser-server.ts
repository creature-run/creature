#!/usr/bin/env node
/**
 * MCP Browser Server
 *
 * Lightweight MCP server that declares browser automation tools.
 * The actual browser rendering is handled by the Host using Electron's
 * native webview - this server just provides the tool interface.
 */

import { createApp } from "open-mcp-app/server";
import { z } from "zod";
import { ICON_SVG, ICON_ALT } from "./icon.js";

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.MCP_PORT || process.env.PORT || "3102", 10);
const BROWSER_UI_RESOURCE_URI = "ui://mcp-browser/browser";

// =============================================================================
// SDK App Setup
// =============================================================================

const app = createApp({
  name: "browser",
  version: "0.0.1",
  port: PORT,
});

// =============================================================================
// UI Resource
// =============================================================================

app.resource({
  name: "Browser Control",
  uri: BROWSER_UI_RESOURCE_URI,
  description: "Browser tab for browsing the web",
  displayModes: ["pip"],
  html: "browser/ui/index.html",
  icon: { svg: ICON_SVG, alt: ICON_ALT },
  instanceMode: "multiple",
  views: {
    "/browser": ["browser_create"],
    "/browser/:instanceId": [
      "browser_navigate",
      "browser_click",
      "browser_type",
      // "browser_screenshot", // TEMPORARILY DISABLED
      "browser_scroll",
      "browser_back",
      "browser_forward",
      "browser_reload",
      "browser_close",
    ],
  },
});

// =============================================================================
// Tools
// =============================================================================

/**
 * Create a new browser instance.
 * This is a "create" tool - instanceId is generated automatically by the SDK.
 */
app.tool(
  "browser_create",
  {
    description: "Create a new browser. Opens a browser panel where you can navigate and interact with web pages.",
    input: z.object({
      url: z.string().optional().describe("Initial URL to navigate to (default: about:blank)"),
    }),
    ui: BROWSER_UI_RESOURCE_URI,
    visibility: ["model", "app"],
    displayModes: ["pip"],
    experimental: {
      defaultDisplayMode: "pip",
    },
  },
  async ({ url }) => ({
    data: { action: "create", url: url || "about:blank" },
    text: `Browser requested for ${url || "about:blank"}`,
    title: "New Browser",
  })
);

/**
 * Navigate the browser to a URL.
 * Requires instanceId to target a specific browser instance.
 */
app.tool(
  "browser_navigate",
  {
    description: "Navigate the browser to a URL.",
    input: z.object({
      instanceId: z.string().describe("The instance ID from browser_create"),
      url: z.string().describe("The URL to navigate to"),
    }),
    ui: BROWSER_UI_RESOURCE_URI,
    visibility: ["model", "app"],
  },
  async ({ instanceId, url }) => ({
    data: { action: "navigate", instanceId, url },
    text: `Navigating to ${url}`,
  })
);

/**
 * Click at specific coordinates or on an element.
 */
app.tool(
  "browser_click",
  {
    description: "Click at specific coordinates or on an element matching a CSS selector.",
    input: z.object({
      instanceId: z.string().describe("The instance ID from browser_create"),
      x: z.number().optional().describe("X coordinate to click"),
      y: z.number().optional().describe("Y coordinate to click"),
      selector: z.string().optional().describe("CSS selector for element to click"),
    }),
    ui: BROWSER_UI_RESOURCE_URI,
    visibility: ["model", "app"],
  },
  async ({ instanceId, x, y, selector }) => ({
    data: { action: "click", instanceId, x, y, selector },
    text: `Click at ${selector || `(${x}, ${y})`}`,
  })
);

/**
 * Type text into an element.
 */
app.tool(
  "browser_type",
  {
    description: "Type text into the currently focused element or an element matching a CSS selector.",
    input: z.object({
      instanceId: z.string().describe("The instance ID from browser_create"),
      text: z.string().describe("Text to type"),
      selector: z.string().optional().describe("CSS selector for element to type into"),
    }),
    ui: BROWSER_UI_RESOURCE_URI,
    visibility: ["model", "app"],
  },
  async ({ instanceId, text, selector }) => ({
    data: { action: "type", instanceId, text, selector },
    text: `Typing ${text.length} characters`,
  })
);

/**
 * Take a screenshot of the current page.
 * TEMPORARILY DISABLED - will be re-enabled later
 */
// app.tool(
//   "browser_screenshot",
//   {
//     description: "Take a screenshot of the current page. Use this to see what's on the page.",
//     input: z.object({
//       instanceId: z.string().describe("The instance ID from browser_create"),
//       fullPage: z.boolean().optional().describe("Capture the full scrollable page (default: false)"),
//     }),
//     ui: BROWSER_UI_RESOURCE_URI,
//     visibility: ["model", "app"],
//   },
//   async ({ instanceId, fullPage }) => ({
//     data: { success: true, action: "screenshot", instanceId, fullPage },
//     text: "Screenshot requested - see browser pip",
//   })
// );

/**
 * Scroll the page.
 */
app.tool(
  "browser_scroll",
  {
    description: "Scroll the page up, down, or to a specific element.",
    input: z.object({
      instanceId: z.string().describe("The instance ID from browser_create"),
      direction: z.enum(["up", "down"]).optional().describe("Scroll direction"),
      amount: z.number().optional().describe("Scroll amount in pixels (default: 400)"),
      selector: z.string().optional().describe("CSS selector for element to scroll into view"),
    }),
    ui: BROWSER_UI_RESOURCE_URI,
    visibility: ["model", "app"],
  },
  async ({ instanceId, direction, amount, selector }) => ({
    data: { action: "scroll", instanceId, direction, amount, selector },
    text: `Scroll ${direction || "to element"}`,
  })
);

/**
 * Go back in browser history.
 */
app.tool(
  "browser_back",
  {
    description: "Go back to the previous page in browser history.",
    input: z.object({
      instanceId: z.string().describe("The instance ID from browser_create"),
    }),
    ui: BROWSER_UI_RESOURCE_URI,
    visibility: ["model", "app"],
  },
  async ({ instanceId }) => ({
    data: { action: "back", instanceId },
    text: "Going back",
  })
);

/**
 * Go forward in browser history.
 */
app.tool(
  "browser_forward",
  {
    description: "Go forward to the next page in browser history.",
    input: z.object({
      instanceId: z.string().describe("The instance ID from browser_create"),
    }),
    ui: BROWSER_UI_RESOURCE_URI,
    visibility: ["model", "app"],
  },
  async ({ instanceId }) => ({
    data: { action: "forward", instanceId },
    text: "Going forward",
  })
);

/**
 * Reload the current page.
 */
app.tool(
  "browser_reload",
  {
    description: "Reload the current page.",
    input: z.object({
      instanceId: z.string().describe("The instance ID from browser_create"),
    }),
    ui: BROWSER_UI_RESOURCE_URI,
    visibility: ["model", "app"],
  },
  async ({ instanceId }) => ({
    data: { action: "reload", instanceId },
    text: "Reloading page",
  })
);

/**
 * Close a browser instance.
 */
app.tool(
  "browser_close",
  {
    description: "Close a browser instance.",
    input: z.object({
      instanceId: z.string().describe("The instance ID from browser_create"),
    }),
    ui: BROWSER_UI_RESOURCE_URI,
    visibility: ["model", "app"],
  },
  async ({ instanceId }) => ({
    data: { action: "close", instanceId },
    text: `Closing browser instance`,
  })
);

// =============================================================================
// Server Lifecycle
// =============================================================================

const main = async () => {
  console.log("[Browser] Starting MCP server");
  await app.start();
  console.log("[Browser] MCP server ready on port", PORT);
};

process.on("SIGTERM", () => {
  console.log("[Browser] Received SIGTERM, shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[Browser] Received SIGINT, shutting down...");
  process.exit(0);
});

main().catch((error) => {
  console.error("[Browser] Failed to start server", error);
  process.exit(1);
});
