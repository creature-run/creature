import { BaseHostEmulator } from "./BaseHostEmulator.js";
import type { HostIdentity, HostCapabilities, HostQuirks } from "./types.js";
import type { HostContext, ToolResult, WidgetState } from "../../src/core/types.js";

/**
 * ChatGPT Web Emulator
 *
 * Emulates the ChatGPT web host which uses window.openai instead of postMessage.
 * Based on the actual ChatGPT Apps SDK types from chatgpt-apps-sdk-examples.
 */
export class ChatGptWebEmulator extends BaseHostEmulator {
  readonly identity: HostIdentity = {
    vendor: "chatgpt",
    formFactor: "web",
    userAgent: "ChatGPT/2.0.0",
  };

  readonly capabilities: HostCapabilities = {
    multiInstance: false,
    viewsRouting: false,
    pipMode: true,  // ChatGPT supports pip (coerced to fullscreen on mobile)
    fullscreenMode: true,
    webSocket: false,
    widgetState: true,
    modelContext: false,
    fileSystemAccess: false,
  };

  readonly quirks: HostQuirks = {
    usesWindowOpenai: true,
    widgetStateNullable: false,  // ChatGPT requires {} not null
  };

  private injectedWindow: Window | null = null;

  // ChatGPT state properties
  private _theme: "light" | "dark" = "light";
  private _locale = "en-US";
  private _maxHeight = 600;
  private _displayMode: "inline" | "pip" | "fullscreen" = "inline";
  private _safeArea = { insets: { top: 0, bottom: 0, left: 0, right: 0 } };
  private _userAgent = {
    device: { type: "desktop" as const },
    capabilities: { hover: true, touch: false },
  };
  private _toolInput: Record<string, unknown> = {};
  private _toolOutput: Record<string, unknown> | null = null;
  private _toolResponseMetadata: Record<string, unknown> | null = null;
  private _widgetState: WidgetState = {};

  override getHostContext(): HostContext {
    return {
      theme: this._theme,
      userAgent: this.identity.userAgent,
      platform: "web",
      displayMode: this._displayMode,
      availableDisplayModes: ["inline", "pip", "fullscreen"],
    };
  }

  sendToolInput(toolName: string, args: Record<string, unknown>): void {
    this._toolInput = args;
    this._toolOutput = args;  // ChatGPT uses toolOutput for the initial data
    this.emitGlobalsChange({ toolInput: args, toolOutput: args });
    this.recordMessage("tool-input", { toolName, arguments: args });
  }

  sendToolResult(result: ToolResult): void {
    const output = result.structuredContent ?? {};
    this._toolOutput = output;
    this.emitGlobalsChange({ toolOutput: output });
    this.recordMessage("tool-result", result);
  }

  sendHostContextChange(context: Partial<HostContext>): void {
    // ChatGPT can update theme and displayMode via set_globals
    if (context.theme) {
      this._theme = context.theme;
      this.emitGlobalsChange({ theme: context.theme });
    }
    if (context.displayMode) {
      this._displayMode = context.displayMode;
      this.emitGlobalsChange({ displayMode: context.displayMode });
    }
  }

  injectIntoWindow(window: Window): void {
    this.injectedWindow = window;
    (window as any).openai = this.createOpenAIBridge();
  }

  createPostMessageTarget(): { postMessage: (data: unknown) => void } {
    return {
      postMessage: (_data: unknown) => {
        // ChatGPT doesn't use postMessage - it uses window.openai
      },
    };
  }

  private createOpenAIBridge() {
    const emulator = this;
    return {
      // ========================================
      // Properties (readable state)
      // ========================================
      get theme() {
        return emulator._theme;
      },

      get userAgent() {
        return emulator._userAgent;
      },

      get locale() {
        return emulator._locale;
      },

      get maxHeight() {
        return emulator._maxHeight;
      },

      get displayMode() {
        return emulator._displayMode;
      },

      get safeArea() {
        return emulator._safeArea;
      },

      get toolInput() {
        return emulator._toolInput;
      },

      get toolOutput() {
        return emulator._toolOutput;
      },

      get toolResponseMetadata() {
        return emulator._toolResponseMetadata;
      },

      get widgetState() {
        return emulator._widgetState;
      },

      // ========================================
      // Methods (APIs)
      // ========================================

      setWidgetState: async (state: WidgetState) => {
        emulator._widgetState = state ?? {};
        emulator.recordMessage("widget-state-changed", { widgetState: state });
      },

      callTool: async (name: string, args: Record<string, unknown>) => {
        emulator.recordMessage("call-server-tool", { name, arguments: args });
        // ChatGPT callTool returns { result: string }
        return { result: JSON.stringify({ success: true }) };
      },

      requestDisplayMode: async (params: { mode: string }) => {
        emulator.recordMessage("request-display-mode", params);
        // ChatGPT may coerce pip to fullscreen on mobile
        const grantedMode = params.mode as "inline" | "pip" | "fullscreen";
        emulator._displayMode = grantedMode;
        return { mode: grantedMode };
      },

      sendFollowUpMessage: async (params: { prompt: string }) => {
        emulator.recordMessage("send-follow-up", params);
      },

      openExternal: (params: { href: string }) => {
        emulator.recordMessage("open-external", params);
      },

      requestModal: async (options: { title?: string; params?: Record<string, unknown> }) => {
        emulator.recordMessage("request-modal", options);
        return null;
      },

      requestClose: async () => {
        emulator.recordMessage("request-close", {});
      },
    };
  }

  private emitGlobalsChange(globals: Partial<{
    theme: "light" | "dark";
    displayMode: string;
    toolInput: unknown;
    toolOutput: unknown;
    widgetState: unknown;
  }>): void {
    if (!this.injectedWindow) return;

    const event = new CustomEvent("openai:set_globals", {
      detail: { globals },
    });
    this.injectedWindow.dispatchEvent(event);
  }

  // Test helpers for setting emulator state
  setTheme(theme: "light" | "dark"): void {
    this._theme = theme;
    this.emitGlobalsChange({ theme });
  }

  setDisplayMode(mode: "inline" | "pip" | "fullscreen"): void {
    this._displayMode = mode;
    this.emitGlobalsChange({ displayMode: mode });
  }

  setMaxHeight(height: number): void {
    this._maxHeight = height;
  }

  setWidgetState(state: WidgetState): void {
    this._widgetState = state;
    this.emitGlobalsChange({ widgetState: state });
  }

  setUserAgent(userAgent: { device: { type: string }; capabilities: { hover: boolean; touch: boolean } }): void {
    this._userAgent = userAgent as any;
  }
}
