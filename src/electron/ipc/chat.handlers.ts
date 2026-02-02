/**
 * Chat IPC Handlers
 *
 * Handles chat server lifecycle via IPC events.
 * The chat server is started lazily when a project folder is opened,
 * ensuring the chat screen is only available after folder selection.
 *
 * Also stores the current conversation history for Dev Console access.
 */

import { ipcMain } from "electron";
import { startChatServer, isChatServerRunning } from "../server/chatServer";

/**
 * Stores the current conversation history.
 * Updated by the renderer when messages change.
 * Used by the Dev Console to display conversation state.
 */
let currentConversation: unknown[] = [];

/**
 * Get the current conversation history.
 */
export const getCurrentConversation = (): unknown[] => {
  return currentConversation;
};

/**
 * Set the current conversation history.
 * Called when the renderer broadcasts conversation updates.
 */
export const setCurrentConversation = (messages: unknown[]): void => {
  currentConversation = messages;
};

/**
 * Register chat-related IPC handlers.
 *
 * Provides the renderer with the ability to start the chat server
 * when a folder is selected. The server is only started once and
 * subsequent calls are no-ops.
 */
export const registerChatHandlers = () => {
  /**
   * Start the chat server.
   * Called by the renderer when a folder is selected.
   * Safe to call multiple times - only starts if not already running.
   */
  ipcMain.handle("chat:start", async () => {
    try {
      startChatServer();
      return { success: true };
    } catch (error) {
      console.error("[ChatHandlers] Failed to start chat server:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  /**
   * Check if the chat server is currently running.
   * Used by the renderer to determine if the chat UI should be enabled.
   */
  ipcMain.handle("chat:isRunning", async () => {
    return { running: isChatServerRunning() };
  });
};

