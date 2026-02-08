/**
 * Creature App Bridge
 *
 * Wrapper around the MCP Apps SDK AppBridge for use in Creature's renderer process.
 * Handles communication between the Host (Creature) and Guest UIs (MCP Apps) in iframes.
 *
 * Architecture:
 * - Main Process: Control Plane manages panels, routes tool calls via MCP SDK Client
 * - Renderer Process: CreatureAppBridge manages postMessage communication with iframes
 * - IPC Bridge: Renderer forwards requests to main process for MCP server interaction
 *
 * This class:
 * 1. Instantiates AppBridge with null client (real MCP client is in main process)
 * 2. Registers handlers that route through Electron IPC
 * 3. Provides convenience methods for Creature-specific functionality
 *
 * Widget State:
 * - Guest UIs can persist state via ui/notifications/widget-state-changed
 * - State is stored in the in-memory WidgetStateStore
 * - State is restored via hostContext.widgetState on subsequent renders
 * - modelContent is extracted and injected into AI context
 */

// Note: AppBridge is exported from /app-bridge subpath which requires bundler moduleResolution.
// Vite handles this correctly at runtime. TypeScript checking may fail with "node" moduleResolution.
// @ts-ignore - Subpath export works at runtime with Vite bundler
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  McpUiHostCapabilities,
  McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";
import { buildHostContext, type BuildHostContextParams } from "./hostContext";
import { widgetStateStore, type WidgetState } from "./widgetStateStore";
import { z } from "zod";

/**
 * Schema for widget-state-changed notification.
 * Follows ChatGPT Apps format for cross-platform compatibility.
 *
 * The SDK sends this notification when Guest UI calls setWidgetState().
 * Host stores the state and can restore it via hostContext.widgetState.
 */
const WidgetStateChangedNotificationSchema = z.object({
  method: z.literal("ui/notifications/widget-state-changed"),
  params: z.object({
    widgetState: z.object({
      modelContent: z.union([z.string(), z.record(z.string(), z.unknown()), z.null()]).optional(),
      privateContent: z.record(z.string(), z.unknown()).nullable().optional(),
      imageIds: z.array(z.string()).optional(),
    }).nullable(),
  }),
});

type WidgetStateChangedNotification = z.infer<typeof WidgetStateChangedNotificationSchema>;

/**
 * Schema for hmr-reload notification.
 * Sent by HMR client in development mode to trigger pip content refresh.
 */
const HmrReloadNotificationSchema = z.object({
  method: z.literal("ui/notifications/hmr-reload"),
  params: z.object({}).optional(),
});

/**
 * Schema for title-changed notification.
 * Sent by SDK when Guest UI calls setTitle().
 * Allows apps to update their pip title without making a tool call.
 */
const TitleChangedNotificationSchema = z.object({
  method: z.literal("ui/notifications/title-changed"),
  params: z.object({
    title: z.string(),
  }),
});

type TitleChangedNotification = z.infer<typeof TitleChangedNotificationSchema>;

/**
 * Schema for ui/update-model-context request (MCP Apps spec).
 * Allows Guest UI to update the model context that will be included in future agent turns.
 */
const UpdateModelContextRequestSchema = z.object({
  method: z.literal("ui/update-model-context"),
  params: z.object({
    content: z.array(z.object({
      type: z.string(),
      text: z.string().optional(),
    })).optional(),
    structuredContent: z.record(z.string(), z.unknown()).optional(),
  }),
});

type UpdateModelContextRequest = z.infer<typeof UpdateModelContextRequestSchema>;

/**
 * Host information for Creature.
 */
const CREATURE_HOST_INFO: Implementation = {
  name: "Creature",
  version: "1.0.0",
};

/**
 * Default capabilities that Creature supports.
 * Note: updateModelContext is cast to satisfy the type since it may not be in the
 * published SDK types yet, but we implement the handler per MCP Apps spec.
 */
