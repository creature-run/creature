/**
 * Dev Console IPC Handlers
 *
 * Handles IPC events for the Dev Console and logging:
 * - Opening the Dev Console window
 * - Providing and clearing log entries
 * - Receiving UI Resource logs from the renderer
 * - Storing conversation history (consumed by Devkit MCP)
 *
 * Conversation and System Prompt inspection is handled by the Devkit MCP.
 * The updateConversation handler remains because ViewChat.tsx pushes
 * conversation state here, and the Devkit reads it via controlPlane.
 */

import { ipcMain } from "electron";
import { logAggregator, type LogLevel } from "../logging";
import { openDevConsoleWindow } from "../window/devConsoleWindow";
import { setCurrentConversation } from "./chat.handlers";

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
   * Update the stored conversation history.
   * Called by the renderer when conversation changes.
   * Data is consumed by the Devkit MCP's devkit_get_conversation tool.
   */
  ipcMain.on("devconsole:updateConversation", (_event, messages: unknown[]) => {
    setCurrentConversation(messages);
  });
};
