/**
 * Chat IPC Handlers
 *
 * Handles chat server lifecycle via IPC events.
 * The chat server is started lazily when a project folder is opened,
 * ensuring the chat screen is only available after folder selection.
 *
 * Also stores the current conversation history for Dev Console access.
 */

import { dialog, ipcMain } from "electron";
import fs from "node:fs";
import { startChatServer, isChatServerRunning } from "../server/chatServer";
import {
  listSessions,
  getActiveSession,
  createSession,
  switchSession,
  saveSessionState,
  renameSession,
  setSessionPinned,
  buildSessionMarkdownExport,
  type ChatSessionState,
} from "../storage/chatSessionStore";

/**
 * Stores the current conversation history.
 * Updated by the renderer when messages change.
 * Used by the Dev Console to display conversation state.
 */
let currentConversation: unknown[] = [];

const SESSION_EXPORT_FILENAME_FALLBACK = "chat-session";

const toSessionExportFilename = (title: string): string => {
  const normalized = title
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  const safeTitle = normalized.length > 0 ? normalized : SESSION_EXPORT_FILENAME_FALLBACK;
  return `${safeTitle.slice(0, 80).replace(/\s+/g, "-")}.md`;
};

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

  /**
   * List all saved chat sessions for a project.
   */
  ipcMain.handle("chatSession:list", async (_, { projectId }: { projectId: string }) => {
    try {
      if (!projectId) {
        return { success: false, error: "projectId is required" };
      }

      const sessions = listSessions(projectId);
      return { success: true, sessions };
    } catch (error) {
      console.error("[ChatSession] Failed to list sessions:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to list sessions",
      };
    }
  });

  /**
   * Get the active chat session and its state for a project.
   * Creates an initial session automatically when none exists.
   */
  ipcMain.handle("chatSession:getActive", async (_, { projectId }: { projectId: string }) => {
    try {
      if (!projectId) {
        return { success: false, error: "projectId is required" };
      }

      const { session, sessions } = getActiveSession(projectId);
      return { success: true, session, sessions };
    } catch (error) {
      console.error("[ChatSession] Failed to load active session:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load active session",
      };
    }
  });

  /**
   * Create a new chat session for a project and make it active.
   */
  ipcMain.handle("chatSession:create", async (_, { projectId }: { projectId: string }) => {
    try {
      if (!projectId) {
        return { success: false, error: "projectId is required" };
      }

      const { session, sessions } = createSession(projectId);
      return { success: true, session, sessions };
    } catch (error) {
      console.error("[ChatSession] Failed to create session:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create session",
      };
    }
  });

  /**
   * Switch the active session for a project.
   */
  ipcMain.handle(
    "chatSession:switch",
    async (_, { projectId, sessionId }: { projectId: string; sessionId: string }) => {
      try {
        if (!projectId) {
          return { success: false, error: "projectId is required" };
        }
        if (!sessionId) {
          return { success: false, error: "sessionId is required" };
        }

        const { session, sessions } = switchSession(projectId, sessionId);
        return { success: true, session, sessions };
      } catch (error) {
        console.error("[ChatSession] Failed to switch session:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to switch session",
        };
      }
    }
  );

  /**
   * Persist chat session state for a project session.
   */
  ipcMain.handle(
    "chatSession:save",
    async (
      _,
      {
        projectId,
        sessionId,
        state,
      }: { projectId: string; sessionId: string; state: ChatSessionState }
    ) => {
      try {
        if (!projectId) {
          return { success: false, error: "projectId is required" };
        }
        if (!sessionId) {
          return { success: false, error: "sessionId is required" };
        }
        if (!state || typeof state !== "object") {
          return { success: false, error: "state is required" };
        }

        const { session } = saveSessionState(projectId, sessionId, state);
        return { success: true, session };
      } catch (error) {
        console.error("[ChatSession] Failed to save session state:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to save session state",
        };
      }
    }
  );

  ipcMain.handle(
    "chatSession:rename",
    async (
      _,
      { projectId, sessionId, title }: { projectId: string; sessionId: string; title: string }
    ) => {
      try {
        if (!projectId) {
          return { success: false, error: "projectId is required" };
        }
        if (!sessionId) {
          return { success: false, error: "sessionId is required" };
        }
        if (typeof title !== "string") {
          return { success: false, error: "title is required" };
        }

        const { session, sessions } = renameSession(projectId, sessionId, title);
        return { success: true, session, sessions };
      } catch (error) {
        console.error("[ChatSession] Failed to rename session:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to rename session",
        };
      }
    }
  );

  ipcMain.handle(
    "chatSession:setPinned",
    async (
      _,
      { projectId, sessionId, pinned }: { projectId: string; sessionId: string; pinned: boolean }
    ) => {
      try {
        if (!projectId) {
          return { success: false, error: "projectId is required" };
        }
        if (!sessionId) {
          return { success: false, error: "sessionId is required" };
        }
        if (typeof pinned !== "boolean") {
          return { success: false, error: "pinned must be a boolean" };
        }

        const { session, sessions } = setSessionPinned(projectId, sessionId, pinned);
        return { success: true, session, sessions };
      } catch (error) {
        console.error("[ChatSession] Failed to update session pin state:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to update session pin state",
        };
      }
    }
  );

  ipcMain.handle(
    "chatSession:exportMarkdown",
    async (_, { projectId, sessionId }: { projectId: string; sessionId: string }) => {
      try {
        if (!projectId) {
          return { success: false, error: "projectId is required" };
        }
        if (!sessionId) {
          return { success: false, error: "sessionId is required" };
        }

        const { summary, markdown } = buildSessionMarkdownExport(projectId, sessionId);
        const result = await dialog.showSaveDialog({
          title: "Export Chat as Markdown",
          defaultPath: toSessionExportFilename(summary.title),
          filters: [{ name: "Markdown", extensions: ["md"] }],
        });

        if (result.canceled || !result.filePath) {
          return { success: false, canceled: true };
        }

        fs.writeFileSync(result.filePath, markdown, "utf8");
        return {
          success: true,
          filePath: result.filePath,
        };
      } catch (error) {
        console.error("[ChatSession] Failed to export session as markdown:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to export session as markdown",
        };
      }
    }
  );
};
