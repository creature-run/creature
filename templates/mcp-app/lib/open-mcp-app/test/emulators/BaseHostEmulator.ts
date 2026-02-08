import type {
  HostEmulator,
  HostIdentity,
  HostCapabilities,
  HostQuirks,
  HostMessage,
} from "./types.js";
import type { HostContext, ToolResult, DisplayMode } from "../../src/core/types.js";

export abstract class BaseHostEmulator implements HostEmulator {
  abstract readonly identity: HostIdentity;
  abstract readonly capabilities: HostCapabilities;
  abstract readonly quirks: HostQuirks;

  protected messages: HostMessage[] = [];
  protected messageListeners: Array<(msg: HostMessage) => void> = [];
  protected postMessageHandler: ((event: MessageEvent) => void) | null = null;

  async setup(): Promise<void> {
    this.messages = [];
  }

  async teardown(): Promise<void> {
    this.messages = [];
    this.messageListeners = [];
    if (this.postMessageHandler && typeof window !== "undefined") {
      window.removeEventListener("message", this.postMessageHandler);
      this.postMessageHandler = null;
    }
  }

  getHostContext(): HostContext {
    return {
      theme: "light",
      userAgent: this.identity.userAgent,
      platform: this.identity.formFactor === "desktop" ? "desktop" : "web",
      displayMode: "inline",
      availableDisplayModes: this.getAvailableDisplayModes(),
      styles: {
        variables: {
          "--color-primary": "#0066cc",
          "--color-background": "#ffffff",
          "--color-text": "#1a1a1a",
        },
      },
    };
  }

  protected getAvailableDisplayModes(): DisplayMode[] {
    const modes: DisplayMode[] = ["inline"];
    if (this.capabilities.pipMode) modes.push("pip");
    if (this.capabilities.fullscreenMode) modes.push("fullscreen");
    return modes;
  }

  abstract sendToolInput(toolName: string, args: Record<string, unknown>): void;
  abstract sendToolResult(result: ToolResult): void;
  abstract sendHostContextChange(context: Partial<HostContext>): void;
  abstract injectIntoWindow(window: Window): void;
  abstract createPostMessageTarget(): { postMessage: (data: unknown) => void };

  getReceivedMessages(): HostMessage[] {
    return [...this.messages];
  }

  async waitForMessage(type: string, timeout = 5000): Promise<HostMessage> {
    const existing = this.messages.find((m) => m.type === type);
    if (existing) return existing;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for message: ${type}`));
      }, timeout);

      const listener = (msg: HostMessage) => {
        if (msg.type === type) {
          clearTimeout(timer);
          const idx = this.messageListeners.indexOf(listener);
          if (idx >= 0) this.messageListeners.splice(idx, 1);
          resolve(msg);
        }
      };

      this.messageListeners.push(listener);
    });
  }

  clearMessages(): void {
    this.messages = [];
  }

  protected recordMessage(type: string, params: unknown): void {
    const msg: HostMessage = { type, params, timestamp: Date.now() };
    this.messages.push(msg);
    for (const listener of this.messageListeners) {
      listener(msg);
    }
  }
}
