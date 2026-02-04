/**
 * Notes MCP App
 *
 * Main app definition. Wires together:
 * - App configuration
 * - UI resources (editor and list views)
 * - Tools (registered from /tools)
 *
 * The app runs as an Express server at /mcp endpoint.
 */

import { createApp } from "open-mcp-app/server";
import { registerNotesTools } from "./tools/notes.js";
import { MCP_NAME, NOTES_UI_URI } from "./lib/types.js";
import { ICON_SVG, ICON_ALT } from "./lib/icon.js";

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.MCP_PORT || process.env.PORT || "3004", 10);

// =============================================================================
// App Definition
// =============================================================================

const app = createApp({
  name: MCP_NAME,
  version: "0.1.0",
  port: PORT,
  instructions: `This MCP manages notes with separate tools:

- notes_list - Display all notes in a list (opens UI). Returns summaries without content for efficiency.
- notes_create { title?, content? } - Create a new note and open it in an editor (opens UI)
- notes_open { noteId } - Open an existing note for editing (opens UI). Returns full note with content.
- notes_save { noteId, title, content } - Save changes to a note (updates existing UI). Returns minimal data.
- notes_delete { noteId } - Delete a note (no UI)
- notes_search { query, limit? } - Full-text search across notes. Returns matching titles and snippets.

Each note opens in its own editor window. The list view shows all notes.

Use notes_open to retrieve full content when you need to read or display a note's content. The list and save operations return minimal data to stay within payload limits.

IMPORTANT: The title and content are stored separately. Do NOT include the title as a heading in the content - it is already displayed in the title field above the editor.`,
});

// =============================================================================
// UI Resources
// =============================================================================

/**
 * Notes UI resource.
 *
 * Uses view-based routing to control pip instances:
 * - "/" (root): notes_list - single instance for list view
 * - "/editor": notes_create - always creates new pip
 * - "/editor/:noteId": notes_open, notes_save, notes_delete - one instance per unique noteId
 */
app.resource({
  name: "Notes",
  uri: NOTES_UI_URI,
  description: "Markdown notes app with list and editor views",
  displayModes: ["pip"],
  instanceMode: "multiple",
  html: "../../dist/ui/main.html",
  icon: { svg: ICON_SVG, alt: ICON_ALT },
  views: {
    "/": ["notes_list"],
    "/editor": ["notes_create"],
    "/editor/:noteId": ["notes_open", "notes_save", "notes_delete"],
  },
});

// =============================================================================
// Tools
// =============================================================================

registerNotesTools(app);

// =============================================================================
// Start Server
// =============================================================================

app.start();
