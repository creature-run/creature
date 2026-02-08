/**
 * Pip IPC Handlers
 *
 * Handles Control Plane pip-related IPC events.
 * Includes rate limiting and deduplication for UI-initiated tool calls
 * to prevent infinite re-render loops from crashing the MCP server connection.
 */

import { ipcMain } from "electron";
import {
  closePipInstance,
  markPipReady,
  markTeardownComplete,
  refreshSinglePip,
  handleToolCall,
  updatePipTitle,
  updatePipWidgetState,
  restorePips,
  type WidgetState,
  type PersistedPipState,
} from "../mcp/controlPlane";
import { readResource, clearResourceCache } from "../mcp/client";

/**
 * Rate limiter for UI-initiated tool calls.
 *
 * Prevents runaway React re-render loops from flooding the MCP server
 * with thousands of identical calls per second. Provides three defenses:
 *
 * 1. Deduplication: identical in-flight calls (same tool + args) share one promise
 * 2. Sliding window rate limit: max calls per server per time window
 * 3. Concurrent cap: max simultaneous in-flight calls per server
 *
 * All limits are per-server to isolate apps from each other.
 */
const UI_TOOL_CALL_RATE_LIMIT = {
  windowMs: 1000,
  maxCallsPerWindow: 60,
  maxConcurrentPerServer: 20,
};

/** Tracks per-server call timestamps for the sliding window */
const serverCallTimestamps = new Map<string, number[]>();

/** Tracks per-server concurrent in-flight count */
const serverConcurrentCalls = new Map<string, number>();

/** Tracks in-flight calls for deduplication (key -> promise) */
const inFlightCalls = new Map<string, Promise<unknown>>();

/** Tracks whether a rate-limit warning has already been logged for a server */
const rateLimitWarned = new Set<string>();

/**
 * Generates a dedup key for a UI tool call.
 * Identical tool + args on the same server share one in-flight promise.
 */
const makeDedupKey = ({ serverName, toolName, args }: {
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
}): string => {
  return `${serverName}/${toolName}:${JSON.stringify(args)}`;
};

/**
 * Checks if a UI tool call should be rejected by the rate limiter.
 * Returns an error string if rejected, null if allowed.
 */
const checkRateLimit = ({ serverName }: { serverName: string }): string | null => {
  const now = Date.now();

  // Check concurrent limit
  const concurrent = serverConcurrentCalls.get(serverName) ?? 0;
  if (concurrent >= UI_TOOL_CALL_RATE_LIMIT.maxConcurrentPerServer) {
    return `Too many concurrent UI tool calls (${concurrent}/${UI_TOOL_CALL_RATE_LIMIT.maxConcurrentPerServer})`;
  }

  // Check sliding window
  let timestamps = serverCallTimestamps.get(serverName);
  if (!timestamps) {
    timestamps = [];
    serverCallTimestamps.set(serverName, timestamps);
  }

  // Prune old timestamps outside the window
  const windowStart = now - UI_TOOL_CALL_RATE_LIMIT.windowMs;
  while (timestamps.length > 0 && timestamps[0] < windowStart) {
    timestamps.shift();
  }

  if (timestamps.length >= UI_TOOL_CALL_RATE_LIMIT.maxCallsPerWindow) {
    return `UI tool call rate limit exceeded (${timestamps.length}/${UI_TOOL_CALL_RATE_LIMIT.maxCallsPerWindow} calls in ${UI_TOOL_CALL_RATE_LIMIT.windowMs}ms)`;
  }

  // Record this call
  timestamps.push(now);
  return null;
};

/**
 * Increments the concurrent call counter for a server.
 */
const trackConcurrentStart = ({ serverName }: { serverName: string }) => {
  serverConcurrentCalls.set(serverName, (serverConcurrentCalls.get(serverName) ?? 0) + 1);
};

/**
 * Decrements the concurrent call counter for a server.
 */
const trackConcurrentEnd = ({ serverName }: { serverName: string }) => {
  const current = serverConcurrentCalls.get(serverName) ?? 1;
  serverConcurrentCalls.set(serverName, Math.max(0, current - 1));
};

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
   * Restore pips from persisted chat session state.
   * Restores tabs as docked and returns the active tab fallback.
   */
  ipcMain.handle(
    "pip:restore",
    async (_, params: { pipState: PersistedPipState }) => {
      return await restorePips({ pipState: params.pipState });
    }
  );

  /**
   * Handle tool calls from UI pips (per MCP Apps spec).
   * UI pips can call tools on their MCP server via the Host.
   *
   * Routes through handleToolCall with source: 'ui' so the tool call
   * gets emitted as a ui-tool:executed event for conversation history injection.
   * This ensures the agent knows about user interactions with pips.
   *
   * Includes rate limiting, deduplication, and concurrent call capping to prevent
   * runaway React re-render loops from flooding the MCP server and crashing the connection.
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
        const dedupKey = makeDedupKey(params);

        // Deduplication: if this exact call is already in-flight, return the same promise.
        // This prevents identical concurrent calls from consuming server resources.
        const existing = inFlightCalls.get(dedupKey);
        if (existing) {
          return existing;
        }

        // Rate limit check: reject if the UI is calling too fast (likely a re-render loop)
        const rateLimitError = checkRateLimit({ serverName: params.serverName });
        if (rateLimitError) {
          if (!rateLimitWarned.has(params.serverName)) {
            rateLimitWarned.add(params.serverName);
            console.error(`[IPC] UI tool call rate-limited — likely a re-render loop in the MCP App UI`, {
              serverName: params.serverName,
              toolName: params.toolName,
              reason: rateLimitError,
            });
            // Clear the warning flag after the window resets so it can warn again if the loop resumes
            setTimeout(() => rateLimitWarned.delete(params.serverName), UI_TOOL_CALL_RATE_LIMIT.windowMs * 2);
          }
          return {
            content: [{ type: "text", text: `Rate limited: ${rateLimitError}. This usually indicates an infinite re-render loop in the UI code.` }],
            isError: true,
          };
        }

        // Track concurrent calls
        trackConcurrentStart({ serverName: params.serverName });

        // Create the actual call promise and register it for deduplication
        const callPromise = handleToolCall({
          serverName: params.serverName,
          toolName: params.toolName,
          args: params.args,
          instanceId: params.instanceId,
          source: "ui",
        }).finally(() => {
          // Clean up dedup entry and concurrent count when call completes
          inFlightCalls.delete(dedupKey);
          trackConcurrentEnd({ serverName: params.serverName });
        });

        inFlightCalls.set(dedupKey, callPromise);

        return await callPromise;
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
