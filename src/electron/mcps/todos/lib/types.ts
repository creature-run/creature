/**
 * Type Definitions
 *
 * All shared types for the Todos MCP.
 */

// =============================================================================
// Constants
// =============================================================================

export const MCP_NAME = "todos";
export const TODOS_UI_URI = `ui://${MCP_NAME}/todos`;

// =============================================================================
// Data Types
// =============================================================================

/**
 * A todo item stored in the data layer.
 */
export interface Todo {
  id: string;
  /** Short task description (max 250 characters) */
  text: string;
  /** Optional longer description/notes */
  notes?: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
  /** Set when completed, cleared when uncompleted */
  completedAt?: string;
}

/**
 * Summary of a todo for list views (excludes notes field to minimize payload).
 */
export interface TodoSummary {
  id: string;
  text: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

// =============================================================================
// Tool Types
// =============================================================================

// Re-export ToolContext from SDK - includes instanceId, setState, getState, etc.
export type { ToolContext, ToolResult } from "open-mcp-app/server";
