/**
 * Dev Console IPC Handlers
 *
 * Handles IPC events for the Dev Console:
 * - Opening the Dev Console window
 * - Providing log entries (delegated to logs module)
 * - Providing conversation history
 * - Providing the current system prompt
 */

import { ipcMain } from "electron";
import { logAggregator, type LogLevel } from "../logging";
import { openDevConsoleWindow } from "../window/devConsoleWindow";
import { getCurrentConversation } from "./chat.handlers";
import { getCurrentSystemPrompt } from "../agent";

/**
 * Register IPC handlers for the Dev Console.
 */
export const registerDevConsoleHandlers = () => {
  /**
   * Handle UI Resource logs forwarded from the renderer.
   * The renderer receives these via postMessage from iframe console overrides
   * and forwards them to main process for centralized logging.
   */
  ipcMain.on("logs:fromUI", (_event, data: {
    instanceId: string;
    mcpServer: string;
    level: string;
    message: string;
    timestamp: string;
  }) => {
    logAggregator.log({
      source: "ui",
      sourceName: data.mcpServer,
      level: data.level as LogLevel,
      message: data.message,
    });
  });

  /**
   * Open the Dev Console window.
   * Returns success status. The window is a singleton - if already open, focuses it.
   */
  ipcMain.handle("devconsole:openWindow", async () => {
    return openDevConsoleWindow();
  });

  /**
   * Get recent log entries.
   * Used by the Dev Console Logs tab to populate content.
   */
  ipcMain.handle("logs:getRecent", async (_event, count?: number) => {
    return logAggregator.getRecent(count);
  });

  /**
   * Clear all log entries.
   */
  ipcMain.handle("logs:clear", async () => {
    logAggregator.clear();
    return { success: true };
  });

  /**
   * Get the current conversation history.
   * Returns the messages array from the current chat session.
   */
  ipcMain.handle("devconsole:getConversation", async () => {
    return getCurrentConversation();
  });

  /**
   * Get the current system prompt.
   * Returns the full system prompt including dynamic content.
   */
  ipcMain.handle("devconsole:getSystemPrompt", async () => {
    return getCurrentSystemPrompt();
  });

  /**
   * Update the stored conversation history.
   * Called by the renderer when conversation changes.
   */
  ipcMain.on("devconsole:updateConversation", (_event, messages: unknown[]) => {
    // Store in chat.handlers for retrieval
    setCurrentConversation(messages);
  });
};

// Re-export for use in chat.handlers
import { setCurrentConversation } from "./chat.handlers";