const CREATURE_HOST_CAPABILITIES = {
  openLinks: {},
  serverTools: {
    listChanged: false,
  },
  serverResources: {
    listChanged: false,
  },
  logging: {},
  updateModelContext: {
    text: {},
  },
} as McpUiHostCapabilities;

/**
 * Configuration for creating a CreatureAppBridge instance.
 */
export interface CreatureAppBridgeConfig {
  /**
   * The iframe element containing the Guest UI.
   * Used to create the PostMessageTransport.
   */
  iframe: HTMLIFrameElement;

  /**
   * Instance ID for routing IPC calls.
   * Also used as the key for PIP widget state.
   */
  instanceId: string;

  /**
   * MCP server name for tool calls.
   */
  serverName: string;

  /**
   * Resource URI for the pip (used for widget state metadata).
   */
  resourceUri?: string;

  /**
   * Parameters for building the initial hostContext.
   */
  hostContextParams: BuildHostContextParams;

  /**
   * Current conversation ID for widget state storage.
   * Required for widget state persistence.
   */
  conversationId?: string;

  /**
   * Message ID that this widget belongs to.
   * Used for inline widgets to key state by message.
   * For PIP mode, instanceId is used instead.
   */
  messageId?: string;

  /**
   * Callback when the Guest UI completes initialization.
   */
  onInitialized?: () => void;

  /**
   * Callback when the Guest UI reports size changes.
   */
  onSizeChange?: (params: { width?: number; height?: number }) => void;

  /**
   * Callback when the Guest UI sends a log message.
   */
  onLog?: (params: { level: string; data: unknown; logger?: string }) => void;

  /**
   * Callback when the Guest UI changes widget state.
   * Called after state is stored in widgetStateStore.
   */
  onWidgetStateChange?: (state: WidgetState | null) => void;
}

/**
 * Creates and configures an AppBridge instance for use in Creature's renderer.
 *
 * This function:
 * 1. Creates the PostMessageTransport for iframe communication
 * 2. Instantiates AppBridge with Creature's host info and capabilities
 * 3. Registers handlers that route through Electron IPC
 * 4. Connects to the Guest UI
 * 5. Sets up widget state persistence via in-memory store
 *
 * @returns The configured AppBridge instance and a cleanup function
 */
