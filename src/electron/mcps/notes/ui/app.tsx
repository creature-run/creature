/**
 * MCP Notes UI
 *
 * A notes app demonstrating cross-platform multi-instance MCP Apps.
 *
 * Cross-Platform Compatibility:
 * - Works in Creature (MCP Apps host)
 * - Works in ChatGPT Apps
 * - Works in any generic MCP Apps host
 *
 * Views:
 * - List view: Searchable list of all notes (polls for updates)
 * - Editor view: WYSIWYG markdown editor for a single note
 *
 * Features:
 * - Unified editor: edit markdown and see formatted preview in one view
 * - Saves via tool calls (compatible with all hosts)
 * - Auto-save on edit with debouncing
 * - Full markdown support via Milkdown
 * - List view polls every 5 seconds for new notes
 *
 * SDK hooks used:
 * - HostProvider: Provides host client to child components via context
 * - useHost: Access callTool, isReady, log, exp_widgetState from context
 *
 * File Structure:
 * - app.tsx: Entry point with HostProvider and NotesApp
 * - useNotes.ts: Custom hook with all state, tools, and effects
 * - ListView.tsx: List view component
 * - EditorView.tsx: Editor view component
 * - types.ts: Type definitions
 */

import { HostProvider } from "open-mcp-app/react";
import { NotesProvider, useNotesContext } from "./useNotes";
import { ListView } from "./ListView";
import { EditorView } from "./EditorView";
// Tailwind 4 integration - imports SDK theme mapping for host-provided variables
import "open-mcp-app/styles/tailwind.css";
import "./styles.css";

/**
 * Main notes app entry point.
 *
 * Wraps NotesApp with HostProvider and NotesProvider to provide
 * host client and notes state via context. This eliminates prop
 * drilling - child components access state via useNotesContext().
 */
export default function App() {
  return (
    <HostProvider name="notes" version="0.1.0">
      <NotesProvider>
        <NotesApp />
      </NotesProvider>
    </HostProvider>
  );
}

/**
 * Notes app component.
 *
 * Thin rendering layer that decides which view to render based on context.
 * All state and actions are accessed via useNotesContext().
 *
 * Shows a loading spinner until the host connection is ready.
 * This prevents flickering between views during initialization.
 */
function NotesApp() {
  const { isReady, view, note } = useNotesContext();

  // Show loading spinner until host is ready
  if (!isReady) {
    return (
      <div className="flex items-center justify-center h-full w-full bg-bg-primary text-txt-primary">
        <div className="w-6 h-6 border-2 border-bdr-secondary border-t-txt-primary rounded-full animate-spin" />
      </div>
    );
  }

  // Render editor view if editing a note
  if (view === "editor" && note) {
    return <EditorView />;
  }

  // Default: list view (handles empty state gracefully)
  return <ListView />;
}
