/**
 * Shared type definitions for the Devkit UI.
 *
 * Centralised here so every view module can import the same
 * shapes without circular dependencies.
 */

/** Identifier for each tab in the devkit. */
export type TabId = "logs" | "conversation" | "prompt" | "components";

/**
 * Log entry from Creature's LogAggregator.
 * Shape matches what handleDevkitToolCall returns.
 */
export interface LogEntry {
  id: string;
  timestamp: string;
  source: "host" | "mcp" | "ui";
  sourceName?: string;
  level: string;
  message: string;
}

export interface LogsData {
  type: "logs";
  logs: LogEntry[];
  filter: string;
  mcpName?: string;
  total: number;
}

export interface ConversationData {
  type: "conversation";
  messages: ConversationMessage[];
}

/**
 * A single message in the conversation.
 * Shape is whatever the agent stores — we render it generically.
 */
export interface ConversationMessage {
  id?: string;
  role?: string;
  content?: unknown;
  parts?: Array<{
    type: string;
    text?: string;
    toolInvocation?: { toolName: string };
    toolName?: string;
  }>;
  [key: string]: unknown;
}

export interface PromptData {
  type: "system_prompt";
  prompt: string;
}

export interface RefreshData {
  type: "refresh";
  success: boolean;
  mcpName: string;
  error?: string;
}

/** Union of all possible tool-result payloads the devkit handles. */
export type DevkitData = LogsData | ConversationData | PromptData | RefreshData;
