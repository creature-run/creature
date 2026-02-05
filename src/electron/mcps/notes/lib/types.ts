/**
 * Type Definitions
 *
 * All shared types for the Notes MCP.
 */

// =============================================================================
// Constants
// =============================================================================

export const MCP_NAME = "notes";

/**
 * URI for the notes UI resource.
 *
 * A single resource handles all views (list and editor) using view-based routing.
 * The views config maps URL-like patterns to tools, and the control plane
 * routes tool calls to the correct pip instance based on path parameters.
 */
export const NOTES_UI_URI = `ui://${MCP_NAME}/notes`;

// =============================================================================
// Data Types
// =============================================================================

/**
 * A note document stored in the data layer.
 */
export interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Summary of a note for list views (excludes content to minimize payload).
 */
export interface NoteSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Instance State
// =============================================================================

/**
 * Per-instance state stored by the SDK.
 * Associates a UI widget instance with its note or view type.
 */
export interface NoteInstanceState {
  noteId?: string;
  view: "editor" | "list";
}

// =============================================================================
// Tool Types
// =============================================================================

// Re-export ToolContext from SDK - includes instanceId, setState, getState, etc.
export type { ToolContext, ToolResult } from "open-mcp-app/server";
