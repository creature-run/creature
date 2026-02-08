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
import { bufferUiError } from "../mcp/client";
import { markPipUiError } from "../mcp/controlPlane";

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

    // Buffer error-level UI logs so the agent's prepareStep can inject
    // them as system messages. This surfaces UI runtime errors (TypeError,
    // unhandled rejections, etc.) directly to the model for self-correction.
    // Also mark pips for this MCP as having UI errors so the next pip
    // refresh forces a re-render even if the HTML content is unchanged.
    if (data.level === "error") {
      bufferUiError({
        serverName: data.mcpServer,
        message: data.message,
      });
      markPipUiError({ serverName: data.mcpServer });
    }
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
