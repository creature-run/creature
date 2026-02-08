export { useHost, detectEnvironment } from "./useHost.js";
export { useToolResult } from "./useToolResult.js";
export { useWebSocket } from "./useWebSocket.js";
export { useViews } from "./useViews.js";
export { CreatureIcon } from "./CreatureIcon.js";

// Host Provider for context-based hooks
export { HostProvider } from "./HostContext.js";
export type { HostProviderProps } from "./HostContext.js";

export type {
  DisplayMode,
  UseHostConfig,
  UseHostReturn,
  Logger,
  UseToolResultReturn,
  UseWebSocketConfig,
  UseWebSocketReturn,
  CreatureIconProps,
  LogLevel,
  ToolResult,
  Environment,
  HostContext,
  WidgetState,
  StructuredWidgetState,
  WebSocketStatus,
  ExpHostApi,
  // Tool calling types
  ToolCallStatus,
  ToolCallState,
  ToolCallFunction,
  ToolCallTuple,
} from "./types.js";

// Views types
export type { Views, UseViewsReturn } from "./useViews.js";

// Core exports
export {
  createHost,
  createHostAsync,
  // Host clients (for advanced usage)
  CreatureDesktopHostClient,
  ClaudeDesktopHostClient,
  ChatGptWebHostClient,
  StandaloneHostClient,
  // Style utilities
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
  getDocumentTheme,
  createWebSocket,
} from "../core/index.js";

export type {
  // Unified types
  UnifiedHostClient,
  HostClientEvents,
  // Configuration types
  HostClientConfig,
  HostClientState,
  WebSocketClient,
  WebSocketClientConfig,
  ContentBlock,
  TextContentBlock,
  ImageContentBlock,
} from "../core/index.js";
