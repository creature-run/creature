#!/usr/bin/env node
/**
 * Todos MCP Server
 *
 * Main entry point for the todos MCP. Wires together:
 * - App configuration
 * - UI resources
 * - Tools (registered from /tools)
 *
 * The app runs as an Express server at /mcp endpoint.
 */

import { createApp } from "open-mcp-app/server";
import { registerTodosTools } from "./tools/todos.js";
import { MCP_NAME, TODOS_UI_URI } from "./lib/types.js";
import { ICON_SVG, ICON_ALT } from "./icon.js";

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.MCP_PORT || process.env.PORT || "3005", 10);

// =============================================================================
// App Definition
// =============================================================================

const app = createApp({
  name: MCP_NAME,
  version: "0.1.0",
  port: PORT,
  instructions: `Todo list manager with batch operations. All batch tools support multiple items per call.

Tools:
- todos_list: Display all todos in the interactive list UI (returns summaries without notes)
- todos_open { id }: Open a todo in detail view for editing notes (opens UI)
- todos_get { id }: Get a single todo with full details including notes (no UI)
- todos_add { items: [{ text, notes? }, ...] }: Create one or more todos (text max 250 chars, optional notes for longer descriptions)
- todos_toggle { ids: [...] }: Toggle completed status (sets/clears completedAt timestamp)
- todos_update { id, text?, notes? }: Update a todo's text and/or notes
- todos_remove { ids: [...] }: Delete one or more todos
- todos_search { query, limit? }: Full-text search across todos

IMPORTANT: The "text" field is limited to 250 characters for brief task names. Use the "notes" field for longer descriptions, context, or details.

Use todos_list to open the interactive pip when the user wants to see or manage their todos.
Use todos_open to view or edit a specific todo's notes in detail view.

Response style: The user can see the todo list UI, so don't repeat todo contents in your responses. Keep it brief with simple status updates like "Added 5 todos" or "Marked 3 as complete".`,
});

// =============================================================================
// UI Resources
// =============================================================================

/**
 * Todos UI resource.
 *
 * Uses view-based routing for list and detail views.
 * Single-instance app - both views share the same pip window.
 *
 * Views:
 * - "/" (list): Shows all todos, handles add/toggle/remove/search
 * - "/detail/:todoId": Shows single todo detail with notes editing
 */
app.resource({
  name: "Todo List",
  uri: TODOS_UI_URI,
  description: "Interactive todo list with add, toggle, and delete",
  displayModes: ["pip", "inline"],
  html: "todos/ui/index.html",
  icon: { svg: ICON_SVG, alt: ICON_ALT },
  views: {
    "/": ["todos_list", "todos_add", "todos_toggle", "todos_remove", "todos_search"],
    "/detail/:todoId": ["todos_open", "todos_get", "todos_update"],
  },
});

// =============================================================================
// Tools
// =============================================================================

registerTodosTools(app);

// =============================================================================
// Server Lifecycle
// =============================================================================

const main = async () => {
  console.log("[Todos] Starting MCP server");
  await app.start();
  console.log("[Todos] MCP server ready on port", PORT);
};

process.on("SIGTERM", () => {
  console.log("[Todos] Received SIGTERM, shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[Todos] Received SIGINT, shutting down...");
  process.exit(0);
});

main().catch((error) => {
  console.error("[Todos] Failed to start server", error);
  process.exit(1);
});