export const createCreatureAppBridge = async ({
  iframe,
  instanceId,
  serverName,
  resourceUri,
  hostContextParams,
  conversationId,
  messageId,
  onInitialized,
  onSizeChange,
  onLog,
  onWidgetStateChange,
}: CreatureAppBridgeConfig): Promise<{
  bridge: AppBridge;
  cleanup: () => Promise<void>;
}> => {
  // Wait for iframe to have a contentWindow
  if (!iframe.contentWindow) {
    throw new Error("Iframe contentWindow not available");
  }

  // Build the initial hostContext using our builder
  // Include userAgent for spec-compliant host identification (replaces window.__CREATURE__ marker)
  const hostContext = buildHostContext({
    ...hostContextParams,
    userAgent: `${CREATURE_HOST_INFO.name.toLowerCase()}/${CREATURE_HOST_INFO.version}`,
  });

  // Create transport for postMessage communication
  const transport = new PostMessageTransport(
    iframe.contentWindow,
    iframe.contentWindow
  );

  // DEBUG: Add raw message listener to trace all incoming postMessages from this iframe.
  // This helps debug notification flow issues where SDK's setNotificationHandler 
  // might silently fail validation.
  const debugMessageHandler = (event: MessageEvent) => {
    // Only log messages from our iframe
    if (event.source !== iframe.contentWindow) return;
    const data = event.data;
    if (data && typeof data === "object" && data.method) {
      console.log(`[AppBridge:${instanceId}] Raw postMessage received`, { 
        method: data.method, 
        params: data.params,
        hasJsonrpc: !!data.jsonrpc,
      });
    }
  };
  window.addEventListener("message", debugMessageHandler);

  // Create AppBridge with null client (MCP client is in main process)
  // We'll register handlers that route through IPC
  const bridge = new AppBridge(
    null,
    CREATURE_HOST_INFO,
    CREATURE_HOST_CAPABILITIES,
    { hostContext }
  );

  console.log(`[AppBridge] Creating bridge`, { instanceId, hostContext });

  // Register handler for tool calls - routes through IPC to main process
  // Note: extra parameter required by SDK but unused here
  bridge.oncalltool = async (params: { name: string; arguments?: Record<string, unknown> }, _extra: unknown) => {
    const result = await window.electronAPI.controlPlane.callTool({
      serverName,
      toolName: params.name,
      args: params.arguments || {},
      instanceId,
    });
    return result as { content?: Array<{ type: string; text: string }>; isError?: boolean };
  };

  // Register handler for resource reads - routes through IPC
  bridge.onreadresource = async (params: { uri: string }, _extra: unknown) => {
    console.debug(`[AppBridge] Resource read from Guest`, { uri: params.uri });
    const result = await window.electronAPI.controlPlane.readResource({
      serverName,
      uri: params.uri,
    });
    return result;
  };

  // Register handler for opening external links
  bridge.onopenlink = async (params: { url: string }, _extra: unknown) => {
    try {
      await window.electronAPI.shell.openExternal(params.url);
      return {};
    } catch (error) {
      console.error("[AppBridge] Failed to open link:", error);
      return { isError: true };
    }
  };

  // Register handler for messages to chat
  // Note: sendMessage is not yet implemented in Creature
  bridge.onmessage = async (_params: { role: string; content: unknown }, _extra: unknown) => {
    console.warn("[AppBridge] sendMessage is not yet implemented");
    return { isError: true };
  };

  // Register handler for display mode change requests
  bridge.onrequestdisplaymode = async (params: { mode: string }, _extra: unknown) => {
    // For now, Creature only supports pip mode for panels
    // Return the current mode (pip) regardless of request
    const currentMode = hostContextParams.displayMode;
    return { mode: currentMode };
  };

  /**
   * Register handler for model context updates (MCP Apps spec: ui/update-model-context).
   * 
   * This maps the MCP Apps spec method to widgetState.modelContent, providing:
   * - Unified API: Developers can use either setWidgetState() or updateModelContext()
   * - Persistence: Content survives pip refresh/popout via existing widgetState mechanism
   * - Agent visibility: modelContent is included in system prompt via getActivePipsForPrompt()
   * 
   * Per spec, each call overwrites the previous context (snapshot semantics).
   * 
   * Note: Using setRequestHandler directly since the published SDK may not have
   * the onupdatemodelcontext setter yet. Using 'any' cast to avoid TypeScript's
   * "type instantiation is excessively deep" error with Zod's recursive types.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bridge.setRequestHandler as any)(
    UpdateModelContextRequestSchema,
    async (request: UpdateModelContextRequest) => {
      const { content, structuredContent } = request.params;

      // Convert content blocks to string for modelContent
      // Only text blocks are supported for now (per our capability declaration)
      const textContent = content
        ?.filter((block): block is { type: string; text: string } => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");

      // Use text content if available, otherwise stringify structuredContent
      const modelContent = textContent || 
        (structuredContent ? JSON.stringify(structuredContent) : null);

      console.debug(`[AppBridge] Model context update`, { instanceId, modelContent });

      // Store in the widget state store if we have conversation context
      if (conversationId) {
        const widgetId = messageId
          ? `${conversationId}:${messageId}`
          : `${conversationId}:pip:${instanceId}`;

        // Get existing widget state to preserve privateContent
        const existingState = widgetStateStore.get(widgetId);
        const newWidgetState: WidgetState = {
          ...existingState,
          modelContent,
        };

        widgetStateStore.set(widgetId, newWidgetState, {
          mcpServerName: serverName,
          resourceUri: resourceUri || "",
          instanceId,
          messageId,
          conversationId,
        });
      }

      // Update Control Plane pip state for PIP mode
      if (!messageId && instanceId) {
        // Get existing state from control plane to preserve privateContent
        const existingPipState = hostContextParams.widgetState;
        const newWidgetState: WidgetState = {
          ...existingPipState,
          modelContent,
        };

        await window.electronAPI.controlPlane.updateWidgetState({
          instanceId,
          widgetState: newWidgetState,
        });
      }

      // Notify callback if provided
      onWidgetStateChange?.({ modelContent } as WidgetState);

      return {};
    }
  );

  // Register callback for size changes
  if (onSizeChange) {
    bridge.onsizechange = onSizeChange;
  }

  // Register callback for logging - forwards Guest logs to DevConsole
  if (onLog) {
    bridge.onloggingmessage = (params: { level: string; data: unknown; logger?: string }) => {
      onLog({
        level: params.level,
        data: params.data,
        logger: params.logger,
      });
    };
  }

  // Register callback for initialization complete.
  // Per MCP Apps spec, Guest sends ui/notifications/initialized after receiving
  // ui/initialize response. This signals the Guest is ready to receive notifications.
  if (onInitialized) {
    bridge.oninitialized = (_params: unknown) => {
      console.debug(`[AppBridge] Guest initialized`, { instanceId });
      onInitialized();
    };
  }

  // Register handler for widget state changes.
  // This stores state in two places:
  // 1. In-memory widgetStateStore (renderer) for state restoration on re-render
  // 2. Control Plane pip state (main process) for AI context injection
  //
  // Note: Using 'any' cast to avoid TypeScript's "type instantiation is excessively deep"
  // error with Zod's recursive type inference.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bridge.setNotificationHandler as any)(
    WidgetStateChangedNotificationSchema,
    async (notification: WidgetStateChangedNotification) => {
      const { widgetState } = notification.params;
      console.log(`[AppBridge] Widget state changed`, { instanceId, widgetState });

      // Store in the widget state store if we have conversation context
      if (conversationId) {
        // Determine widget ID based on whether this is inline (has messageId) or PIP
        const widgetId = messageId
          ? `${conversationId}:${messageId}`
          : `${conversationId}:pip:${instanceId}`;

        if (widgetState) {
          widgetStateStore.set(widgetId, widgetState as WidgetState, {
            mcpServerName: serverName,
            resourceUri: resourceUri || "",
            instanceId,
            messageId,
            conversationId,
          });
        } else {
          // Null state = clear the entry
          widgetStateStore.delete(widgetId);
        }
      }

      // Update Control Plane pip state for PIP mode.
      // This makes modelContent available in the AI system prompt.
      // For inline widgets (which have messageId), state is already per-message
      // and doesn't need to be in the pip state.
      if (!messageId && instanceId) {
        await window.electronAPI.controlPlane.updateWidgetState({
          instanceId,
          widgetState: widgetState as WidgetState | null,
        });
      }

      // Notify callback if provided
      onWidgetStateChange?.(widgetState as WidgetState | null);
    }
  );

  // Register handler for HMR reload notifications.
  // In development mode, the HMR client sends this when Vite detects file changes.
  // This triggers a pip refresh to load the updated HTML content.
  // 
  // Debouncing: We wait 300ms after the last HMR notification before refreshing.
  // This prevents race conditions when multiple files change rapidly - Vite may
  // still be rebuilding when the first notification arrives, resulting in
  // incomplete HTML being fetched (the "UI not found" flash).
  let hmrDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const HMR_DEBOUNCE_MS = 300;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bridge.setNotificationHandler as any)(
    HmrReloadNotificationSchema,
    async () => {
      // Clear any pending refresh
      if (hmrDebounceTimer) {
        clearTimeout(hmrDebounceTimer);
      }

      // Schedule refresh after debounce period
      hmrDebounceTimer = setTimeout(async () => {
        console.log(`[AppBridge:${instanceId}] HMR reload — requesting pip refresh`);
        
        // Trigger pip refresh via control plane
        // This clears the resource cache and re-fetches fresh HTML
        try {
          await window.electronAPI.controlPlane.refreshSinglePip({ instanceId });
          console.debug(`[AppBridge:${instanceId}] HMR refresh request completed`);
        } catch (error) {
          console.error(`[AppBridge:${instanceId}] HMR refresh failed`, error);
        }
      }, HMR_DEBOUNCE_MS);
    }
  );

  /**
   * Register handler for title change notifications.
   * Sent by SDK when Guest UI calls setTitle().
   * Routes to control plane to update pip title in host UI.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bridge.setNotificationHandler as any)(
    TitleChangedNotificationSchema,
    async (notification: TitleChangedNotification) => {
      const { title } = notification.params;
      console.debug(`[AppBridge] Title changed`, { instanceId, title });

      // Update pip title via control plane IPC
      if (instanceId && window.electronAPI?.controlPlane?.updatePipTitle) {
        try {
          await window.electronAPI.controlPlane.updatePipTitle({ instanceId, title });
        } catch (error) {
          console.error(`[AppBridge] Failed to update pip title`, { instanceId, error });
        }
      }
    }
  );

  // Establish transport connection. This starts listening for messages from the Guest.
  // Note: This does NOT block waiting for ui/initialize - it just establishes the transport.
  // The actual handshake (ui/initialize → response → ui/notifications/initialized) happens
  // asynchronously via the request/notification handlers set up above.
  await bridge.connect(transport);
  console.debug(`[AppBridge:${instanceId}] Transport connected, waiting for Guest initialization`);

  // Track cleanup state to make cleanup idempotent and avoid double-teardown errors
  let cleanedUp = false;

  /**
   * Maximum time to wait for the Guest to respond to teardownResource.
   *
   * Teardown is a courtesy notification — if the Guest doesn't respond
   * promptly (e.g. iframe is unloading during HMR, MCP server restarted),
   * we close the bridge anyway. A short timeout prevents blocking pip
   * refresh cycles. Without this, the SDK's default request timeout
   * (often 30s+) blocks cleanup, which in the popout path is awaited
   * and delays the entire refresh-and-reinitialize sequence.
   */
  const TEARDOWN_TIMEOUT_MS = 1500;

  /**
   * Cleanup function - idempotent, safe to call multiple times.
   * Sends teardown request to Guest with a short timeout, then closes the bridge.
   * Silently handles "Not connected" and timeout errors which occur during
   * normal HMR refresh and rapid close sequences.
   */
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;

    console.debug(`[AppBridge:${instanceId}] Cleanup starting`);

    // Remove debug message handler
    window.removeEventListener("message", debugMessageHandler);

    // Clear any pending HMR refresh timer
    if (hmrDebounceTimer) {
      clearTimeout(hmrDebounceTimer);
      hmrDebounceTimer = null;
    }

    try {
      // Race teardown against a short timeout. Teardown is a courtesy
      // notification to the Guest — if it doesn't respond quickly
      // (iframe unloading, server restarted), we proceed with close.
      const teardownResult = await Promise.race([
        bridge.teardownResource({}).then(() => "done" as const),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), TEARDOWN_TIMEOUT_MS)
        ),
      ]);

      if (teardownResult === "timeout") {
        console.debug(`[AppBridge:${instanceId}] Teardown timed out after ${TEARDOWN_TIMEOUT_MS}ms, proceeding with close`);
      }
    } catch (error) {
      // Silently ignore "Not connected" errors — these occur when Host closes
      // pip before cleanup runs, which is normal during rapid close sequences.
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!errorMessage.includes("Not connected")) {
        console.debug(`[AppBridge:${instanceId}] Teardown error (non-fatal): ${errorMessage}`);
      }
    } finally {
      try {
        await bridge.close();
      } catch (closeError) {
        console.debug(`[AppBridge:${instanceId}] Close error (non-fatal):`, closeError);
      }
      console.debug(`[AppBridge:${instanceId}] Cleanup complete`);
    }
  };

  return { bridge, cleanup };
};

/**
 * Type for the return value of createCreatureAppBridge.
 * Used for storing bridge instances in component state.
 */
export type CreatureAppBridgeInstance = Awaited<
  ReturnType<typeof createCreatureAppBridge>
>;

