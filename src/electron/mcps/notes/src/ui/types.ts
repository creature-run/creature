/**
 * Type definitions for the Notes MCP App.
 */

export interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface NoteSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export type ViewType = "list" | "editor";

/**
 * Data structure returned by notes tools.
 * Used for both agent-initiated and UI-initiated tool calls.
 */
export interface NoteData {
  note?: Note;
  notes?: NoteSummary[];
  view?: ViewType;
  success?: boolean;
  error?: string;
  instanceId?: string;
}

/**
 * Widget state structure for persistence across sessions.
 * Follows the MCP Apps / ChatGPT Apps widget state format.
 */
export interface NoteWidgetState {
  /** Concise summary for the agent - enough context to interact */
  modelContent: {
    view: ViewType;
    noteId?: string;
    noteTitle?: string;
    wordCount?: number;
    noteCount?: number;
  };
  /** UI-only state for persistence - not visible to agent */
  privateContent: {
    lastNote: Note | null;
    lastNotes: NoteSummary[] | null;
    lastView: ViewType;
  };
}
