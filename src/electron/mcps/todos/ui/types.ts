/**
 * Type Definitions for Todos UI
 */

export interface Todo {
  id: string;
  text: string;
  notes?: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/**
 * Tool result data structure.
 * Tools return this shape with the current todos list.
 */
export interface TodoData {
  todos?: Todo[];
  todo?: Todo;
  view?: "list" | "detail";
  success?: boolean;
  error?: string;
  added?: Todo[];
  toggled?: Todo[];
  updated?: Todo;
  deleted?: { id: string; text: string }[];
  notFound?: string[];
}

/**
 * Search result data structure.
 */
export interface SearchResultData {
  query: string;
  matches: Array<{
    id: string;
    text: string;
    completed: boolean;
    snippet?: string;
    score?: number;
  }>;
  todos?: Todo[];
}

/**
 * Widget state structure following MCP Apps spec.
 */
export interface TodoWidgetState {
  modelContent: {
    countTotal: number;
    countIncomplete: number;
  };
  privateContent: {
    todos: Todo[];
    lastViewedAt: string | null;
  };
}

export type View = "list" | "detail";
