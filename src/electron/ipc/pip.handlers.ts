/**
 * Pip IPC Handlers
 *
 * Handles Control Plane pip-related IPC events.
 */

import { ipcMain } from "electron";
import {
  closePipInstance,
  markPipReady,
  markTeardownComplete,
  refreshSinglePip,
  handleToolCall,
  getPipInstance,
  updatePipTitle,
  updatePipWidgetState,
  type WidgetState,
} from "../mcp/controlPlane";
import { readResource, clearResourceCache } from "../mcp/client";

/**
 * Register pip-related IPC handlers.
 */
export const registerPipHandlers = () => {
  ipcMain.handle("pip:close", async (_, instanceId: string) => {
    const closed = await closePipInstance(instanceId);
    return { success: closed };
  });

  // Pip ready notification from renderer (ui/initialize completed)
  ipcMain.handle("pip:ready", async (_event, instanceId: string) => {
    const success = markPipReady(instanceId);
    return { success };
  });

  /**
   * Pip teardown complete notification from renderer.
   * Called after the iframe responds to ui/resource-teardown.
   * This allows the control plane to proceed with pip closure.
   */
  ipcMain.handle("pip:teardown-complete", async (_, instanceId: string) => {
    markTeardownComplete(instanceId);
    return { success: true };
  });

  ipcMain.handle("pip:refresh-content", async (_, instanceId: string) => {
    return await refreshSinglePip({ instanceId });
  });

  /**
   * Update pip title.
   * Used by browser pips to sync the webpage title to the pip tab.
   */
  ipcMain.handle(
    "pip:updateTitle",
    async (_, params: { instanceId: string; title: string }) => {
      const success = updatePipTitle({
        instanceId: params.instanceId,
        title: params.title,
      });
      return { success };
    }
  );

  /**
   * Update pip widget state.
   * Called when Guest UI sends widget-state-changed notification.
   * The modelContent is included in the system prompt for AI continuity.
   */
  ipcMain.handle(
    "pip:updateWidgetState",
    async (_, params: { instanceId: string; widgetState: WidgetState | null }) => {
      const success = updatePipWidgetState({
        instanceId: params.instanceId,
        widgetState: params.widgetState,
      });
      return { success };
    }
  );

  /**
   * Handle tool calls from UI pips (per MCP Apps spec).
   * UI pips can call tools on their MCP server via the Host.
   *
   * Routes through handleToolCall with source: 'ui' so the tool call
   * gets emitted as a ui-tool:executed event for conversation history injection.
   * This ensures the agent knows about user interactions with pips.
   */
  ipcMain.handle(
    "cp:call-tool",
    async (
      _,
      params: {
        serverName: string;
        toolName: string;
        args: Record<string, unknown>;
        instanceId?: string;
      }
    ) => {
      try {
        // Route through handleToolCall with source: 'ui'
        // This triggers the ui-tool:executed event for conversation history
        const result = await handleToolCall({
          serverName: params.serverName,
          toolName: params.toolName,
          args: params.args,
          instanceId: params.instanceId,
          source: "ui",
        });
        return result;
      } catch (error) {
        // Shutdown errors are expected when closing project - return gracefully, don't throw
        const isShutdownError = error instanceof Error && error.message.includes("shutdown in progress");
        if (isShutdownError) {
          return { success: false, error: "shutdown" };
        }
        console.error(`[IPC] UI tool call failed`, { toolName: params.toolName, serverName: params.serverName, error });
        throw error;
      }
    }
  );

  /**
   * Fetch HTML content for a UI resource.
   * Used by InlineWidget to load resource HTML without including it
   * in conversation history (which would bloat API token usage).
   */
  ipcMain.handle(
    "cp:get-resource-html",
    async (
      _,
      params: {
        serverName: string;
        resourceUri: string;
        noCache?: boolean;
      }
    ) => {
      try {
        if (params.noCache) {
          clearResourceCache({
            serverName: params.serverName,
            uri: params.resourceUri,
          });
        }
        const { html } = await readResource({
          serverName: params.serverName,
          uri: params.resourceUri,
        });
        return { success: true, html };
      } catch (error) {
        console.error(`[IPC] Failed to fetch resource HTML`, { uri: params.resourceUri, error });
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to fetch resource",
        };
      }
    }
  );

  /**
   * Read a resource from an MCP server.
   * Per MCP Apps spec (SEP-1865), Guest UIs can request resources via the Host.
   * Returns the resource contents in MCP SDK format.
   */
  ipcMain.handle(
    "cp:read-resource",
    async (
      _,
      params: {
        serverName: string;
        uri: string;
      }
    ) => {
      try {
        const { html } = await readResource({
          serverName: params.serverName,
          uri: params.uri,
        });
        return {
          contents: [
            {
              uri: params.uri,
              mimeType: "text/html",
              text: html,
            },
          ],
        };
      } catch (error) {
        console.error(`[IPC] Failed to read resource`, { uri: params.uri, error });
        throw error;
      }
    }
  );

};
