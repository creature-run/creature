import type { HostContext, ToolResult, WidgetState, DisplayMode } from "../../src/core/types.js";

// ============================================================================
// Host Identity
// ============================================================================

export type Vendor = "creature" | "claude" | "chatgpt";
export type FormFactor = "desktop" | "web";

export interface HostIdentity {
  vendor: Vendor;
  formFactor: FormFactor;
  userAgent: string;
}

// ============================================================================
// Host Capabilities
// ============================================================================

export interface HostCapabilities {
  multiInstance: boolean;
  viewsRouting: boolean;
  pipMode: boolean;
  fullscreenMode: boolean;
  webSocket: boolean;
  widgetState: boolean;
  modelContext: boolean;
  fileSystemAccess: boolean;
}

// ============================================================================
// Host Quirks
// ============================================================================

export interface HostQuirks {
  toolResultDelay?: number;
  sendsToolInputBeforeReady?: boolean;
  widgetStateNullable?: boolean;
  ignoresDisplayModeRequest?: boolean;
  usesWindowOpenai?: boolean;
}

// ============================================================================
// Messages
// ============================================================================

export interface HostMessage {
  type: string;
  params: unknown;
  timestamp: number;
}

// ============================================================================
// Host Emulator Interface
// ============================================================================

export interface HostEmulator {
  readonly identity: HostIdentity;
  readonly capabilities: HostCapabilities;
  readonly quirks: HostQuirks;

  setup(): Promise<void>;
  teardown(): Promise<void>;

  getHostContext(): HostContext;
  sendToolInput(toolName: string, args: Record<string, unknown>): void;
  sendToolResult(result: ToolResult): void;
  sendHostContextChange(context: Partial<HostContext>): void;

  getReceivedMessages(): HostMessage[];
  waitForMessage(type: string, timeout?: number): Promise<HostMessage>;
  clearMessages(): void;

  injectIntoWindow(window: Window): void;
  createPostMessageTarget(): { postMessage: (data: unknown) => void };
}
